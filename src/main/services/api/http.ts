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
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ApiBodyType, ApiFormField, ApiHeaderPair } from '@shared/types'

/** 请求入参（PluginHttpRequest / ApiHttpRequest 的结构超集） */
export interface HttpRequestInput {
  method: string
  url: string
  headers?: Record<string, string>
  /** `raw` 模式的正文（`bodyType` 缺省 / 'raw' 时使用） */
  body?: string
  /** 请求体类型，缺省 `raw`（与历史行为一致）；另两种形态的字段见下面两项 */
  bodyType?: ApiBodyType
  /** `x-www-form-urlencoded` 的键值对 */
  urlencoded?: ApiHeaderPair[]
  /** `form-data` 的字段；`isFile` 字段由主进程读本地文件作为文件部分 */
  formFields?: ApiFormField[]
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
/**
 * 补全协议头：用户输入的地址常不带 http(s)://（如直接填 api.example.com/users），
 * Node 全局 fetch 必须有协议，否则直接抛 TypeError: Invalid URL。
 * 仅当完全没有 http/https 协议时才补 http://；已有的其它协议（如 ftp://）原样保留，不强行改。
 */
function withProtocol(url: string): string {
  if (!/^https?:\/\//i.test(url)) return 'http://' + url
  return url
}

/** 请求头名大小写不敏感地判断是否存在（HTTP 头名本就大小写不敏感） */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((k) => k.toLowerCase() === lower)
}

/** 请求头名大小写不敏感地删除（multipart 要丢掉调用方写的 Content-Type） */
function dropHeader(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) delete headers[k]
  }
}

/** 常见本地文件类型（multipart 文件部分的 Content-Type）；认不出的扩展名用 application/octet-stream */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

function mimeOfFile(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** prepareBody 的结果 */
interface PreparedBody {
  body?: RequestInit['body']
  /**
   * 对 Content-Type 的处理：
   * - 字符串 = 覆盖成它；- `null` = 删掉（交给运行时按 boundary 生成）；- `undefined` = 不动。
   */
  contentType?: string | null
  /** 准备阶段就失败（文件缺失/读不了）时的错误，直接当请求失败回给调用方 */
  error?: string
}

/**
 * 按请求体类型准备真正发出去的 body。
 *
 * - `none`：**不带 body**（Content-Type 也原样不动，用户自己填的那份头保持原样）；
 * - `raw`：正文原样用 `body`，Content-Type 完全由调用方（请求头）决定 —— 与历史行为一致；
 * - `x-www-form-urlencoded`：键值对经 `URLSearchParams` 序列化（空格成 `+`、非 ASCII 百分号编码，
 *   就是该编码的标准形态）；请求头里**没有** Content-Type 时补标准的那个，
 *   调用方显式写了（比如带 charset）就不动它；
 * - `form-data`：键值对灌进 `FormData`（文件字段读本地文件），**必须**让运行时生成
 *   带 boundary 的 Content-Type —— 调用方请求头里那份（没有 boundary）一律删掉，
 *   否则服务端按它解析会把整个 body 当垃圾。
 */
async function prepareBody(req: HttpRequestInput): Promise<PreparedBody> {
  const mode = req.bodyType ?? 'raw'
  if (mode === 'none') return {}
  if (mode === 'x-www-form-urlencoded') {
    const params = new URLSearchParams()
    for (const f of req.urlencoded ?? []) {
      const key = (f?.key ?? '').trim()
      if (!key) continue
      params.append(key, f?.value ?? '')
    }
    const contentType = hasHeader(req.headers ?? {}, 'content-type')
      ? undefined
      : 'application/x-www-form-urlencoded'
    return { body: params.toString(), contentType }
  }
  if (mode === 'form-data') {
    const form = new FormData()
    for (const f of req.formFields ?? []) {
      const key = (f?.key ?? '').trim()
      if (!key) continue
      const value = String(f?.value ?? '')
      if (f?.isFile) {
        if (!value.trim()) return { error: `表单字段「${key}」还没有选择文件` }
        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(await readFile(value))
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          return { error: `读取文件失败（表单字段「${key}」）：${value} —— ${reason}` }
        }
        form.append(key, new Blob([bytes], { type: mimeOfFile(value) }), basename(value))
      } else {
        form.append(key, value)
      }
    }
    return { body: form, contentType: null }
  }
  return { body: req.body }
}

export async function executeHttp(req: HttpRequestInput, signal?: AbortSignal): Promise<HttpResult> {
  const start = performance.now()
  // 空地址：fetch 同样会抛 Invalid URL，这里先给出人类可读的错误。
  if (!req.url || !req.url.trim()) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      headers: {},
      body: '',
      timeMs: Math.round(performance.now() - start),
      error: '请填写请求地址'
    }
  }
  const targetUrl = withProtocol(req.url.trim())
  const ctrl = new AbortController()
  const timer =
    req.timeoutMs && req.timeoutMs > 0 ? setTimeout(() => ctrl.abort(), req.timeoutMs) : null
  const onExternalAbort = (): void => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  // 请求体形态：GET / HEAD 不带 body（与历史行为一致）。
  // 请求头**必须复制一份**：form-data 要删掉调用方写的 Content-Type，
  // 不能就地改调用方的对象（历史记录 / 重发都还指着它）。
  const method = String(req.method || '').toUpperCase()
  const reqHeaders: Record<string, string> = { ...(req.headers ?? {}) }
  const init: RequestInit = {
    method: req.method,
    headers: reqHeaders,
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
    if (method !== 'GET' && method !== 'HEAD') {
      const prepared = await prepareBody(req)
      // 准备失败（文件没选 / 读不到）也走「status=0 + error」这一条路径
      if (prepared.error) {
        return {
          ok: false,
          status: 0,
          statusText: '',
          headers: {},
          body: '',
          timeMs: Math.round(performance.now() - start),
          error: prepared.error
        }
      }
      if (prepared.contentType === null) dropHeader(reqHeaders, 'content-type')
      else if (prepared.contentType) reqHeaders['Content-Type'] = prepared.contentType
      init.body = prepared.body
    }
    const res = await fetch(targetUrl, init)
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
