import { EventEmitter } from 'node:events'
import { exec as cpExec } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import * as pty from 'node-pty'
import iconv from 'iconv-lite'
import { Client, type ClientChannel } from 'ssh2'
import type {
  HostPlatform,
  SessionInfo,
  SessionType,
  SshConnectProgress,
  SshConnectStage,
  SshProfile,
  TerminalCharset
} from '@shared/types'
import { moshClientStatus, resolveMoshClient, type ResolvedMoshClient } from './mosh'
import { resolveLocalShell } from './shells'
import { connectWithJumps, type ConnectedChain } from '../ssh/connect'
import { hostLogger } from '../log/logger'
import { terminalRecorder, type CommandSource } from './recording'

/** 每个会话保留的输出缓冲上限，供 AI 读取 */
const MAX_OUTPUT_BUFFER = 256 * 1024

/**
 * 统一终端类型：必须是 256 色终端，否则远程 ncurses 程序（htop/btop/lazygit 等）
 * 会按 8 色甚至无色渲染，表现为黑白。
 */
const TERM_TYPE = 'xterm-256color'

interface InternalSession {
  info: SessionInfo
  /** 写入输入；返回是否真正送达（SSH 通道 / mosh-client 未建立时会丢弃） */
  write(data: string | Uint8Array): boolean
  resize(cols: number, rows: number): void
  kill(): void
  /** 读取最近输出（AI 工具用） */
  recentOutput(maxChars: number): string
  /** 当前输出缓冲区长度（AI 工具用于增量读取） */
  outputLength(): number
  /** 读取从指定偏移开始的新增输出（AI 工具用于增量读取） */
  outputFrom(start: number): string
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
    shell: { command: string; args?: string[]; title: string },
    profileId?: string,
    /** 终端启动后自动执行的命令 */
    autoCommand?: string,
    /** 终端工作目录，缺省为用户主目录 */
    cwd?: string
  ) {
    this.proc = pty.spawn(shell.command, shell.args ?? [], {
      name: TERM_TYPE,
      cols,
      rows,
      cwd: cwd ?? os.homedir(),
      // 传 null 让 onData 返回原始 Buffer，保留 ZMODEM 等二进制协议的字节保真
      encoding: null,
      env: { ...stripUndefined(process.env), TERM: TERM_TYPE, COLORTERM: 'truecolor' }
    })
    this.info = {
      id,
      type: 'local',
      title: shell.title,
      profileId,
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
    // 终端启动后自动执行命令：PTY 输入带缓冲，spawn 后立即写入不会丢
    if (autoCommand) {
      this.proc.write(autoCommand + '\r')
      // 旁路 manager.write 的直接写入，手动补一条命令记录（来源：脚本）
      terminalRecorder.feedInput(id, this.info, `${autoCommand}\r`, 'script')
    }
  }

  private appendOutput(data: string): void {
    this.output += data
    if (this.output.length > MAX_OUTPUT_BUFFER) {
      this.output = this.output.slice(-MAX_OUTPUT_BUFFER)
    }
  }

  write(data: string | Uint8Array): boolean {
    this.proc.write(typeof data === 'string' ? data : Buffer.from(data))
    return true
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

  outputLength(): number {
    return this.output.length
  }

  outputFrom(start: number): string {
    return this.output.slice(Math.max(0, start))
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
  /** 目标主机的连接（链尾）；未就绪时为 null */
  private conn: Client | null = null
  /** 当前整条连接链（含跳板）：重试 / 关闭时经它统一收尾 */
  private chain: ConnectedChain | null = null
  private stream: ClientChannel | null = null
  private ready = false
  private output = ''
  private killed = false
  /** 收尾日志只记一次（用户关闭与远端断开可能都会走到） */
  private closeLogged = false
  /** 目标 PTY 尺寸：SSH 握手完成前收到的 resize 需缓存，待 shell 流建立后补应用 */
  private desiredCols: number
  private desiredRows: number
  /** 会话字符集：utf-8（缺省，字节原样透传）/ gbk（主进程解码为 UTF-8 后下发） */
  private readonly charset: TerminalCharset
  /**
   * 输出下发回调：data 是渲染端消费的 UTF-8 字节；非 UTF-8 会话下 raw 携带远端原始
   * 字节（记录器用它保持会话日志字节级保真），UTF-8 会话两者相同。
   */
  private onData: (data: Buffer, raw?: Buffer) => void
  private onExit: (exitCode: number) => void
  /** 连接阶段上报（渲染端据此显示「握手中」等进度提示） */
  private onStatus: (progress: Omit<SshConnectProgress, 'sessionId'>) => void

  constructor(
    id: string,
    profile: SshProfile,
    cols: number,
    rows: number,
    handlers: {
      onData: (data: Buffer, raw?: Buffer) => void
      onExit: (code: number) => void
      onStatus: (progress: Omit<SshConnectProgress, 'sessionId'>) => void
    }
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
    this.charset = profile.terminalCharset === 'gbk' ? 'gbk' : 'utf-8'
    this.onData = handlers.onData
    this.onExit = handlers.onExit
    this.onStatus = handlers.onStatus
    this.connect(profile)
  }

  private emitStatus(
    stage: SshConnectStage,
    extra?: Pick<SshConnectProgress, 'attempt' | 'maxAttempts' | 'detail'>
  ): void {
    if (this.killed) return
    this.onStatus({ stage, ...extra })
  }

  private fail(message: string): void {
    const line = `\r\n\x1b[31m[主机连接失败] ${message}\x1b[0m\r\n`
    this.appendOutput(line)
    this.onData(Buffer.from(line))
    this.ready = false
    this.info.exited = true
    // 连接已判死：链上资源一并收尾（未建立时为空操作）
    this.chain?.dispose()
    this.onExit(1)
  }

  /** 收尾日志（幂等）：用户关标签 / 远端退出 / 网络中断都可能触发，只记第一条 */
  private logClosed(reason: string): void {
    if (this.closeLogged) return
    this.closeLogged = true
    hostLogger.info('ssh', `[终端会话] ${reason}：${this.info.title}`)
  }

  private connectAttempt = 0
  /** 握手阶段失败（如服务端在并发连接时短暂丢弃）时的重试次数 */
  private readonly maxConnectAttempts = 3

  private connect(profile: SshProfile): void {
    if (this.killed) return
    this.connectAttempt++
    if (this.connectAttempt === 1) {
      this.emitStatus('resolving')
    } else {
      this.emitStatus('retrying', {
        attempt: this.connectAttempt,
        maxAttempts: this.maxConnectAttempts
      })
    }
    // 每次尝试都重建整条链（含跳板），避免失败连接的事件残留
    this.chain?.dispose()
    this.chain = null
    connectWithJumps(profile, {
      purpose: 'terminal',
      // 多跳时 detail 标注当前是哪一跳；单跳时与历史行为一致（不带 detail）
      onStage: (stage, detail) =>
        this.emitStatus(stage, detail === undefined ? undefined : { detail })
    }).then(
      (connected) => {
        if (this.killed) {
          connected.dispose()
          return
        }
        this.chain = connected
        this.conn = connected.client
        this.openShell(connected.client)
      },
      (err: Error) => {
        if (this.killed || this.stream) return
        this.ready = false
        // 尚未建立 shell 且仍可重试：退避后重连（覆盖并发连接被短暂丢弃等瞬时故障）
        if (this.connectAttempt < this.maxConnectAttempts) {
          const delay = 600 * this.connectAttempt
          hostLogger.warn(
            'ssh',
            `[终端会话] 连接失败（第 ${this.connectAttempt}/${this.maxConnectAttempts} 次尝试），${delay}ms 后自动重试：${err.message}`
          )
          setTimeout(() => {
            if (!this.killed) this.connect(profile)
          }, delay)
          return
        }
        this.fail(err.message)
      }
    )
  }

  /** 在链尾已就绪的连接上打开 shell 流（每次重连都会重新走到这里） */
  private openShell(conn: Client): void {
    if (this.killed) return
    this.emitStatus('opening-shell')
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
        this.emitStatus('ready')
        hostLogger.info('ssh', `[终端会话] 会话已就绪：${this.info.title}`)
        // 握手期间收到的 resize 在此补应用，避免远端 PTY 停在创建时的初始尺寸
        this.applySize()
        // 平台探测（监控 / AI 提示据此分支）：异步执行，失败不影响会话
        void this.probePlatform()
        // 非 UTF-8 会话：每个流一份有状态解码器（多字节字符可能跨 chunk 到达）
        const stdoutDecoder = this.charset === 'utf-8' ? null : iconv.getDecoder(this.charset)
        const stderrDecoder = this.charset === 'utf-8' ? null : iconv.getDecoder(this.charset)
        stream.on('data', (data: Buffer | string) => {
          this.emitOutput(stdoutDecoder, data)
        })
        stream.on('close', () => {
          this.ready = false
          this.info.exited = true
          this.logClosed('会话已断开（远端退出或网络中断）')
          this.onExit(0)
        })
        stream.stderr?.on('data', (data: Buffer | string) => {
          this.emitOutput(stderrDecoder, data)
        })
      }
    )
  }

  private appendOutput(data: string): void {
    this.output += data
    if (this.output.length > MAX_OUTPUT_BUFFER) {
      this.output = this.output.slice(-MAX_OUTPUT_BUFFER)
    }
  }

  /**
   * shell 输出统一出口（stdout / stderr 各带一份有状态解码器）。
   * - utf-8（缺省）：原字节透传，行为与历史一致；
   * - 其他字符集（如 gbk）：解码为文本后重编码成 UTF-8 下发（渲染端始终按 UTF-8
   *   渲染），远端原始字节作为 raw 交给记录器，会话日志保持字节级保真。
   * 已知限制：zmodem 等二进制协议帧在非 UTF-8 会话中会被解码破坏（Windows 无
   * sz/rz，UTF-8 会话不受影响）。
   */
  private emitOutput(
    decoder: ReturnType<typeof iconv.getDecoder> | null,
    data: Buffer | string
  ): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (!decoder) {
      this.appendOutput(buf.toString('utf8'))
      this.onData(buf)
      return
    }
    const text = decoder.write(buf)
    if (text) this.appendOutput(text)
    // 文本为空（多字节字符尚不完整）时也要下发：记录器依赖 raw 保持字节完整
    this.onData(Buffer.from(text, 'utf8'), buf)
  }

  write(data: string | Uint8Array): boolean {
    if (!this.stream) return false
    if (typeof data === 'string') {
      // 非 UTF-8 会话：键入文本按会话字符集编码后发往远端；Uint8Array 为二进制直通（zmodem 等）
      this.stream.write(this.charset === 'utf-8' ? data : iconv.encode(data, this.charset))
    } else {
      this.stream.write(Buffer.from(data))
    }
    return true
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
    this.logClosed('会话已关闭')
    try {
      this.stream?.close()
    } catch {
      // 忽略
    }
    // 整条链（含跳板）统一收尾；未建立时为空操作
    this.chain?.dispose()
    if (!this.info.exited) {
      this.info.exited = true
      this.onExit(0)
    }
  }

  recentOutput(maxChars: number): string {
    return this.output.slice(-maxChars)
  }

  outputLength(): number {
    return this.output.length
  }

  outputFrom(start: number): string {
    return this.output.slice(Math.max(0, start))
  }

  isReady(): boolean {
    return this.ready && !this.killed
  }

  exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = this.conn
      if (this.killed || !this.ready || !conn) {
        reject(new Error('主机未就绪'))
        return
      }
      conn.exec(command, (err, stream: ClientChannel) => {
        if (err || !stream) {
          reject(err ?? new Error('exec 通道建立失败'))
          return
        }
        // 先整段累积、关闭时一次性解码：多字节字符跨 chunk 时不会被截断
        const chunks: Buffer[] = []
        const collect = (data: Buffer | string): void => {
          chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
        }
        stream.on('data', collect)
        stream.stderr?.on('data', collect)
        stream.on('close', () => {
          const buf = Buffer.concat(chunks)
          resolve(
            this.charset === 'utf-8' ? buf.toString('utf8') : iconv.decode(buf, this.charset)
          )
        })
      })
    })
  }

  /** 单条探测命令的超时（毫秒）：超时后放弃探测（保持未识别状态），不阻塞会话 */
  private readonly platformProbeTimeout = 4000

  /**
   * 平台探测（会话就绪后执行一次，重连后重新探测）：
   * `cmd /c ver` 命中 Microsoft Windows 判为 windows（cmd / PowerShell 默认 shell
   * 均可执行）；否则 `uname -s` 区分 linux / 其他 Unix；都失败或超时保持未探测
   * （undefined），监控等按旧行为降级。探测结果只记在会话上，不写入主机配置。
   */
  private async probePlatform(): Promise<void> {
    let platform: HostPlatform | undefined
    const ver = await this.execTimed('cmd /c ver')
    if (/microsoft windows/i.test(ver)) {
      platform = 'windows'
    } else {
      const uname = await this.execTimed('uname -s')
      if (/linux/i.test(uname)) platform = 'linux'
      else if (/(darwin|bsd|sunos)/i.test(uname)) platform = 'other'
    }
    if (!platform || this.killed) return
    this.info.platform = platform
    const label = platform === 'windows' ? 'Windows' : platform === 'linux' ? 'Linux' : '其他 Unix'
    hostLogger.info('ssh', `[终端会话] 已识别主机平台：${label}（${this.info.title}）`)
  }

  /** 带超时的一次性命令：失败 / 超时返回空串（探测场景只关心特征输出是否存在） */
  private async execTimed(command: string): Promise<string> {
    let timer: NodeJS.Timeout | null = null
    try {
      return await Promise.race([
        this.exec(command),
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => reject(new Error('探测命令超时')), this.platformProbeTimeout)
        })
      ])
    } catch {
      return ''
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/** 远端 mosh-server 引导超时：正常会秒级打印 MOSH CONNECT 并脱离，等不到就是有问题 */
const MOSH_BOOTSTRAP_TIMEOUT = 20000

/** mosh-server 就绪时会打印：MOSH CONNECT <UDP 端口> <base64 密钥> */
const MOSH_CONNECT_RE = /MOSH CONNECT (\d+) ([A-Za-z0-9+/=]+)/

/** 引导失败的补充说明（远端没装 mosh-server 是最常见的原因） */
function remoteMoshHint(stderr: string): string {
  if (/not found|No such file/i.test(stderr)) {
    return '（远端未安装 mosh-server：Debian/Ubuntu 用 apt install mosh、RHEL 系用 dnf install mosh）'
  }
  const first = stderr.trim().split(/\r?\n/)[0]
  return first ? `（${first}）` : ''
}

/**
 * Mosh 远程会话：SSH 只负责「引导」，终端数据流走本地 mosh-client（UDP）。
 *
 * 引导链路：ssh2 连接 → exec 启动远端 mosh-server（打印 MOSH CONNECT 后自行脱离）
 * → 本地 PTY 里跑 mosh-client，端口与密钥经参数 / MOSH_KEY 传入。
 * 之后与 SSH 无关：断网 / 切网由 mosh 自己的 UDP 协议恢复，所以这里没有
 * SshSession「断开后重开会话」那套逻辑，只有引导阶段的失败重试。
 */
class MoshSession implements InternalSession {
  info: SessionInfo
  private conn: Client | null = null
  /** 当前 SSH 引导链（含跳板）：关闭 / 重试时统一经它收尾 */
  private chain: ConnectedChain | null = null
  /**
   * SSH 引导通道是否仍可用。mosh 协议没有 exec 通道，ServerMonitor 的采集
   * 复用这条连接；UDP 漫游后它必然失效 —— 监控会连续失败自行停止，不影响终端继续用。
   */
  private sshReady = false
  /** 本地 mosh-client 进程（PTY）：终端数据从此走 UDP */
  private proc: pty.IPty | null = null
  private ready = false
  private killed = false
  /** 收尾日志只记一次（用户关闭与 mosh-client 退出可能都会走到） */
  private closeLogged = false
  private output = ''
  /** 目标 PTY 尺寸：mosh-client 拉起前收到的 resize 需缓存，待拉起后补应用 */
  private desiredCols: number
  private desiredRows: number
  private client: ResolvedMoshClient
  private onData: (data: Buffer) => void
  private onExit: (exitCode: number) => void
  /** 连接阶段上报（渲染端据此显示「握手中」等进度提示） */
  private onStatus: (progress: Omit<SshConnectProgress, 'sessionId'>) => void
  /** 引导超时定时器（拿到连接信息 / 失败 / 结束时清理） */
  private bootstrapTimer: NodeJS.Timeout | null = null
  private connectAttempt = 0
  private readonly maxConnectAttempts = 3

  constructor(
    id: string,
    profile: SshProfile,
    client: ResolvedMoshClient,
    cols: number,
    rows: number,
    handlers: {
      onData: (data: Buffer) => void
      onExit: (code: number) => void
      onStatus: (progress: Omit<SshConnectProgress, 'sessionId'>) => void
    }
  ) {
    this.info = {
      id,
      type: 'ssh',
      // 与纯 SSH 会话区分（连接卡片 / 后续功能用）
      mosh: true,
      title: `${profile.username}@${profile.host}`,
      profileId: profile.id,
      createdAt: Date.now(),
      exited: false
    }
    this.desiredCols = Math.max(2, cols)
    this.desiredRows = Math.max(2, rows)
    this.client = client
    this.onData = handlers.onData
    this.onExit = handlers.onExit
    this.onStatus = handlers.onStatus
    this.connect(profile)
  }

  private emitStatus(
    stage: SshConnectStage,
    extra?: Pick<SshConnectProgress, 'attempt' | 'maxAttempts' | 'detail'>
  ): void {
    if (this.killed) return
    this.onStatus({ stage, ...extra })
  }

  private fail(message: string): void {
    if (this.killed || this.info.exited) return
    hostLogger.error('ssh', `[Mosh 引导] ${message}`)
    const line = `\r\n\x1b[31m[主机连接失败] ${message}\x1b[0m\r\n`
    this.appendOutput(line)
    this.onData(Buffer.from(line))
    this.ready = false
    this.info.exited = true
    this.clearBootstrapTimer()
    this.closeSsh()
    this.onExit(1)
  }

  /** 收尾日志（幂等）：用户关标签 / mosh-client 退出都可能触发，只记第一条 */
  private logClosed(reason: string): void {
    if (this.closeLogged) return
    this.closeLogged = true
    hostLogger.info('ssh', `[Mosh 引导] ${reason}：${this.info.title}`)
  }

  private clearBootstrapTimer(): void {
    if (!this.bootstrapTimer) return
    clearTimeout(this.bootstrapTimer)
    this.bootstrapTimer = null
  }

  /** 关闭 SSH 引导通道（mosh 会话不依赖它，单独收尾） */
  private closeSsh(): void {
    this.sshReady = false
    this.conn = null
    this.chain?.dispose()
    this.chain = null
  }

  /** SSH 引导：认证通过后启动远端 mosh-server；引导失败按既有策略退避重试 */
  private connect(profile: SshProfile): void {
    if (this.killed) return
    this.connectAttempt++
    if (this.connectAttempt === 1) {
      this.emitStatus('resolving')
    } else {
      this.emitStatus('retrying', {
        attempt: this.connectAttempt,
        maxAttempts: this.maxConnectAttempts
      })
    }
    // 每次尝试都重建整条引导链（含跳板），避免失败连接的事件残留
    this.chain?.dispose()
    this.chain = null
    this.conn = null
    this.sshReady = false
    connectWithJumps(profile, {
      purpose: 'mosh',
      // 多跳时 detail 标注当前是哪一跳；单跳时与历史行为一致（不带 detail）
      onStage: (stage, detail) =>
        this.emitStatus(stage, detail === undefined ? undefined : { detail })
    }).then(
      (connected) => {
        if (this.killed) {
          connected.dispose()
          return
        }
        this.chain = connected
        this.conn = connected.client
        // 引导通道掉线只影响监控采集与一次性命令；mosh 会话本身照常工作
        connected.client.on('close', () => {
          this.sshReady = false
        })
        this.sshReady = true
        this.emitStatus('opening-shell')
        this.startRemoteServer(profile)
      },
      (err: Error) => {
        this.sshReady = false
        if (this.killed) return
        // 本地 mosh-client 已经在跑：SSH 掉线不影响会话，不重试
        if (this.proc) return
        if (this.connectAttempt < this.maxConnectAttempts) {
          const delay = 600 * this.connectAttempt
          hostLogger.warn(
            'ssh',
            `[Mosh 引导] 连接失败（第 ${this.connectAttempt}/${this.maxConnectAttempts} 次尝试），${delay}ms 后自动重试：${err.message}`
          )
          setTimeout(() => {
            if (!this.killed) this.connect(profile)
          }, delay)
          return
        }
        this.fail(err.message)
      }
    )
  }

  /**
   * 在远端启动 mosh-server 并解析连接信息。
   * 命令与官方 mosh 脚本一致：-s 绑定 SSH 进来的那个本地接口、256 色、UTF-8 兜底。
   */
  private startRemoteServer(profile: SshProfile): void {
    const conn = this.conn
    if (!conn) return
    conn.exec('mosh-server new -s -c 256 -l LANG=C.UTF-8', (err, stream) => {
      if (this.killed) return
      if (err || !stream) {
        this.fail(`无法在远端启动 mosh-server：${err?.message ?? '命令通道建立失败'}`)
        return
      }
      let stdout = ''
      let stderr = ''
      /** 已解析出连接信息（mosh-server 随后会自行脱离，exec 通道关闭不算失败） */
      let started = false
      this.bootstrapTimer = setTimeout(() => {
        if (started || this.proc) return
        this.fail(`远端 mosh-server 启动超时${remoteMoshHint(stderr)}`)
      }, MOSH_BOOTSTRAP_TIMEOUT)

      const tryConsume = (): void => {
        if (started) return
        const matched = stdout.match(MOSH_CONNECT_RE)
        if (!matched) return
        started = true
        this.clearBootstrapTimer()
        this.spawnClient(profile, Number(matched[1]), matched[2])
      }
      stream.on('data', (data: Buffer | string) => {
        stdout += Buffer.isBuffer(data) ? data.toString('utf8') : data
        tryConsume()
      })
      stream.stderr?.on('data', (data: Buffer | string) => {
        stderr += Buffer.isBuffer(data) ? data.toString('utf8') : data
      })
      stream.on('close', () => {
        if (started || this.killed) return
        this.fail(`远端 mosh-server 未返回连接信息${remoteMoshHint(stderr)}`)
      })
    })
  }

  /**
   * 本地拉起 mosh-client（PTY）。它本身就是个全屏终端程序，
   * 渲染 / 输入 / 尺寸与本地会话完全同构，xterm 侧不需要任何特殊处理。
   */
  private spawnClient(profile: SshProfile, port: number, key: string): void {
    if (this.killed || this.proc) return
    const host = profile.host
    const baseEnv = { ...stripUndefined(process.env), TERM: TERM_TYPE, COLORTERM: 'truecolor' }
    const options = {
      name: TERM_TYPE,
      cols: this.desiredCols,
      rows: this.desiredRows,
      cwd: os.homedir(),
      encoding: null,
      env: baseEnv
    }
    try {
      if (this.client.kind === 'native') {
        // MSYS2 / Cygwin 版依赖同目录的运行时 DLL，把所在目录并入 PATH 保证能启动
        const dir = path.dirname(this.client.command)
        this.proc = pty.spawn(this.client.command, [host, String(port)], {
          ...options,
          env: {
            ...baseEnv,
            MOSH_KEY: key,
            PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`
          }
        })
      } else {
        // WSL 回退：Windows 的环境变量不会自动带进发行版，用 env 显式传入
        this.proc = pty.spawn(
          this.client.launcher,
          [
            '-e',
            'env',
            `TERM=${TERM_TYPE}`,
            'LANG=C.UTF-8',
            `MOSH_KEY=${key}`,
            'mosh-client',
            host,
            String(port)
          ],
          options
        )
      }
    } catch (err) {
      this.fail(`本地 mosh-client 启动失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    this.proc.onData((data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string)
      this.appendOutput(buf.toString('utf8'))
      this.onData(buf)
    })
    this.proc.onExit(({ exitCode }) => {
      this.ready = false
      this.info.exited = true
      this.logClosed('会话已断开（mosh-client 退出）')
      this.closeSsh()
      this.onExit(exitCode)
    })
    // mosh-client 会缓冲引导阶段的输入，拉起即视为就绪（与本地会话一致）
    this.ready = true
    this.emitStatus('ready')
    hostLogger.info('ssh', `[Mosh 引导] 会话已就绪：${this.info.title}`)
    this.applySize()
  }

  private appendOutput(data: string): void {
    this.output += data
    if (this.output.length > MAX_OUTPUT_BUFFER) {
      this.output = this.output.slice(-MAX_OUTPUT_BUFFER)
    }
  }

  write(data: string | Uint8Array): boolean {
    if (!this.proc) return false
    this.proc.write(typeof data === 'string' ? data : Buffer.from(data))
    return true
  }

  resize(cols: number, rows: number): void {
    this.desiredCols = Math.max(2, cols)
    this.desiredRows = Math.max(2, rows)
    this.applySize()
  }

  /** 应用最新目标尺寸；mosh-client 尚未拉起时先缓存，待拉起后补应用 */
  private applySize(): void {
    if (!this.proc) return
    try {
      this.proc.resize(this.desiredCols, this.desiredRows)
    } catch {
      // 进程可能已退出
    }
  }

  kill(): void {
    this.killed = true
    this.ready = false
    this.logClosed('会话已关闭')
    this.clearBootstrapTimer()
    try {
      this.proc?.kill()
    } catch {
      // 忽略
    }
    this.closeSsh()
    if (!this.info.exited) {
      this.info.exited = true
      this.onExit(0)
    }
  }

  recentOutput(maxChars: number): string {
    return this.output.slice(-maxChars)
  }

  outputLength(): number {
    return this.output.length
  }

  outputFrom(start: number): string {
    return this.output.slice(Math.max(0, start))
  }

  isReady(): boolean {
    return this.ready && !this.killed
  }

  /**
   * 一次性命令复用 SSH 引导通道（ServerMonitor 采集用）——
   * mosh 协议本身没有 exec 通道；UDP 漫游后引导连接必然失效，
   * 监控会连续失败后自行停止，不影响 mosh 会话继续使用。
   */
  exec(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.killed || !this.sshReady || !this.conn) {
        reject(new Error('主机未就绪'))
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

  createLocal(cols = 80, rows = 24, shellId?: string, cwd?: string): SessionInfo {
    const id = crypto.randomUUID()
    const shell = resolveLocalShell(shellId)
    const session = new LocalSession(
      id,
      cols,
      rows,
      {
        onData: (data) => this.handleData(id, data),
        onExit: (code) => this.handleExit(id, code)
      },
      { command: shell.command, args: shell.args, title: shell.title },
      undefined,
      undefined,
      cwd
    )
    this.attach(id, session)
    return { ...session.info }
  }

  /** 按本地主机配置启动会话（环境为保存的 shell，启动后可自动执行命令） */
  createLocalHost(profile: SshProfile, cols = 80, rows = 24): SessionInfo {
    const command = profile.command?.trim()
    if (!command) throw new Error('本地终端未配置启动环境')
    const id = crypto.randomUUID()
    const session = new LocalSession(
      id,
      cols,
      rows,
      {
        onData: (data) => this.handleData(id, data),
        onExit: (code) => this.handleExit(id, code)
      },
      { command, args: profile.args, title: profile.name || command },
      profile.id,
      profile.autoCommand?.trim()
    )
    this.attach(id, session)
    return { ...session.info }
  }

  createSsh(profile: SshProfile, cols = 80, rows = 24): SessionInfo {
    const id = crypto.randomUUID()
    const session = new SshSession(id, profile, cols, rows, {
      onData: (data, raw) => this.handleData(id, data, raw),
      onExit: (code) => this.handleExit(id, code),
      onStatus: (progress) => this.handleStatus(id, progress)
    })
    this.attach(id, session)
    return { ...session.info }
  }

  /**
   * 按 Mosh 方式连接远程主机（SSH 引导 + 本地 mosh-client）。
   * 本地 mosh-client 缺失时同步抛错（渲染端弹提示）——不建立到远端的连接，也不留下必然失败的标签。
   */
  createMosh(profile: SshProfile, cols = 80, rows = 24): SessionInfo {
    const client = resolveMoshClient()
    if (!client) throw new Error(moshClientStatus().hint ?? '本地未检测到 mosh-client')
    const id = crypto.randomUUID()
    const session = new MoshSession(id, profile, client, cols, rows, {
      onData: (data) => this.handleData(id, data),
      onExit: (code) => this.handleExit(id, code),
      onStatus: (progress) => this.handleStatus(id, progress)
    })
    this.attach(id, session)
    return { ...session.info }
  }

  private attach(id: string, session: InternalSession): void {
    this.sessions.set(id, session)
    this.lastActiveId = id
    this.emit('created', { ...session.info })
  }

  private handleData(id: string, data: Buffer | string, raw?: Buffer): void {
    // 输出先喂记录器（落原始会话文件 / 回填进行中命令）；非 UTF-8 会话下 data 是重编码的
    // UTF-8 字节，记录器改用 raw 保持字节级保真。会话可能已不在 map（kill 后的迟到数据）
    const session = this.sessions.get(id)
    if (session) terminalRecorder.feedOutput(id, session.info, raw ?? data)
    this.emit('data', { sessionId: id, data })
  }

  private handleExit(id: string, exitCode: number): void {
    // 会话收尾：写完命令记录（幂等，重复触发无副作用）
    terminalRecorder.close(id)
    this.emit('exit', { sessionId: id, exitCode })
  }

  private handleStatus(id: string, progress: Omit<SshConnectProgress, 'sessionId'>): void {
    this.emit('status', { sessionId: id, ...progress })
  }

  /** 写入输入；source 标记来源（渲染端键入 / AI 工具 / 脚本），命令记录据此打标 */
  write(id: string, data: string | Uint8Array, source: CommandSource = 'user'): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    this.lastActiveId = id
    if (!session.write(data)) return false
    // 输入确实送达才记录（连接未就绪时被丢弃的输入不算「执行过的命令」）
    terminalRecorder.feedInput(id, session.info, data, source)
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
        // 当前唯一调用方是「运行脚本」（连上主机后自动执行保存的脚本）→ 标记脚本来源
        this.write(id, data, 'script')
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

  /** 当前输出缓冲区长度（AI 工具增量读取用） */
  outputLength(id: string): number {
    return this.sessions.get(id)?.outputLength() ?? 0
  }

  /** 读取从指定偏移开始的新增输出（AI 工具增量读取用） */
  outputFrom(id: string, start: number): string | null {
    return this.sessions.get(id)?.outputFrom(start) ?? null
  }
}

export const sessionManager = new SessionManager()
export type { SessionType }
