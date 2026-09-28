/**
 * SSH 隧道管理：本地转发（等价 ssh -L）、远程转发（等价 ssh -R）与 SOCKS5 动态代理（等价 ssh -D）。
 *
 * 每条隧道持有独立的 SSH 连接（经跳板链则复用统一连接层 connectWithJumps），
 * 与终端会话互不影响：终端断开不影响隧道，反之亦然。
 * 生命周期（start / stop / 删除 / 主机删除联动）由这里统一管理，
 * 状态变化经 'status' 事件交给 IPC 层广播给渲染端。
 *
 * 远程转发（-R）：由链尾服务器的 sshd 监听 bindHost:bindPort（默认仅回环地址可用，
 * 非回环地址需服务端开启 GatewayPorts），外部连接经 SSH 通道回到本进程后，
 * 再转发到 targetHost:targetPort（本机可达）。服务器侧监听随 SSH 连接消亡，
 * 所以连接意外断开时隧道落为 error，而不是挂一个假的「运行中」。
 */
import net from 'node:net'
import { EventEmitter } from 'node:events'
import type { ClientChannel, TcpConnectionDetails } from 'ssh2'
import type { HostLogLevel, SshTunnel, SshTunnelRuntime, SshTunnelStatus } from '@shared/types'
import { connectWithJumps, type ConnectedChain } from './connect'
import { hostLogger } from '../log/logger'
import { storage } from '../storage'

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
  return t.type === 'remote' ? `远程转发 ${bind} → 本机 ${target}` : `本地转发 ${bind} → ${target}`
}

class TunnelManager extends EventEmitter {
  private entries = new Map<string, TunnelEntry>()
  /** starting / error / stopped 等非运行态记录；running 以 entries 为准 */
  private runtime = new Map<string, SshTunnelRuntime>()

  /** 全部隧道的运行态（按配置列表顺序，含未启动的 stopped） */
  list(): SshTunnelRuntime[] {
    return storage.listSshTunnels().map((t) => {
      const entry = this.entries.get(t.id)
      if (entry) {
        return { id: t.id, status: 'running', conns: entry.conns, startedAt: entry.startedAt }
      }
      return this.runtime.get(t.id) ?? { id: t.id, status: 'stopped' }
    })
  }

  isRunning(id: string): boolean {
    return this.entries.has(id)
  }

  private setStatus(id: string, status: SshTunnelStatus, error?: string): void {
    this.runtime.set(id, { id, status, error })
    this.emit('status', this.list())
  }

  private broadcastConnCount(): void {
    this.emit('status', this.list())
  }

  /**
   * 启动隧道。所有失败（配置缺失 / 连接失败 / 端口占用）都落到 error 状态，
   * 不向外抛错 —— 调用方（IPC / autoStart）只看状态事件。
   */
  async start(id: string): Promise<void> {
    if (this.entries.has(id)) return
    const tunnel = storage.listSshTunnels().find((t) => t.id === id)
    if (!tunnel) {
      hostLogger.error('tunnel', `隧道启动失败：配置不存在（id ${id}）`)
      this.setStatus(id, 'error', '隧道配置不存在')
      return
    }
    const name = tunnelName(tunnel)
    const profile = storage.getSshProfile(tunnel.profileId)
    if (!profile) {
      hostLogger.error('tunnel', `「${name}」启动失败：主机配置不存在（可能已被删除）`)
      this.setStatus(id, 'error', '隧道指向的主机配置不存在（可能已被删除）')
      return
    }

    this.setStatus(id, 'starting')
    hostLogger.info('tunnel', `「${name}」启动中：${tunnelRoute(tunnel)}`)
    let chain: ConnectedChain
    try {
      chain = await connectWithJumps(profile, { purpose: 'tunnel' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      hostLogger.error('tunnel', `「${name}」启动失败：${message}`)
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
      hostLogger.error('tunnel', `「${name}」启动失败：监听 ${tunnel.bindHost}:${tunnel.bindPort} 失败：${message}`)
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
    hostLogger.info('tunnel', `「${name}」已启动`)
    this.setStatus(id, 'running')
  }

  /**
   * 远程转发（-R）的启动：请求链尾服务器监听 bindHost:bindPort，外部连接经 SSH
   * 通道回到本进程后再转发到本机 targetHost:targetPort。
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
      hostLogger.error('tunnel', `「${name}」启动失败：${message}`)
      this.setStatus(id, 'error', message)
      return
    }

    // port 与请求值不同 = 服务端分配的端口（请求 0 时）；unforwardIn 必须按实际端口解绑
    entry.remoteBind = { host: tunnel.bindHost, port: bindResult.port }
    this.entries.set(id, entry)
    hostLogger.info('tunnel', `「${name}」已启动`)
    this.setStatus(id, 'running')
  }

  /**
   * 停止隧道：解除监听、销毁转发连接、关闭 SSH 连接。
   * opts.reason 仅用于日志（缺省不带括注）；意外中断（连接断开 / 监听出错）用
   * level='error' 记成错误，正常停止（手动 / 配置变更 / 删除）记 info。
   */
  stop(id: string, opts?: { reason?: string; level?: HostLogLevel }): void {
    const entry = this.entries.get(id)
    if (entry) {
      this.entries.delete(id)
      const tunnel = storage.listSshTunnels().find((t) => t.id === id)
      const name = tunnel ? tunnelName(tunnel) : id
      if (opts?.level === 'error') {
        hostLogger.error('tunnel', `「${name}」${opts.reason ?? '已停止'}`)
      } else {
        hostLogger.info('tunnel', `「${name}」已停止${opts?.reason ? `（${opts.reason}）` : ''}`)
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

  /** 停止所有引用该主机的隧道（主机配置被删除时联动调用） */
  stopByProfile(profileId: string): void {
    for (const tunnel of storage.listSshTunnels()) {
      if (tunnel.profileId === profileId && this.entries.has(tunnel.id)) {
        this.stop(tunnel.id, { reason: '主机配置已删除' })
      }
    }
  }

  /** 应用启动时自动拉起 autoStart 隧道（错开 300ms，失败只落在状态里） */
  async autoStart(): Promise<void> {
    const tunnels = storage.listSshTunnels().filter((t) => t.autoStart)
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
        hostLogger.warn('tunnel', `「${tunnelName(tunnel)}」拒绝了一个入站连接：未配置目标地址`)
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
            hostLogger.warn(
              'tunnel',
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
      hostLogger.warn('tunnel', `「${name}」拒绝了一个远程转发连接：未配置本机目标地址`)
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
        hostLogger.warn(
          'tunnel',
          `「${name}」拒绝了一个远程转发连接：无法连接本机目标 ${tunnel.targetHost}:${tunnel.targetPort}（${err.message}）`
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
   * 不做用户认证（默认只绑回环地址，界面在绑定非回环地址时给出警示）。
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
            hostLogger.warn(
              'tunnel',
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

export const tunnelManager = new TunnelManager()
