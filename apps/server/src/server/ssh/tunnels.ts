/**
 * SSH 隧道管理：本地转发（等价 `ssh -L`）、远程转发（等价 `ssh -R`）、SOCKS5 动态代理（等价 `ssh -D`）。
 *
 * ## 监听端口落在「跑 server 的那台机器」上
 *
 * 这不是取舍，就是 `ssh -L` / `-R` / `-D` 的标准语义：监听端永远在 **SSH 客户端** 侧，
 * 而本仓库里 SSH 客户端只有 server 一个（桌面端是把同一份 server 装进进程内跑，
 * web / cli 打的是 VPS 上那份）。于是三种形态天然自洽：
 *
 * | 形态 | `-L` 绑 `127.0.0.1:5432` 的含义 |
 * |---|---|
 * | 桌面端 | 你本机的 5432 → 经 SSH → 远端服务（与 dogi 完全一致） |
 * | VPS 上的 web | VPS 的 5432 → 经 SSH → 远端服务（VPS 上的进程 / 容器直接用） |
 *
 * 因此这里**不碰** Electron 主进程、preload、IPC：浏览器本来就绑不了端口，
 * 而 desktop 的 server 就在本机，绑在 server 进程里等价于绑在本机。
 *
 * ⚠️ 隧道端口是**裸端口**：不过 server 的登录鉴权，也不进 remote-access 那套凭据体系。
 * 所以 `bindHost` 默认 `127.0.0.1`，非回环地址由**界面**要求二次确认（VPS 有公网 IP 时
 * 填 `0.0.0.0` 等于把一个内网服务直接挂到公网）。
 *
 * ## 与终端 / 监控的关系
 *
 * 每条隧道持有**自己的一条 SSH 连接**（经跳板链则复用统一的 `connectWithJumps`），
 * 与终端会话（`ssh/session.ts`）、主机监控（`ssh/monitor.ts`）互不影响：
 * 终端断开不影响隧道，反之亦然。
 *
 * 远程转发（-R）由链尾服务器的 sshd 监听 `bindHost:bindPort`（默认仅回环可用，
 * 非回环需服务端开启 `GatewayPorts`）；服务器侧监听**随 SSH 连接消亡**，所以连接意外
 * 断开时隧道落为 `error`，而不是挂一个假的「运行中」。
 *
 * ## 挂在 globalThis 的原因
 *
 * 与 `ssh/monitor.ts` 同一条：管理器由路由（Turbopack 加载）创建，收尾却从
 * `shutdown.ts`（tsx 侧）调，两边模块缓存不互通 —— 只有把注册表放 `globalThis`，
 * 收尾时才关得掉路由侧建的那些监听。
 */
import net from 'node:net'
import type { ClientChannel, TcpConnectionDetails } from 'ssh2'
import type {
  SshTunnel,
  SshTunnelRuntime,
  SshTunnelStatus,
  SshTunnelsSnapshot
} from '@fizz/contracts/types'
import { appLog } from '@fizz/workspace'
import { connectWithJumps, type ConnectedChain } from './connect'
import { domain, markDirty } from '../state'

/** 已启动隧道的运行时资源 */
interface TunnelEntry {
  /** 本地监听（local / dynamic）；remote 的监听在服务器侧，没有本地 server */
  server: net.Server | null
  chain: ConnectedChain
  /** 当前已接受的转发连接数（仅展示用） */
  conns: number
  /** 已接受的连接 socket（stop 时全部销毁） */
  sockets: Set<net.Socket>
  startedAt: number
  /** 仅 remote：forwardIn 后服务器实际绑定的地址 / 端口（stop 时按它 unforwardIn） */
  remoteBind?: { host: string; port: number }
  /** 仅 remote：'tcp connection' 监听器（stop 时移除） */
  remoteListener?: (
    details: TcpConnectionDetails,
    accept: () => ClientChannel,
    reject: () => void
  ) => void
}

/** SOCKS5 回复：ver=5, rep, rsv=0, atyp=1(ipv4), BND.ADDR(0.0.0.0), BND.PORT(0) */
function socksReply(rep: number): Buffer {
  return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

/** 日志文案里的隧道名字（备注优先，其次监听地址） */
function tunnelName(t: SshTunnel): string {
  return t.label?.trim() || `${t.bindHost}:${t.bindPort}`
}

/** 日志文案里的转发摘要（与面板行内摘要同风格） */
function tunnelRoute(t: SshTunnel): string {
  const bind = `${t.bindHost}:${t.bindPort}`
  if (t.type === 'dynamic') return `SOCKS5 动态代理（${bind}）`
  const target = `${t.targetHost}:${t.targetPort}`
  return t.type === 'remote' ? `远程转发 ${bind} → 服务端 ${target}` : `本地转发 ${bind} → ${target}`
}

/**
 * 控制台输出 + **应用日志**（日志面板的「隧道」Tab）。
 *
 * ⚠️ 这两个 `console.*` 别撤：控制台是开发者看实时输出的地方，`appLog` 只喂日志面板，
 * 少了任何一个都会有人「明明有日志却看不到」。隧道不像终端那样高频，全量记不吵。
 */
function logInfo(message: string): void {
  console.info(`[tunnel] ${message}`)
  appLog.info('tunnel', message)
}

function logWarn(message: string): void {
  console.warn(`[tunnel] ${message}`)
  appLog.warn('tunnel', message)
}

function logError(message: string): void {
  console.error(`[tunnel] ${message}`)
  appLog.error('tunnel', message)
}

class TunnelManager {
  private entries = new Map<string, TunnelEntry>()
  /** starting / error / stopped 等非运行态记录；running 以 entries 为准 */
  private runtime = new Map<string, SshTunnelRuntime>()

  /**
   * 全部隧道的运行态 + 配置（配置按列表顺序，运行态含未启动的 stopped）。
   *
   * 与 `GET /api/ssh/tunnels`、state-ws 的 `sshTunnels` 快照域**逐字段一致** ——
   * 三者共用这一个函数，免得两边写歪。
   */
  snapshot(): SshTunnelsSnapshot {
    const tunnels = domain.listSshTunnels()
    const runtimes = tunnels.map((t): SshTunnelRuntime => {
      const entry = this.entries.get(t.id)
      if (entry) {
        return { id: t.id, status: 'running', conns: entry.conns, startedAt: entry.startedAt }
      }
      return this.runtime.get(t.id) ?? { id: t.id, status: 'stopped' }
    })
    return { tunnels, runtimes }
  }

  isRunning(id: string): boolean {
    return this.entries.has(id)
  }

  /** 状态一变就标脏：state-ws 去重后把新快照推给所有前端（不用自己广播） */
  private setStatus(id: string, status: SshTunnelStatus, error?: string): void {
    this.runtime.set(id, { id, status, error })
    markDirty(['sshTunnels'])
  }

  private broadcastConnCount(): void {
    markDirty(['sshTunnels'])
  }

  /**
   * 启动隧道。所有失败（配置缺失 / 连接失败 / 端口占用）都落到 `error` 状态、
   * **不向外抛错** —— 调用方（路由 / autoStart）只看快照里的状态。
   */
  async start(id: string): Promise<void> {
    if (this.entries.has(id)) return
    const tunnel = domain.listSshTunnels().find((t) => t.id === id)
    if (!tunnel) {
      logError(`隧道启动失败：配置不存在（id ${id}）`)
      this.setStatus(id, 'error', '隧道配置不存在')
      return
    }
    const name = tunnelName(tunnel)
    let host
    try {
      host = domain.resolveSshHost(tunnel.hostId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError(`「${name}」启动失败：${message}`)
      this.setStatus(id, 'error', message)
      return
    }

    this.setStatus(id, 'starting')
    logInfo(`「${name}」启动中：${tunnelRoute(tunnel)}`)
    let chain: ConnectedChain
    try {
      chain = await connectWithJumps(host)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError(`「${name}」启动失败：${message}`)
      this.setStatus(id, 'error', message)
      return
    }

    // SSH 连接意外断开（网络中断 / 被服务端踢出）：本地监听成了空壳、服务器侧监听已随连接消亡，
    // 落为 error 而不是留一个假的「运行中」。stop() 会先删 entry，正常停止不会命中这里。
    chain.client.once('close', () => {
      if (!this.entries.has(id)) return
      this.stop(id, { reason: '因 SSH 连接断开而中断', level: 'error' })
      this.setStatus(id, 'error', 'SSH 连接已断开，隧道已停止')
    })

    if (tunnel.type === 'remote') {
      await this.startRemote(id, tunnel, chain)
      return
    }

    const server = net.createServer()
    server.on('connection', (socket) => this.handleConnection(tunnel, chain, socket))
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err)
        server.once('error', onError)
        server.listen(tunnel.bindPort, tunnel.bindHost, () => {
          server.removeListener('error', onError)
          resolve()
        })
      })
    } catch (err) {
      chain.dispose()
      const message = err instanceof Error ? err.message : String(err)
      logError(`「${name}」启动失败：监听 ${tunnel.bindHost}:${tunnel.bindPort} 失败：${message}`)
      this.setStatus(id, 'error', `监听 ${tunnel.bindHost}:${tunnel.bindPort} 失败：${message}`)
      return
    }

    const entry: TunnelEntry = {
      server,
      chain,
      conns: 0,
      sockets: new Set(),
      startedAt: Date.now()
    }
    this.entries.set(id, entry)
    // listen 之后的运行时错误（极少见）：整条隧道收尾并置为 error
    server.on('error', (err) => {
      if (!this.entries.has(id)) return
      this.stop(id, { reason: `监听出错：${err.message}`, level: 'error' })
      this.setStatus(id, 'error', err.message)
    })
    logInfo(`「${name}」已启动`)
    this.setStatus(id, 'running')
  }

  /**
   * 远程转发（-R）的启动：请求链尾服务器监听 `bindHost:bindPort`，外部连接经 SSH
   * 通道回到本进程后，再转发到 `targetHost:targetPort`（服务端所在机器可达）。
   * 绑定失败（端口被占 / 服务端不允许）与 -L 的监听失败同级：落 error，不抛错。
   */
  private async startRemote(id: string, tunnel: SshTunnel, chain: ConnectedChain): Promise<void> {
    const name = tunnelName(tunnel)
    const entry: TunnelEntry = {
      server: null,
      chain,
      conns: 0,
      sockets: new Set(),
      startedAt: Date.now()
    }
    // 先挂通道监听再请求绑定：绑定成功与首个连接之间不留丢事件的窗口
    const listener = (
      _details: TcpConnectionDetails,
      accept: () => ClientChannel,
      reject: () => void
    ): void => this.handleRemoteConnection(id, tunnel, accept, reject)
    chain.client.on('tcp connection', listener)
    entry.remoteListener = listener

    const bindResult = await new Promise<{ err: Error | null; port: number }>((resolve) => {
      try {
        chain.client.forwardIn(tunnel.bindHost, tunnel.bindPort, (err, port) =>
          resolve({ err: err ?? null, port: port ?? tunnel.bindPort })
        )
      } catch (err) {
        // 连接已失效时 forwardIn 同步抛出
        resolve({ err: err instanceof Error ? err : new Error(String(err)), port: tunnel.bindPort })
      }
    })
    if (bindResult.err) {
      chain.client.removeListener('tcp connection', listener)
      chain.dispose()
      const message = `服务器监听 ${tunnel.bindHost}:${tunnel.bindPort} 失败：${bindResult.err.message}`
      logError(`「${name}」启动失败：${message}`)
      this.setStatus(id, 'error', message)
      return
    }

    // port 与请求值不同 = 服务端分配的端口（请求 0 时）；unforwardIn 必须按实际端口解绑
    entry.remoteBind = { host: tunnel.bindHost, port: bindResult.port }
    this.entries.set(id, entry)
    logInfo(`「${name}」已启动`)
    this.setStatus(id, 'running')
  }

  /**
   * 停止隧道：解除监听、销毁转发连接、关闭 SSH 连接。
   * `opts.reason` 仅用于日志（缺省不带括注）；意外中断（连接断开 / 监听出错）用
   * `level='error'` 记成错误，正常停止（手动 / 配置变更 / 删除）记 info。
   */
  stop(id: string, opts?: { reason?: string; level?: 'info' | 'error' }): void {
    const entry = this.entries.get(id)
    if (entry) {
      this.entries.delete(id)
      const tunnel = domain.listSshTunnels().find((t) => t.id === id)
      const name = tunnel ? tunnelName(tunnel) : id
      if (opts?.level === 'error') {
        logError(`「${name}」${opts.reason ?? '已停止'}`)
      } else {
        logInfo(`「${name}」已停止${opts?.reason ? `（${opts.reason}）` : ''}`)
      }
      if (entry.server) {
        try {
          entry.server.close()
        } catch {
          // 可能已关闭
        }
      }
      for (const socket of entry.sockets) socket.destroy()
      entry.sockets.clear()
      // remote：先解除服务器侧监听（连接已断开时监听自然消亡，失败无妨），再摘掉通道监听
      if (entry.remoteBind) {
        try {
          entry.chain.client.unforwardIn(entry.remoteBind.host, entry.remoteBind.port)
        } catch {
          // 连接可能已断开
        }
      }
      if (entry.remoteListener) {
        entry.chain.client.removeListener('tcp connection', entry.remoteListener)
      }
      entry.chain.dispose()
    }
    this.setStatus(id, 'stopped')
  }

  /** 停止所有引用该主机的隧道（主机配置被删除 / 改了连接参数时联动调用） */
  stopByHost(hostId: string): void {
    for (const tunnel of domain.listSshTunnels()) {
      if (tunnel.hostId === hostId && this.entries.has(tunnel.id)) {
        this.stop(tunnel.id, { reason: '主机配置已变更' })
      }
    }
  }

  /**
   * 进程收尾：全部停掉。
   *
   * 每条隧道都持有真实 socket（本地监听 + SSH 连接），不显式关会拖着进程不退出 ——
   * dogi 靠 Electron 退出兜底，server 形态得自己收（`shutdown.ts` 调）。
   */
  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.stop(id, { reason: '服务退出' })
  }

  /**
   * 服务启动时自动拉起 `autoStart` 的隧道。
   *
   * 错开 300ms 起一条：同时建一堆 SSH 连接既没必要，也容易撞上远端 sshd 的
   * `MaxStartups`。失败只落在各自的状态里（不抛错），不影响后续几条。
   */
  async autoStart(): Promise<void> {
    const tunnels = domain.listSshTunnels().filter((t) => t.autoStart)
    for (const tunnel of tunnels) {
      void this.start(tunnel.id)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }

  private handleConnection(tunnel: SshTunnel, chain: ConnectedChain, socket: net.Socket): void {
    const entry = this.entries.get(tunnel.id)
    if (!entry) {
      socket.destroy()
      return
    }
    entry.sockets.add(socket)
    entry.conns++
    this.broadcastConnCount()
    socket.once('close', () => {
      entry.sockets.delete(socket)
      entry.conns = Math.max(0, entry.conns - 1)
      this.broadcastConnCount()
    })
    socket.on('error', () => socket.destroy())

    if (tunnel.type === 'local') {
      if (!tunnel.targetHost || !tunnel.targetPort) {
        logWarn(`「${tunnelName(tunnel)}」拒绝了一个入站连接：未配置目标地址`)
        socket.destroy()
        return
      }
      chain.client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        tunnel.targetHost,
        tunnel.targetPort,
        (err, stream) => {
          if (err || !stream) {
            logWarn(
              `「${tunnelName(tunnel)}」入站连接转发失败：无法连接 ${tunnel.targetHost}:${tunnel.targetPort}（${err?.message ?? '通道建立失败'}）`
            )
            socket.destroy()
            return
          }
          this.pipeSocket(stream, socket)
        }
      )
    } else {
      this.handleSocks5(tunnel, chain, socket)
    }
  }

  /**
   * 远程转发（-R）的入站连接：先连本机目标，连上才 accept 通道；
   * 连不上直接 reject —— 服务器侧的外部连接立即被关闭，而不是拖到超时。
   */
  private handleRemoteConnection(
    id: string,
    tunnel: SshTunnel,
    accept: () => ClientChannel,
    reject: () => void
  ): void {
    const entry = this.entries.get(id)
    const name = tunnelName(tunnel)
    if (!entry || !tunnel.targetHost || !tunnel.targetPort) {
      logWarn(`「${name}」拒绝了一个远程转发连接：未配置目标地址`)
      reject()
      return
    }
    const socket = net.connect({ host: tunnel.targetHost, port: tunnel.targetPort })
    let accepted = false
    socket.once('connect', () => {
      accepted = true
      entry.sockets.add(socket)
      entry.conns++
      this.broadcastConnCount()
      socket.once('close', () => {
        entry.sockets.delete(socket)
        entry.conns = Math.max(0, entry.conns - 1)
        this.broadcastConnCount()
      })
      this.pipeSocket(accept(), socket)
    })
    socket.once('error', (err) => {
      // 连上之前出错才 reject（连上之后走 pipeSocket 的销毁链路，通道已确认不能拒）
      if (!accepted) {
        logWarn(
          `「${name}」拒绝了一个远程转发连接：无法连接 ${tunnel.targetHost}:${tunnel.targetPort}（${err.message}）`
        )
        reject()
      }
      socket.destroy()
    })
  }

  /** socket ↔ SSH 通道双向对接：任意一侧出错 / 关闭时销毁另一侧 */
  private pipeSocket(stream: ClientChannel, socket: net.Socket): void {
    socket.on('error', () => stream.destroy())
    stream.on('error', () => socket.destroy())
    socket.on('close', () => stream.destroy())
    stream.on('close', () => socket.destroy())
    socket.pipe(stream)
    stream.pipe(socket)
  }

  /**
   * 最小 SOCKS5 服务（无认证）：greeting → CONNECT 请求 → forwardOut → 回复。
   *
   * 不做用户认证（默认只绑回环地址；界面在绑定非回环地址时要求二次确认）。
   * 只支持 CONNECT，BIND / UDP ASSOCIATE 直接回「不支持」。
   */
  private handleSocks5(tunnel: SshTunnel, chain: ConnectedChain, socket: net.Socket): void {
    socket.once('data', (greeting: Buffer) => {
      if (greeting[0] !== 0x05) {
        socket.destroy()
        return
      }
      // 无需认证（0x00；不选择 0x02 用户口令认证）
      socket.write(Buffer.from([0x05, 0x00]))
      socket.once('data', (req: Buffer) => {
        if (req[0] !== 0x05 || req[1] !== 0x01) {
          // 仅支持 CONNECT 命令
          socket.write(socksReply(0x07))
          socket.destroy()
          return
        }
        const atyp = req[3]
        let host: string
        let offset: number
        if (atyp === 0x01) {
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          const len = req[4]
          host = req.subarray(5, 5 + len).toString('utf8')
          offset = 5 + len
        } else if (atyp === 0x04) {
          const parts: string[] = []
          for (let i = 0; i < 8; i++) parts.push(req.readUInt16BE(4 + i * 2).toString(16))
          host = parts.join(':')
          offset = 20
        } else {
          // 不支持的地址类型
          socket.write(socksReply(0x08))
          socket.destroy()
          return
        }
        if (req.length < offset + 2) {
          socket.write(socksReply(0x07))
          socket.destroy()
          return
        }
        const port = req.readUInt16BE(offset)
        chain.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
          if (err || !stream) {
            // 请求失败（无法连到目标）
            logWarn(
              `「${tunnelName(tunnel)}」SOCKS5 请求失败：无法连接 ${host}:${port}（${err?.message ?? '通道建立失败'}）`
            )
            socket.write(socksReply(0x07))
            socket.destroy()
            return
          }
          // 成功：BND 填 0.0.0.0:0（客户端一般不关心）
          socket.write(socksReply(0x00))
          this.pipeSocket(stream, socket)
        })
      })
    })
    socket.on('error', () => socket.destroy())
  }
}

// ---------------------------------------------------------------------------
// 注册表（放 globalThis，理由见文件头）
// ---------------------------------------------------------------------------

const GLOBAL_KEY = '__FIZZ_SSH_TUNNELS__'

function manager(): TunnelManager {
  const g = globalThis as Record<string, unknown>
  let m = g[GLOBAL_KEY] as TunnelManager | undefined
  if (!m) {
    m = new TunnelManager()
    g[GLOBAL_KEY] = m
  }
  return m
}

export const tunnelManager = manager()

/** 进程收尾用（`shutdown.ts` 在 tsx 侧调，模块缓存不互通，所以走注册表） */
export function stopAllTunnels(): void {
  manager().stopAll()
}

/** 服务启动后拉起 autoStart 隧道（由启动流程调用） */
export function autoStartTunnels(): Promise<void> {
  return manager().autoStart()
}
