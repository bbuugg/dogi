/**
 * 服务端 HTTP 执行器（迁自 dogi 的 `main/services/api/http.ts`）。
 *
 * 「接口请求」功能由**服务端**发请求（渲染端受 CORS 限制，也访问不到内网自签证书服务），
 * 与 dogi「主进程发请求」语义等价。语义约定：网络层失败不抛异常，而是返回 `status: 0 + error`，
 * 让调用方只处理一种「拿到结果」的路径。
 *
 * 与 dogi 的差别只有两处：
 * 1. 去掉主进程专用的 `proxy`（服务端不提供代理配置）；
 * 2. `form-data` 的文件字段不再读本地路径 —— 渲染端把文件读成 base64 随载荷上送，
 *    这里 `Buffer.from(base64)` 解码后作为 multipart 的文件部分。
 */
import { STATUS_CODES } from 'node:http'
import { extname } from 'node:path'
import type {
  ApiBodyType,
  ApiHttpRequest,
  ApiHttpResponse
} from '@fizz/contracts/types'

/**
 * 进行中的 HTTP 请求：`sendId → controller`（渲染端每次 `send` 带一个自生成的 sendId，
 * 点「取消」时按它中断对应请求；请求结束无论成败立即移除，避免 Map 无限增长）。
 */
export const inflightHttp = new Map<string, AbortController>()

/** undici 的最小类型（仅用到的部分），避免硬依赖其类型声明 */
type UndiciModule = {
  Agent: new (o: Record<string, unknown>) => unknown
  request: (
    url: string,
    init: Record<string, unknown>
  ) => Promise<{
    statusCode: number
    headers: { forEach: (cb: (v: string, k: string) => void) => void }
    body: AsyncIterable<Buffer | string>
  }>
}

/**
 * 补全协议头：用户输入的地址常不带 http(s)://（如直接填 api.example.com/users），
 * Node 全局 fetch 必须有协议，否则直接抛 TypeError: Invalid URL。
 * 仅当完全没有 http/https 协议时才补 http://；已有其它协议（如 ftp://）原样保留。
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

function mimeOfFile(fileName: string): string {
  return MIME_BY_EXT[extname(fileName).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 严格 base64 形状校验。`Buffer.from(x, 'base64')` 是**宽容解码**：非法字符被静默丢弃，
 * 结果是一段脏字节却不报错。所以先卡形状（标准表 + 正确 padding），不合格直接判失败。
 */
function decodeBase64Strict(value: string): Buffer | null {
  const normalized = value.trim()
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    return null
  }
  return Buffer.from(normalized, 'base64')
}

/** prepareBody 的结果 */
interface PreparedBody {
  body?: RequestInit['body']
  /**
   * 对 Content-Type 的处理：
   * - 字符串 = 覆盖成它；- `null` = 删掉（交给运行时按 boundary 生成）；- `undefined` = 不动。
   */
  contentType?: string | null
  /** 准备阶段就失败（文件没选 / 内容缺失）时的错误，直接当请求失败回给调用方 */
  error?: string
}

/**
 * 按请求体类型准备真正发出去的 body。
 *
 * - `none`：**不带 body**（Content-Type 也原样不动）；
 * - `raw`：正文原样用 `body`，Content-Type 完全由调用方（请求头）决定；
 * - `x-www-form-urlencoded`：键值对经 `URLSearchParams` 序列化；请求头里**没有** Content-Type
 *   时补标准的那个，调用方显式写了（比如带 charset）就不动它；
 * - `form-data`：键值对灌进 `FormData`（文件字段用 `dataBase64` 解码），**必须**让运行时生成
 *   带 boundary 的 Content-Type —— 调用方请求头里那份（没有 boundary）一律删掉。
 *
 * 两张表都跳过 `enabled === false` 的行（界面上「停用」的字段照旧留在表里，只是不发）。
 * 这里是**唯一**的执行点：渲染端只负责把开关带上来，别指望它顺手把停用行删掉。
 */
async function prepareBody(req: ApiHttpRequest): Promise<PreparedBody> {
  const mode: ApiBodyType = req.bodyType ?? 'raw'
  if (mode === 'none') return {}
  if (mode === 'x-www-form-urlencoded') {
    const params = new URLSearchParams()
    for (const f of req.urlencoded ?? []) {
      if (f?.enabled === false) continue
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
      if (f?.enabled === false) continue
      const key = (f?.key ?? '').trim()
      if (!key) continue
      if (f?.isFile) {
        const data = typeof f.dataBase64 === 'string' ? f.dataBase64.trim() : ''
        if (!data) return { error: `表单字段「${key}」还没有选择文件（或文件内容未随请求上送）` }
        const bytes = decodeBase64Strict(data)
        if (!bytes) return { error: `表单字段「${key}」的文件内容不是合法 base64` }
        const fileName = (f.fileName ?? '').trim() || 'file'
        form.append(key, new Blob([new Uint8Array(bytes)], { type: mimeOfFile(fileName) }), fileName)
      } else {
        form.append(key, String(f?.value ?? ''))
      }
    }
    return { body: form, contentType: null }
  }
  return { body: req.body }
}

/** 按请求选项构造 undici 的 dispatcher（跳过 TLS 校验 / 关闭底层超时）。无 undici 时返回空。 */
function buildUndiciDispatcher(
  undici: UndiciModule,
  req: ApiHttpRequest
): { dispatcher?: unknown } {
  const opts: Record<string, unknown> = {}
  if (req.rejectUnauthorized === false) opts.connect = { rejectUnauthorized: false }
  // 未指定超时：关掉 undici 自带的 300s 上限（否则长请求静默被掐断）
  if (!req.timeoutMs || req.timeoutMs <= 0) {
    opts.headersTimeout = 0
    opts.bodyTimeout = 0
  }
  if (Object.keys(opts).length) return { dispatcher: new undici.Agent(opts) }
  return {}
}

/**
 * 执行一次 HTTP 请求；`signal` 是外部取消信号（接口请求页的「取消」按钮）。
 * 与内部超时共用一个 AbortController：外部中止时同样中止 fetch，走 catch 返回 `status: 0 + error`。
 */
export async function executeHttp(
  req: ApiHttpRequest,
  signal?: AbortSignal
): Promise<ApiHttpResponse> {
  const start = performance.now()
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
  const method = String(req.method || 'GET').toUpperCase()
  const reqHeaders: Record<string, string> = { ...(req.headers ?? {}) }
  const done = (
    ok: boolean,
    status: number,
    statusText: string,
    headers: Record<string, string>,
    body: string
  ): ApiHttpResponse => ({
    ok,
    status,
    statusText,
    headers,
    body,
    timeMs: Math.round(performance.now() - start)
  })
  const fail = (msg: string): ApiHttpResponse => ({
    ok: false,
    status: 0,
    statusText: '',
    headers: {},
    body: '',
    timeMs: Math.round(performance.now() - start),
    error: msg
  })

  try {
    const undici = (await import('undici').catch(() => null)) as UndiciModule | null
    const prepared = await prepareBody(req)
    if (prepared.error) return fail(prepared.error)
    if (prepared.contentType === null) dropHeader(reqHeaders, 'content-type')
    else if (prepared.contentType) reqHeaders['Content-Type'] = prepared.contentType
    const hasBody = prepared.body !== undefined

    // GET / HEAD 带 body：Node 全局 fetch 的 Request 构造会拒绝
    // （抛 “Request with GET/HEAD method cannot have body”），所以这一支改用 undici.request
    //（更底层，不强制该限制）把 body 发出去。
    if ((method === 'GET' || method === 'HEAD') && hasBody && undici) {
      const { dispatcher } = buildUndiciDispatcher(undici, req)
      const ures = await undici.request(targetUrl, {
        method: req.method,
        headers: reqHeaders,
        body: prepared.body as never,
        signal: ctrl.signal,
        dispatcher
      } as Record<string, unknown>)
      const headers: Record<string, string> = {}
      ures.headers.forEach((v, k) => {
        headers[k] = v
      })
      let bodyText = ''
      for await (const chunk of ures.body) {
        bodyText += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      }
      const status = ures.statusCode
      return done(status >= 200 && status < 300, status, STATUS_CODES[status] ?? '', headers, bodyText)
    }

    // 其余情况（含 GET/HEAD 不带 body）走原生 fetch
    const init: RequestInit = {
      method: req.method,
      headers: reqHeaders,
      signal: ctrl.signal
    }
    if (hasBody) (init as { body?: unknown }).body = prepared.body
    if (undici) {
      const { dispatcher } = buildUndiciDispatcher(undici, req)
      ;(init as { dispatcher?: unknown }).dispatcher = dispatcher
    }
    const res = await fetch(targetUrl, init)
    const body = await res.text()
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k] = v
    })
    return done(res.ok, res.status, res.statusText, headers, body)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }
}