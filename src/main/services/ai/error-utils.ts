/**
 * 把错误转成可读字符串，同时把完整 cause 链打到 console。
 *
 * 原来各处的 describeError 只取 err.message，导致 AI SDK 外层抛的
 * "Failed to process successful response" 把真实原因（连接中途中断 / 网关超时 /
 * SSE 某行解析失败 / schema 校验失败）整个吞掉，界面上永远只看到那句空泛提示，
 * 无法定位。这里把整条 cause 链 + code / statusCode / url / data 都暴露出来：
 * - 界面上能看到真实底层错误（如 "socket hang up" / "UND_ERR_BODY_TIMEOUT" / TypeValidationError）
 * - console 里有完整 stack 供深入排查
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) {
    const s = String(err)
    console.error('[describeError] 非 Error 对象:', s)
    return s
  }

  const chain: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 6 && cur instanceof Error; i++) {
    const e = cur as Error & {
      code?: unknown
      statusCode?: unknown
      url?: string
      data?: unknown
    }
    let line = `${e.name}: ${e.message}`
    const extras: string[] = []
    if (e.code !== undefined) extras.push(`code=${String(e.code)}`)
    if (e.statusCode !== undefined) extras.push(`status=${String(e.statusCode)}`)
    if (e.url) extras.push(`url=${e.url}`)
    if (e.data !== undefined) extras.push(`data=${safeStringify(e.data)}`)
    if (extras.length) line += ` (${extras.join(', ')})`
    chain.push(line)
    cur = (e as { cause?: unknown }).cause
  }

  console.error(
    '[describeError] 错误链:\n' +
      chain.map((c, i) => '  '.repeat(i) + '↳ ' + c).join('\n') +
      '\nstack:\n' +
      (err.stack ?? '(无 stack)')
  )

  // 界面上用箭头串起整条链，至少第一行就是真实底层错误
  return chain.join('  ↳  ')
}

function safeStringify(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s && s.length > 500 ? s.slice(0, 500) + '…' : (s ?? String(v))
  } catch {
    return String(v)
  }
}

/**
 * 判断一个错误是否「可重试的网络中断」——这类错误重发同一条消息通常能成功，
 * 适合在界面给出「重试」入口（而不是把整轮丢给用户重输）。
 *
 * 判定依据（沿 cause 链向上找）：
 * - AI SDK 的 `APICallError.isRetryable === true`（网关返回 5xx / 429 时也会置位）
 * - 经典断流信号：`code === 'ECONNRESET'` / `'ETIMEDOUT'` / `'UND_ERR_BODY_TIMEOUT'`
 * - undici 在 TLS 连接被对端中途掐掉时报的 `TypeError: terminated`
 */
export function isRetryableNetworkError(err: unknown): boolean {
  let cur: unknown = err
  for (let i = 0; i < 6 && cur instanceof Error; i++) {
    const e = cur as Error & {
      code?: string
      isRetryable?: boolean
      statusCode?: number
    }
    if (e.isRetryable === true) return true
    if (
      e.code === 'ECONNRESET' ||
      e.code === 'ETIMEDOUT' ||
      e.code === 'UND_ERR_BODY_TIMEOUT' ||
      e.code === 'ENOTFOUND'
    ) {
      return true
    }
    if (e.message === 'terminated') return true
    cur = (e as { cause?: unknown }).cause
  }
  return false
}
