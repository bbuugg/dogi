/**
 * 主进程 HTTP 执行器。
 *
 * 插件（pluginHost.http）与内置的「接口请求」功能共用同一份实现：
 * 请求都从渲染端发起、由主进程发出，这样不受渲染进程的 CORS / CSP 限制，
 * 也能访问内网地址与自签证书服务。
 *
 * 语义约定：网络层失败不抛异常，而是返回 status=0 + error，
 * 让调用方只处理一种「拿到结果」的路径。
 */

/** 请求入参（PluginHttpRequest / ApiHttpRequest 的结构超集） */
export interface HttpRequestInput {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  /** 超时（毫秒） */
  timeoutMs?: number
  /** 跳过 TLS 证书校验（自签证书） */
  rejectUnauthorized?: boolean
  /** 代理地址，如 http://127.0.0.1:7890 */
  proxy?: string
}

export interface HttpResult {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  timeMs: number
  error?: string
}

/**
 * 用 Node 全局 fetch 执行请求；支持超时、代理与跳过 TLS 校验（需要 undici，
 * 若运行环境无 undici 则忽略代理/不安全 TLS 选项，回退到普通 fetch）。
 *
 * signal：外部取消信号（如接口请求页的「取消」按钮）。与内部超时共用一个
 * AbortController：外部信号中止时同样中止 fetch，走 catch 返回 status=0 + error。
 */
export async function executeHttp(req: HttpRequestInput, signal?: AbortSignal): Promise<HttpResult> {
  const start = performance.now()
  const ctrl = new AbortController()
  const timer =
    req.timeoutMs && req.timeoutMs > 0 ? setTimeout(() => ctrl.abort(), req.timeoutMs) : null
  const onExternalAbort = (): void => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const init: RequestInit = {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
    signal: ctrl.signal
  }
  // 代理 / 自签证书 / 关闭底层默认超时：尝试使用 undici 构造 dispatcher
  //（非必需依赖，缺失时降级为普通 fetch）。
  // 注意：Node 全局 fetch 底层是 undici，默认自带 headersTimeout / bodyTimeout
  // 各 300 秒 —— 长请求会被它静默掐断（"Headers Timeout Error"），与调用方设的
  // 超时无关。所以未指定 timeoutMs 时必须显式把这两个上限关掉，才谈得上「永不超时」。
  try {
    const undici = (await import('undici').catch(() => null)) as
      | { Agent: new (o: unknown) => unknown; ProxyAgent: new (p: string) => unknown }
      | null
    if (undici) {
      if (req.proxy) {
        ;(init as { dispatcher?: unknown }).dispatcher = new undici.ProxyAgent(req.proxy)
      } else {
        const opts: Record<string, unknown> = {}
        if (req.rejectUnauthorized === false) {
          opts.connect = { rejectUnauthorized: false }
        }
        if (!req.timeoutMs || req.timeoutMs <= 0) {
          // 0 = 关闭超时（undici 文档约定）
          opts.headersTimeout = 0
          opts.bodyTimeout = 0
        }
        // 只有确有自定义需求时才替换 dispatcher，否则走默认（行为与原生 fetch 一致）
        if (Object.keys(opts).length) {
          ;(init as { dispatcher?: unknown }).dispatcher = new undici.Agent(opts)
        }
      }
    }
  } catch {
    // 忽略：无 undici 时走默认 dispatcher
  }
  try {
    const res = await fetch(req.url, init)
    const body = await res.text()
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k] = v
    })
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers,
      body,
      timeMs: Math.round(performance.now() - start)
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      headers: {},
      body: '',
      timeMs: Math.round(performance.now() - start),
      error: e instanceof Error ? e.message : String(e)
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }
}
