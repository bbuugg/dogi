import { EventEmitter } from 'node:events'
import * as os from 'node:os'
import * as pty from '@lydell/node-pty'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import type { SessionInfo, SessionType, SshProfile } from '@shared/types'

/** 每个会话保留的输出缓冲上限，供 AI 读取 */
const MAX_OUTPUT_BUFFER = 256 * 1024

/**
 * 统一终端类型：必须是 256 色终端，否则远程 ncurses 程序（htop/btop/lazygit 等）
 * 会按 8 色甚至无色渲染，表现为黑白。
 */
const TERM_TYPE = 'xterm-256color'

interface InternalSession {
  info: SessionInfo
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  /** 读取最近输出（AI 工具用） */
  recentOutput(maxChars: number): string
}

function pickLocalShell(): string {
  if (process.platform === 'win32') {
    return process.env.PWSH_PATH || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

function stripUndefined(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

/** 本地 PTY 会话 */
class LocalSession implements InternalSession {
  info: SessionInfo
  private proc: pty.IPty
  private output = ''

  constructor(
    id: string,
    cols: number,
    rows: number,
    handlers: { onData: (data: string) => void; onExit: (code: number) => void }
  ) {
    const shell = pickLocalShell()
    this.proc = pty.spawn(shell, [], {
      name: TERM_TYPE,
      cols,
      rows,
      cwd: os.homedir(),
      env: { ...stripUndefined(process.env), TERM: TERM_TYPE, COLORTERM: 'truecolor' }
    })
    this.info = {
      id,
      type: 'local',
      title: `${shell}`,
      pid: this.proc.pid,
      createdAt: Date.now(),
      exited: false
    }
    this.proc.onData((data) => {
      this.appendOutput(data)
      handlers.onData(data)
    })
    this.proc.onExit(({ exitCode }) => {
      this.info.exited = true
      handlers.onExit(exitCode)
    })
  }

  private appendOutput(data: string): void {
    this.output += data
    if (this.output.length > MAX_OUTPUT_BUFFER) {
      this.output = this.output.slice(-MAX_OUTPUT_BUFFER)
    }
  }

  write(data: string): void {
    this.proc.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.proc.resize(Math.max(2, cols), Math.max(2, rows))
    } catch {
      // 进程可能已退出
    }
  }

  kill(): void {
    try {
      this.proc.kill()
    } catch {
      // 忽略
    }
  }

  recentOutput(maxChars: number): string {
    return this.output.slice(-maxChars)
  }
}

/** SSH 远程会话 */
class SshSession implements InternalSession {
  info: SessionInfo
  private conn = new Client()
  private stream: ClientChannel | null = null
  private output = ''
  private killed = false
  private onData: (data: string) => void
  private onExit: (exitCode: number) => void

  constructor(
    id: string,
    profile: SshProfile,
    cols: number,
    rows: number,
    handlers: { onData: (data: string) => void; onExit: (code: number) => void }
  ) {
    this.info = {
      id,
      type: 'ssh',
      title: `${profile.username}@${profile.host}`,
      profileId: profile.id,
      createdAt: Date.now(),
      exited: false
    }
    this.onData = handlers.onData
    this.onExit = handlers.onExit
    this.connect(profile, cols, rows)
  }

  private fail(message: string): void {
    const line = `\r\n\x1b[31m[SSH 连接失败] ${message}\x1b[0m\r\n`
    this.appendOutput(line)
    this.onData(line)
    this.info.exited = true
    this.onExit(1)
  }

  private connect(profile: SshProfile, cols: number, rows: number): void {
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port || 22,
      username: profile.username,
      keepaliveInterval: profile.keepaliveInterval || 15000,
      readyTimeout: 20000
    }
    if (profile.authType === 'privateKey' && profile.privateKey) {
      config.privateKey = profile.privateKey
      const passphrase = profile.passphrase
      if (passphrase) config.passphrase = passphrase
    } else if (profile.password) {
      config.password = profile.password
    }

    this.conn
      .on('ready', () => {
        if (this.killed) return
        this.conn.shell(
          { term: TERM_TYPE, cols: Math.max(2, cols), rows: Math.max(2, rows) },
          (err, stream) => {
            if (err || !stream) {
              this.fail(err?.message || '无法打开 shell')
              return
            }
            this.stream = stream
            stream.on('data', (data: Buffer | string) => {
              const text = data.toString()
              this.appendOutput(text)
              this.onData(text)
            })
            stream.on('close', () => {
              this.info.exited = true
              this.onExit(0)
            })
            stream.stderr?.on('data', (data: Buffer | string) => {
              const text = data.toString()
              this.appendOutput(text)
              this.onData(text)
            })
          }
        )
      })
      .on('error', (err: Error) => {
        if (!this.stream) this.fail(err.message)
      })
      .connect(config)
  }

  private appendOutput(data: string): void {
    this.output += data
    if (this.output.length > MAX_OUTPUT_BUFFER) {
      this.output = this.output.slice(-MAX_OUTPUT_BUFFER)
    }
  }

  write(data: string): void {
    if (this.stream) this.stream.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.stream?.setWindow(Math.max(2, rows), Math.max(2, cols), 0, 0)
    } catch {
      // 忽略
    }
  }

  kill(): void {
    this.killed = true
    try {
      this.stream?.close()
    } catch {
      // 忽略
    }
    this.conn.end()
    if (!this.info.exited) {
      this.info.exited = true
      this.onExit(0)
    }
  }

  recentOutput(maxChars: number): string {
    return this.output.slice(-maxChars)
  }
}

/**
 * 统一终端会话管理器：
 * 创建 / 写入 / 调整尺寸 / 关闭 / 输出转发（IPC 与 AI 共用同一份数据流）
 */
class SessionManager extends EventEmitter {
  private sessions = new Map<string, InternalSession>()
  private lastActiveId: string | null = null

  constructor() {
    super()
    this.setMaxListeners(0)
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }

  get(id: string): InternalSession | undefined {
    return this.sessions.get(id)
  }

  getActiveId(): string | null {
    return this.lastActiveId
  }

  createLocal(cols = 80, rows = 24): SessionInfo {
    const id = crypto.randomUUID()
    const session = new LocalSession(id, cols, rows, {
      onData: (data) => this.handleData(id, data),
      onExit: (code) => this.handleExit(id, code)
    })
    this.attach(id, session)
    return { ...session.info }
  }

  createSsh(profile: SshProfile, cols = 80, rows = 24): SessionInfo {
    const id = crypto.randomUUID()
    const session = new SshSession(id, profile, cols, rows, {
      onData: (data) => this.handleData(id, data),
      onExit: (code) => this.handleExit(id, code)
    })
    this.attach(id, session)
    return { ...session.info }
  }

  private attach(id: string, session: InternalSession): void {
    this.sessions.set(id, session)
    this.lastActiveId = id
    this.emit('created', { ...session.info })
  }

  private handleData(id: string, data: string): void {
    this.emit('data', { sessionId: id, data })
  }

  private handleExit(id: string, exitCode: number): void {
    this.emit('exit', { sessionId: id, exitCode })
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    this.lastActiveId = id
    session.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows)
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.kill()
    this.sessions.delete(id)
    if (this.lastActiveId === id) {
      this.lastActiveId = this.sessions.keys().next().value ?? null
    }
    this.emit('closed', { sessionId: id })
  }

  recentOutput(id: string, maxChars = 8000): string | null {
    return this.sessions.get(id)?.recentOutput(maxChars) ?? null
  }
}

export const sessionManager = new SessionManager()
export type { SessionType }
