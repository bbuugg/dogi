import { EventEmitter } from 'node:events'
import { exec as cpExec } from 'node:child_process'
import * as os from 'node:os'
import * as pty from 'node-pty'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import type { SessionInfo, SessionType, SshProfile } from '@shared/types'
import { resolveLocalShell } from './shells'

/** 每个会话保留的输出缓冲上限，供 AI 读取 */
const MAX_OUTPUT_BUFFER = 256 * 1024

/**
 * 统一终端类型：必须是 256 色终端，否则远程 ncurses 程序（htop/btop/lazygit 等）
 * 会按 8 色甚至无色渲染，表现为黑白。
 */
const TERM_TYPE = 'xterm-256color'

interface InternalSession {
  info: SessionInfo
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
  /** 读取最近输出（AI 工具用） */
  recentOutput(maxChars: number): string
  /** 在远端/本地执行一次性命令并返回完整输出（监控采集用） */
  exec(command: string): Promise<string>
  /** 连接是否已就绪（本地 shell 已启动 / SSH 握手已完成），监控采集前应判读 */
  isReady(): boolean
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
    handlers: { onData: (data: Buffer) => void; onExit: (exitCode: number) => void },
    shellId?: string
  ) {
    const shell = resolveLocalShell(shellId)
    this.proc = pty.spawn(shell.command, shell.args ?? [], {
      name: TERM_TYPE,
      cols,
      rows,
      cwd: os.homedir(),
      // 传 null 让 onData 返回原始 Buffer，保留 ZMODEM 等二进制协议的字节保真
      encoding: null,
      env: { ...stripUndefined(process.env), TERM: TERM_TYPE, COLORTERM: 'truecolor' }
    })
    this.info = {
      id,
      type: 'local',
      title: shell.title,
      pid: this.proc.pid,
      createdAt: Date.now(),
      exited: false
    }
    this.proc.onData((data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string)
      this.appendOutput(buf.toString('utf8'))
      handlers.onData(buf)
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

  write(data: string | Uint8Array): void {
    this.proc.write(typeof data === 'string' ? data : Buffer.from(data))
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

  exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      cpExec(command, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(err)
        else resolve(stdout + stderr)
      })
    })
  }

  isReady(): boolean {
    return !this.info.exited
  }
}

/** SSH 远程会话 */
class SshSession implements InternalSession {
  info: SessionInfo
  private conn = new Client()
  private stream: ClientChannel | null = null
  private ready = false
  private output = ''
  private killed = false
  /** 目标 PTY 尺寸：SSH 握手完成前收到的 resize 需缓存，待 shell 流建立后补应用 */
  private desiredCols: number
  private desiredRows: number
  private onData: (data: Buffer) => void
  private onExit: (exitCode: number) => void

  constructor(
    id: string,
    profile: SshProfile,
    cols: number,
    rows: number,
    handlers: { onData: (data: Buffer) => void; onExit: (code: number) => void }
  ) {
    this.info = {
      id,
      type: 'ssh',
      title: `${profile.username}@${profile.host}`,
      profileId: profile.id,
      createdAt: Date.now(),
      exited: false
    }
    this.desiredCols = Math.max(2, cols)
    this.desiredRows = Math.max(2, rows)
    this.onData = handlers.onData
    this.onExit = handlers.onExit
    this.connect(profile)
  }

  private fail(message: string): void {
    const line = `\r\n\x1b[31m[SSH 连接失败] ${message}\x1b[0m\r\n`
    this.appendOutput(line)
    this.onData(Buffer.from(line))
    this.ready = false
    this.info.exited = true
    this.onExit(1)
  }

  private connectAttempt = 0
  /** 握手阶段失败（如服务端在并发连接时短暂丢弃）时的重试次数 */
  private readonly maxConnectAttempts = 3

  private connect(profile: SshProfile): void {
    if (this.killed) return
    this.connectAttempt++
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

    // 每次尝试使用独立的 Client 实例，避免失败连接的事件残留
    const conn = new Client()
    this.conn = conn
    conn
      .on('ready', () => {
        if (this.killed) return
        conn.shell(
          // 用最新目标尺寸打开 shell（握手期间可能已收到渲染端下发的 resize）
          { term: TERM_TYPE, cols: this.desiredCols, rows: this.desiredRows },
          (err, stream) => {
            if (this.killed) return
            if (err || !stream) {
              this.fail(err?.message || '无法打开 shell')
              return
            }
            this.stream = stream
            // shell 流建立后才算就绪：此时写入的输入不会被丢弃（isReady 也用于脚本投递）
            this.ready = true
            // 握手期间收到的 resize 在此补应用，避免远端 PTY 停在创建时的初始尺寸
            this.applySize()
            stream.on('data', (data: Buffer | string) => {
              const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
              this.appendOutput(buf.toString('utf8'))
              this.onData(buf)
            })
            stream.on('close', () => {
              this.ready = false
              this.info.exited = true
              this.onExit(0)
            })
            stream.stderr?.on('data', (data: Buffer | string) => {
              const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
              this.appendOutput(buf.toString('utf8'))
              this.onData(buf)
            })
          }
        )
      })
      .on('error', (err: Error) => {
        if (this.killed || this.stream) return
        this.ready = false
        // 尚未建立 shell 且仍可重试：退避后重连（覆盖并发连接被短暂丢弃等瞬时故障）
        if (this.connectAttempt < this.maxConnectAttempts) {
          const delay = 600 * this.connectAttempt
          setTimeout(() => {
            if (!this.killed) this.connect(profile)
          }, delay)
          return
        }
        this.fail(err.message)
      })
      .connect(config)
  }

  private appendOutput(data: string): void {
    this.output += data
    if (this.output.length > MAX_OUTPUT_BUFFER) {
      this.output = this.output.slice(-MAX_OUTPUT_BUFFER)
    }
  }

  write(data: string | Uint8Array): void {
    if (this.stream) this.stream.write(typeof data === 'string' ? data : Buffer.from(data))
  }

  resize(cols: number, rows: number): void {
    this.desiredCols = Math.max(2, cols)
    this.desiredRows = Math.max(2, rows)
    this.applySize()
  }

  /** 应用最新目标尺寸；shell 流尚未建立时先缓存，待建立后补应用 */
  private applySize(): void {
    if (!this.stream) return
    try {
      this.stream.setWindow(this.desiredRows, this.desiredCols, 0, 0)
    } catch {
      // 忽略
    }
  }

  kill(): void {
    this.killed = true
    this.ready = false
    try {
      this.stream?.close()
    } catch {
      // 忽略
    }
    try {
      this.conn.end()
    } catch {
      // 连接已在握手/失败中关闭
    }
    if (!this.info.exited) {
      this.info.exited = true
      this.onExit(0)
    }
  }

  recentOutput(maxChars: number): string {
    return this.output.slice(-maxChars)
  }

  isReady(): boolean {
    return this.ready && !this.killed
  }

  exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.killed || !this.ready) {
        reject(new Error('SSH 连接未就绪'))
        return
      }
      this.conn.exec(command, (err, stream: ClientChannel) => {
        if (err || !stream) {
          reject(err ?? new Error('exec 通道建立失败'))
          return
        }
        let out = ''
        stream.on('data', (data: Buffer | string) => {
          out += Buffer.isBuffer(data) ? data.toString('utf8') : data
        })
        stream.stderr?.on('data', (data: Buffer | string) => {
          out += Buffer.isBuffer(data) ? data.toString('utf8') : data
        })
        stream.on('close', () => resolve(out))
      })
    })
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

  createLocal(cols = 80, rows = 24, shellId?: string): SessionInfo {
    const id = crypto.randomUUID()
    const session = new LocalSession(
      id,
      cols,
      rows,
      {
        onData: (data) => this.handleData(id, data),
        onExit: (code) => this.handleExit(id, code)
      },
      shellId
    )
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

  private handleData(id: string, data: Buffer | string): void {
    this.emit('data', { sessionId: id, data })
  }

  private handleExit(id: string, exitCode: number): void {
    this.emit('exit', { sessionId: id, exitCode })
  }

  write(id: string, data: string | Uint8Array): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    this.lastActiveId = id
    session.write(data)
    return true
  }

  /**
   * 等待会话就绪后写入内容（SSH 握手 + shell 建立需要时间，未就绪时写入会被丢弃）。
   * 返回是否写入成功；会话不存在/已退出/等待超时返回 false。
   */
  async writeWhenReady(id: string, data: string, timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const session = this.sessions.get(id)
      if (!session || session.info.exited) return false
      if (session.isReady()) {
        this.write(id, data)
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
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
