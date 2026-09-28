/**
 * 统一 SSH 连接层：终端会话 / Mosh 引导 / SFTP / 隧道都从这里建立连接。
 *
 * 职责：
 * - 解析跳板链（jumpProfileId 逐级跟随），经上一跳的 direct-tcpip 通道接入下一跳
 *   （等价 `ssh -J` / ProxyJump），成环 / 超深 / 引用已删配置都给出明确报错；
 * - 每一跳都做主机指纹校验（TOFU：首连静默记录，之后指纹必须一致）；
 * - 连接中途失败时保证已建立的中间连接全部收尾，不留半截跳板连接。
 *
 * 渲染端看不到这里的一切：凭据与指纹明细只在主进程流转。
 */
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { Client, type ConnectConfig } from 'ssh2'
import type { SshConnectStage, SshProfile } from '@shared/types'
import { hostLogger } from '../log/logger'
import { storage } from '../storage'

/** 跳板链最大深度（含目标本身）；病态配置直接拒绝而不是无限展开 */
const MAX_CHAIN_DEPTH = 8

/** 与历史行为一致（原先散落在 sessions.ts / sftp.ts 的字面量） */
const DEFAULT_KEEPALIVE_MS = 15000
const READY_TIMEOUT_MS = 20000

/** 连接发起方（仅用于日志文案，让「谁在连」一目了然） */
export type ConnectPurpose = 'terminal' | 'mosh' | 'sftp' | 'tunnel' | 'test'

const PURPOSE_LABEL: Record<ConnectPurpose, string> = {
  terminal: '终端会话',
  mosh: 'Mosh 引导',
  sftp: 'SFTP',
  tunnel: 'SSH 隧道',
  test: '连接测试'
}

/** 连接阶段上报（SshSession 转发为 terminal:status；detail 标注当前是哪一跳） */
export type StageReporter = (stage: SshConnectStage, detail?: string) => void

export interface ConnectedChain {
  /** 目标主机（链尾）的已就绪连接：shell / sftp / forwardOut 都在它上面开 */
  client: Client
  /** 关闭整条链（逐跳 end；根断开时下游自然失效） */
  dispose: () => void
}

/**
 * 解析跳板链：根跳板在前、目标主机在最后。
 * 逐级跟随 jumpProfileId；成环 / 超深 / 引用不存在的配置同步抛错（错误信息直接展示给用户）。
 */
function resolveChain(profile: SshProfile): SshProfile[] {
  const chain: SshProfile[] = [profile]
  const visited = new Set([profile.id])
  let cursor = profile
  while (cursor.jumpProfileId) {
    if (chain.length >= MAX_CHAIN_DEPTH) {
      throw new Error(`跳板链超过 ${MAX_CHAIN_DEPTH} 层，请检查主机配置`)
    }
    if (visited.has(cursor.jumpProfileId)) {
      throw new Error('跳板链存在循环引用，请检查各主机的跳板设置')
    }
    const next = storage.getSshProfile(cursor.jumpProfileId)
    if (!next) throw new Error('跳板机配置不存在（可能已被删除），请编辑主机重新设置')
    if (next.kind !== 'ssh') throw new Error(`跳板机「${next.name}」不是 SSH 主机`)
    visited.add(next.id)
    chain.unshift(next)
    cursor = next
  }
  return chain
}

/** 主机密钥 blob 的 SHA256 指纹（base64 无填充，与 OpenSSH SHA256: 展示风格一致） */
function fingerprintOf(keyBlob: Buffer): string {
  return createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')
}

/** 从密钥 blob 解析算法名（blob 开头是 uint32 长度 + 算法字符串） */
function algoOf(keyBlob: Buffer): string {
  try {
    const len = keyBlob.readUInt32BE(0)
    if (len <= 0 || len > 64 || 4 + len > keyBlob.length) return 'unknown'
    return keyBlob.subarray(4, 4 + len).toString('utf8') || 'unknown'
  } catch {
    return 'unknown'
  }
}

interface HostKeyCheck {
  verifier: (keyBlob: Buffer) => boolean
  /** 最近一次因指纹不符被拒的详细说明（ssh2 自身的报错太笼统，转述这个） */
  mismatchDetail: () => string | null
}

/**
 * 主机指纹校验（TOFU）：
 * - 首次连接：静默记录并放行 —— 握手发生在主进程里，中途弹「是否信任」会拖出
 *   一套「挂起 + 广播 + 回填」的流程；首连信任 + 之后任何变化硬失败，
 *   已覆盖「首次之后被劫持」的风险面。
 * - 已记录：指纹必须一致；不一致拒绝，并给出双方指纹与重置入口。
 */
function createHostKeyCheck(host: string, port: number): HostKeyCheck {
  let mismatch: string | null = null
  const verifier = (keyBlob: Buffer): boolean => {
    const fingerprint = fingerprintOf(keyBlob)
    const known = storage.listSshKnownHosts().find((k) => k.host === host && k.port === port)
    if (!known) {
      const algo = algoOf(keyBlob)
      storage.recordSshKnownHost({
        host,
        port,
        algo,
        fingerprint,
        addedAt: Date.now()
      })
      hostLogger.info(
        'ssh',
        `首次连接 ${host}:${port}，已记录主机指纹（${algo} SHA256:${fingerprint}）`
      )
      return true
    }
    if (known.fingerprint === fingerprint) return true
    mismatch =
      `主机指纹校验失败：${host}:${port} 的密钥指纹与记录不符（记录 ${known.fingerprint}，` +
      `实际 ${fingerprint}）。如确认服务器未变更（例如重装过系统），` +
      '请在主机右键菜单「重置主机指纹」后重试。'
    return false
  }
  return { verifier, mismatchDetail: () => mismatch }
}

/** 单跳连接参数（凭据 + 指纹校验 + 可选 sock：跳板转发通道） */
function buildHopConfig(
  hop: SshProfile,
  check: HostKeyCheck,
  sock?: Duplex
): ConnectConfig {
  const config: ConnectConfig = {
    host: hop.host,
    port: hop.port || 22,
    username: hop.username,
    keepaliveInterval: hop.keepaliveInterval || DEFAULT_KEEPALIVE_MS,
    readyTimeout: READY_TIMEOUT_MS,
    hostVerifier: check.verifier
  }
  if (hop.authType === 'privateKey' && hop.privateKey) {
    config.privateKey = hop.privateKey
    if (hop.passphrase) config.passphrase = hop.passphrase
  } else if (hop.password) {
    config.password = hop.password
  }
  if (sock) config.sock = sock
  return config
}

/**
 * 建立到目标主机的连接（必要时经跳板链）。
 *
 * 单跳（无跳板）时连接序列与历史行为完全一致：handshake → authenticating → ready。
 * 多跳时每跳重放该序列，且带 detail 标注「第 N/M 跳：user@host」，渲染端据此展示进度。
 */
export async function connectWithJumps(
  profile: SshProfile,
  opts?: { onStage?: StageReporter; purpose?: ConnectPurpose }
): Promise<ConnectedChain> {
  const chain = resolveChain(profile)
  const total = chain.length
  const clients: Client[] = []
  /** 日志文案前缀（连接 / 成功 / 失败都带，便于按来源过滤） */
  const purposeLabel = opts?.purpose ? PURPOSE_LABEL[opts.purpose] : 'SSH'

  const dispose = (): void => {
    for (const client of clients) {
      try {
        client.end()
      } catch {
        // 可能已在失败流程中关闭
      }
    }
  }

  const hopDetail = (hop: SshProfile, hopIndex: number): string | undefined =>
    total > 1 ? `第 ${hopIndex + 1}/${total} 跳：${hop.username}@${hop.host}` : undefined

  /** 连接单跳；返回 ready 的 Client。sock 为上一跳开出的转发通道（首跳为空） */
  const connectHop = (
    hop: SshProfile,
    hopIndex: number,
    sock?: Duplex
  ): Promise<Client> =>
    new Promise<Client>((resolve, reject) => {
      const check = createHostKeyCheck(hop.host, hop.port || 22)
      const client = new Client()
      clients.push(client)
      let settled = false
      const startedAt = Date.now()
      const hopSuffix = total > 1 ? `（第 ${hopIndex + 1}/${total} 跳）` : ''
      hostLogger.info(
        'ssh',
        `[${purposeLabel}] 正在连接 ${hop.username}@${hop.host}:${hop.port || 22}${hopSuffix}`
      )
      const fail = (err: Error | string): void => {
        if (settled) return
        settled = true
        const e = err instanceof Error ? err : new Error(err)
        hostLogger.error('ssh', `[${purposeLabel}] ${e.message}`)
        reject(e)
      }
      const detail = hopDetail(hop, hopIndex)
      client
        .on('connect', () => opts?.onStage?.('handshake', detail))
        .on('handshake', () => opts?.onStage?.('authenticating', detail))
        .on('ready', () => {
          settled = true
          hostLogger.info(
            'ssh',
            `[${purposeLabel}] 已连接 ${hop.username}@${hop.host}:${hop.port || 22}${hopSuffix}（${Date.now() - startedAt}ms）`
          )
          resolve(client)
        })
        .on('error', (err: Error) => {
          // 指纹不符时用我们自己的详细说明替代 ssh2 的笼统报错
          const mismatch = check.mismatchDetail()
          if (mismatch) {
            fail(mismatch)
            return
          }
          if (hopIndex === 0) {
            fail(err.message)
            return
          }
          const via = chain[hopIndex - 1]
          fail(`经跳板机 ${via.username}@${via.host} 连接 ${hop.host}:${hop.port || 22} 失败：${err.message}`)
        })
        .on('close', () => fail('连接在建立过程中被关闭'))
        .connect(buildHopConfig(hop, check, sock))
    })

  let upstream: Duplex | undefined
  let lastClient: Client | null = null
  try {
    for (let i = 0; i < total; i++) {
      const hop = chain[i]
      const detail = hopDetail(hop, i)
      if (i > 0) {
        // 经上一跳开一条到本跳的 direct-tcpip 通道，作为本跳的 sock
        opts?.onStage?.('resolving', detail)
        const via = chain[i - 1]
        upstream = await new Promise<Duplex>((resolve, reject) => {
          lastClient!.forwardOut('127.0.0.1', 0, hop.host, hop.port || 22, (err, stream) => {
            if (err || !stream) {
              reject(
                new Error(
                  `经跳板机 ${via.username}@${via.host} 无法连接 ${hop.host}:${hop.port || 22}：` +
                    `${err?.message ?? '通道建立失败'}`
                )
              )
              return
            }
            resolve(stream)
          })
        })
      } else if (total > 1) {
        // 单跳时阶段事件与历史行为保持一致（resolving 由会话层自己上报，避免重复）
        opts?.onStage?.('resolving', detail)
      }
      lastClient = await connectHop(hop, i, upstream)
    }
  } catch (err) {
    dispose()
    throw err instanceof Error ? err : new Error(String(err))
  }

  return { client: clients[clients.length - 1], dispose }
}
