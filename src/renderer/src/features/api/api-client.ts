/**
 * 「接口请求」功能的纯函数工具集（无 React / 无副作用）。
 *
 * 从原 api-client 插件的 App.tsx 中抽出，供侧边栏列表（ApiPanel）与
 * 请求编辑页（ApiPage）共用：请求头补全、cURL 解析、响应体格式化等。
 */
import type { ApiBodyType, ApiFormField, ApiHeaderPair } from '@shared/types'

/** 支持的 HTTP 方法（下拉选项顺序即展示顺序） */
export const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']

/**
 * 请求体类型（横向分段选项的顺序）。
 * `raw` 是缺省形态 —— 历史数据没有 `bodyType` 字段，都按它处理（不是 none）。
 */
export const BODY_TYPES: Array<{ value: ApiBodyType; label: string }> = [
  { value: 'none', label: 'none' },
  { value: 'raw', label: 'raw' },
  { value: 'x-www-form-urlencoded', label: 'x-www-form-urlencoded' },
  { value: 'form-data', label: 'form-data' }
]

/**
 * 某种请求体类型对应的标准 Content-Type。
 * `none` 与 `raw` 都返回 null —— 前者根本不发 body，后者的正文可以是任何东西，
 * 它们的 Content-Type 完全由用户填的请求头决定（编辑器高亮语言也跟着那份请求头走，见 bodyLanguageOf）。
 */
export function contentTypeForBodyType(type: ApiBodyType): string | null {
  if (type === 'x-www-form-urlencoded') return 'application/x-www-form-urlencoded'
  if (type === 'form-data') return 'multipart/form-data'
  return null
}

/** 是否为「表单类」的 Content-Type（切换请求体类型时用来判断旧值要不要一起换掉） */
export function isFormContentType(value: string): boolean {
  const ct = String(value || '')
    .trim()
    .toLowerCase()
  return ct.startsWith('multipart/form-data') || ct.startsWith('application/x-www-form-urlencoded')
}

/** 常见请求头名称（输入框下拉补全用） */
export const COMMON_HEADERS = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Connection',
  'Content-Type',
  'Cookie',
  'If-None-Match',
  'Origin',
  'Referer',
  'User-Agent',
  'X-Api-Key',
  'X-Requested-With'
]

const COMMON_MIME_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'application/xml',
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/javascript',
  'text/plain',
  'text/html',
  'text/css',
  'text/csv',
  'text/xml',
  'multipart/form-data',
  '*/*'
]

/** 按请求头名称给出常见取值（键为小写头名） */
const HEADER_VALUE_SUGGESTIONS: Record<string, string[]> = {
  'content-type': COMMON_MIME_TYPES,
  accept: COMMON_MIME_TYPES,
  'accept-encoding': ['gzip', 'deflate', 'br', 'identity', '*/*'],
  'accept-language': [
    'zh-CN',
    'zh-CN,zh;q=0.9',
    'en-US',
    'en-US,en;q=0.9',
    'zh-CN,zh;q=0.9,en;q=0.8',
    '*'
  ],
  'accept-charset': ['UTF-8', 'ISO-8859-1', 'UTF-8,ISO-8859-1;q=0.8'],
  authorization: ['Bearer ', 'Basic ', 'Token '],
  'cache-control': [
    'no-cache',
    'no-store',
    'max-age=0',
    'max-age=3600',
    'public',
    'private',
    'must-revalidate'
  ],
  connection: ['keep-alive', 'close', 'Upgrade'],
  pragma: ['no-cache'],
  'if-none-match': ['*'],
  'x-requested-with': ['XMLHttpRequest'],
  'content-encoding': ['gzip', 'deflate', 'br', 'identity'],
  origin: ['http://localhost:5174', 'https://example.com'],
  'upgrade-insecure-requests': ['1'],
  dnt: ['1', '0'],
  'sec-fetch-mode': ['cors', 'navigate', 'no-cors', 'same-origin'],
  'sec-fetch-site': ['same-origin', 'cross-site', 'same-site', 'none']
}

/** 某个请求头可选的常见取值；没有建议时返回 null（界面据此不显示补全） */
export function headerValueSuggestions(key: string): string[] | null {
  const k = String(key || '')
    .trim()
    .toLowerCase()
  if (!k) return null
  return HEADER_VALUE_SUGGESTIONS[k] || null
}

/** 空白请求头行（新建请求 / 删空后补一行，让界面始终有可编辑的行） */
export function emptyHeader(): ApiHeaderPair {
  return { key: '', value: '' }
}

/** 请求头行是否为「空槽位」（名称与值都没填） */
export function isBlankHeader(p: ApiHeaderPair): boolean {
  return !(p?.key ?? '').trim() && !(p?.value ?? '').trim()
}

/**
 * 编辑请求头后的整理规则（取代原来那个「添加请求头」按钮）：
 * - 末行填了内容 → 自动在下面补一个空槽位，接着往下填就行；
 * - 末尾连续多个空槽位 → 只留一个（否则给末行填了名字又清掉，空行会越积越多）；
 * - 列表为空时保留一行，表格永远至少有一个可输入的行。
 */
export function tidyHeaderRows(list: ApiHeaderPair[]): ApiHeaderPair[] {
  const next = list.length ? [...list] : [emptyHeader()]
  if (!isBlankHeader(next[next.length - 1])) next.push(emptyHeader())
  while (
    next.length > 1 &&
    isBlankHeader(next[next.length - 1]) &&
    isBlankHeader(next[next.length - 2])
  ) {
    next.pop()
  }
  return next
}

/** 键值对数组 → 请求头对象（跳过空键，值两侧去空格） */
export function pairsToHeaders(pairs: ApiHeaderPair[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs || []) {
    const k = (p.key || '').trim()
    if (!k) continue
    out[k] = (p.value || '').trim()
  }
  return out
}

/**
 * 把历史/导入来的请求头规整成可编辑的键值对数组：
 * 兼容数组形态与旧的「每行 name: value」文本形态，且至少返回一行。
 */
export function normalizeHeaders(raw: unknown): ApiHeaderPair[] {
  if (Array.isArray(raw)) {
    const pairs = raw
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        key: String((p as ApiHeaderPair).key ?? ''),
        value: String((p as ApiHeaderPair).value ?? '')
      }))
    return pairs.length ? pairs : [emptyHeader()]
  }
  if (typeof raw === 'string') {
    const pairs: ApiHeaderPair[] = []
    for (const line of raw.split('\n')) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      pairs.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() })
    }
    return pairs.length ? pairs : [emptyHeader()]
  }
  return [emptyHeader()]
}

// ---------- 表单字段（x-www-form-urlencoded / form-data 共用一套行交互） ----------

/** 空白表单字段行（新建请求 / 删空后补一行，让界面始终有可编辑的行） */
export function emptyFormField(): ApiFormField {
  return { key: '', value: '', isFile: false }
}

/** 表单字段行是否为「空槽位」（名称与值都没填） */
export function isBlankFormField(f: ApiFormField): boolean {
  return !(f?.key ?? '').trim() && !(f?.value ?? '').trim()
}

/** 编辑表单字段后的整理规则：与请求头那套完全一致（末行填了就补空槽位、末尾只留一个空行） */
export function tidyFormRows(list: ApiFormField[]): ApiFormField[] {
  const next = list.length ? [...list] : [emptyFormField()]
  if (!isBlankFormField(next[next.length - 1])) next.push(emptyFormField())
  while (
    next.length > 1 &&
    isBlankFormField(next[next.length - 1]) &&
    isBlankFormField(next[next.length - 2])
  ) {
    next.pop()
  }
  return next
}

/** 把历史/导入来的表单字段规整成可编辑的行（兼容缺失 / 脏数据，至少返回一行） */
export function normalizeFormFields(raw: unknown): ApiFormField[] {
  if (!Array.isArray(raw)) return [emptyFormField()]
  const fields = raw
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      key: String((f as ApiFormField).key ?? ''),
      value: String((f as ApiFormField).value ?? ''),
      // 只有明确 true 才算文件字段：缺省的布尔值不能被当成文件（值会变成不存在的路径）
      isFile: (f as ApiFormField).isFile === true
    }))
  return fields.length ? fields : [emptyFormField()]
}

/**
 * 设置（覆盖或新增）Content-Type 请求头 —— 切换请求体类型时用。
 * 已有行就改它的值（保住用户在表里的位置），没有就在空槽位前插一行。
 */
export function setContentType(rows: ApiHeaderPair[], value: string): ApiHeaderPair[] {
  const idx = rows.findIndex((p) => (p?.key ?? '').trim().toLowerCase() === 'content-type')
  if (idx >= 0) return tidyHeaderRows(rows.map((p, i) => (i === idx ? { ...p, value } : p)))
  const kept = rows.filter((p) => !isBlankHeader(p))
  kept.push({ key: 'Content-Type', value })
  return tidyHeaderRows(kept)
}

/**
 * 从本地绝对路径取文件名（渲染端够不着 node:path）。
 * Windows 与 POSIX 的分隔符都认，末尾分隔符会被忽略。
 */
export function baseNameOf(filePath: string): string {
  const parts = String(filePath || '')
    .split(/[\\/]/)
    .filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/**
 * 查询参数（Query Params）与 URL 的双向解析。
 *
 * 约定：请求地址里的查询串是查询参数的**唯一事实来源**——落盘只存 URL，
 * 不另存一份参数表，参数表格只是查询串的可编辑视图。两边必须保持一致：
 * 改 URL 的查询 → 解析进表格；改表格 → 序列化回 URL 的查询串。
 */
/** 从请求地址里取出查询串，解析成键值对数组（保留顺序，空值也保留） */
export function parseQueryParams(url: string): ApiHeaderPair[] {
  const qIdx = String(url ?? '').indexOf('?')
  if (qIdx < 0) return []
  let qs = url.slice(qIdx + 1)
  const hIdx = qs.indexOf('#')
  if (hIdx >= 0) qs = qs.slice(0, hIdx)
  if (!qs) return []
  const out: ApiHeaderPair[] = []
  for (const pair of qs.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    if (eq < 0) {
      out.push({ key: safeDecode(pair), value: '' })
    } else {
      out.push({ key: safeDecode(pair.slice(0, eq)), value: safeDecode(pair.slice(eq + 1)) })
    }
  }
  return out
}

/** 把参数表序列化回查询串（不含前导 ?）：跳过空键，值允许为空（key=） */
export function serializeParams(params: ApiHeaderPair[]): string {
  const parts: string[] = []
  for (const p of params || []) {
    const k = (p.key ?? '').trim()
    if (!k) continue
    parts.push(encodeURIComponent(p.key) + '=' + encodeURIComponent(p.value ?? ''))
  }
  return parts.join('&')
}

/**
 * 把查询串写回 URL（替换原查询；query 为空则去掉 ? 与查询串，保留 #fragment）。
 * base 部分原样保留、不重新编码，避免把用户手打的 path/域名也污染掉。
 */
export function withQuery(url: string, query: string): string {
  const raw = String(url ?? '')
  const qIdx = raw.indexOf('?')
  let base: string
  let hash = ''
  if (qIdx < 0) {
    const hIdx = raw.indexOf('#')
    if (hIdx < 0) {
      base = raw
    } else {
      base = raw.slice(0, hIdx)
      hash = raw.slice(hIdx)
    }
  } else {
    base = raw.slice(0, qIdx)
    const after = raw.slice(qIdx + 1)
    const hIdx = after.indexOf('#')
    hash = hIdx < 0 ? '' : '#' + after.slice(hIdx + 1)
  }
  return query ? base + '?' + query + hash : base + hash
}

/** 解码失败（畸形 %）时退化为原串，避免整条参数解析崩掉 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export interface ParsedCurl {
  method: string
  url: string
  headers: ApiHeaderPair[]
  body: string
  /** `-F` 解析出来的请求体类型（form-data）；其余情况为 undefined（= raw） */
  bodyType?: ApiBodyType
  /** `-F` 解析出来的表单字段（含 `@文件` 形式的文件字段） */
  bodyFields?: ApiFormField[]
}

/**
 * 解析 cURL 命令为请求。
 *
 * 支持常见的 -X/-H/-d/--data-raw/--json/-F/-u/-G 选项、单双引号与
 * 反斜杠换行；无法识别的选项直接忽略（够用即可，不追求完整实现 cURL）。
 */
export function parseCurl(cmd: string): ParsedCurl {
  const text = String(cmd || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\\n/g, ' ')
    .replace(/\^\n/g, ' ')
    .replace(/`\n/g, ' ')
  const tokens: string[] = []
  let cur = ''
  let quote: string | null = null
  let has = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (quote === '"' && ch === '\\' && text[i + 1] !== undefined) {
        cur += text[++i]
      } else {
        cur += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) {
        tokens.push(cur)
        cur = ''
        has = false
      }
    } else {
      cur += ch
    }
  }
  if (cur || has) tokens.push(cur)

  if (!tokens.length || tokens[0] !== 'curl') {
    throw new Error('不是有效的 cURL 命令（需以 curl 开头）')
  }

  const optValue = (i: number): string => {
    const v = tokens[i + 1]
    if (v === undefined) throw new Error('cURL 参数缺少值：' + tokens[i])
    return v
  }

  let method: string | null = null
  let url = ''
  let basic: string | null = null
  let isGet = false
  const headerLines: string[] = []
  const dataParts: string[] = []
  const formParts: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-X' || t === '--request') {
      method = optValue(i).toUpperCase()
      i++
    } else if (t === '-H' || t === '--header') {
      headerLines.push(optValue(i))
      i++
    } else if (
      t === '-d' ||
      t === '--data' ||
      t === '--data-raw' ||
      t === '--data-binary' ||
      t === '--data-ascii' ||
      t === '--data-urlencode'
    ) {
      dataParts.push(optValue(i))
      i++
    } else if (t === '--json') {
      headerLines.push('Content-Type: application/json', 'Accept: application/json')
      dataParts.push(optValue(i))
      i++
    } else if (t === '-F' || t === '--form') {
      formParts.push(optValue(i))
      i++
    } else if (t === '-u' || t === '--user') {
      basic = optValue(i)
      i++
    } else if (t === '-G' || t === '--get') {
      isGet = true
    } else if (t.startsWith('-')) {
      // 忽略其它选项
    } else if (!url) {
      url = t
    }
  }

  if (!url) throw new Error('cURL 命令中未找到请求地址')

  const pairs: ApiHeaderPair[] = []
  for (const line of headerLines) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    pairs.push({ key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() })
  }
  if (basic) {
    pairs.push({ key: 'Authorization', value: 'Basic ' + btoa(basic) })
  }

  let body = ''
  let autoCt: string | null = null
  /**
   * 表单字段与请求体类型（`-F` 专用）。
   * `-F` 在 cURL 里就是 multipart：以前这里把 `name=value` 拼成 `a=b&c=d` 文本再配一个
   * 没有 boundary 的 `multipart/form-data`，服务端根本解析不了 —— 现在映射成 form-data 字段。
   */
  let bodyType: ApiBodyType | undefined
  let bodyFields: ApiFormField[] | undefined
  if (formParts.length) {
    bodyType = 'form-data'
    bodyFields = formParts.map(parseCurlFormPart)
    if (!pairs.some((p) => p.key.toLowerCase() === 'content-type')) {
      autoCt = 'multipart/form-data'
      pairs.push({ key: 'Content-Type', value: autoCt })
    }
  } else if (dataParts.length) {
    body = dataParts.join('&')
    if (!pairs.some((p) => p.key.toLowerCase() === 'content-type')) {
      autoCt = 'application/x-www-form-urlencoded'
      pairs.push({ key: 'Content-Type', value: autoCt })
    }
  }

  // -G：把 body 拼到查询串上，并撤掉自动补的 Content-Type
  if (isGet) {
    method = 'GET'
    if (body) {
      url += (url.includes('?') ? '&' : '?') + body.replace(/&$/, '')
      body = ''
    }
    if (autoCt) {
      const idx = pairs.findIndex((p) => p.key.toLowerCase() === 'content-type' && p.value === autoCt)
      if (idx >= 0) pairs.splice(idx, 1)
    }
  }

  // 补全协议头：curl 导出的地址常不带 http(s)://，发请求时 fetch 必须有协议，
  // 否则直接抛错（TypeError: Invalid URL）。仅当完全没有 http/https 协议时才补，
  // 已有的其它协议（如 ftp://）原样保留，不强行改。
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url
  }

  return {
    method: method || (dataParts.length || formParts.length ? 'POST' : 'GET'),
    url,
    headers: pairs,
    body,
    bodyType,
    bodyFields
  }
}

/**
 * 解析一条 `-F` 表单参数（`key=value` / `key=@本地文件路径[;type=...]` / `key=<本地文件路径`）。
 * `@` 才是「上传文件」：`<` 表示把文件内容当字段值，本应用不读文件内容，退化成文本值
 *（值就是那个路径，用户可在「类型」里自己改成文件）。
 */
function parseCurlFormPart(part: string): ApiFormField {
  const raw = String(part || '')
  const eq = raw.indexOf('=')
  if (eq < 0) return { key: raw.trim(), value: '', isFile: false }
  const key = raw.slice(0, eq).trim()
  const rest = raw.slice(eq + 1)
  if (rest.startsWith('@')) {
    // `;type=image/png` / `;filename=x.png` 这类参数由 multipart 自己生成，这里丢掉
    const path = rest.slice(1).split(';')[0]
    return { key, value: path, isFile: true }
  }
  const value = rest.startsWith('<') ? rest.slice(1) : rest
  return { key, value, isFile: false }
}

/** 从请求头键值对里取 Content-Type 的值（键名大小写不敏感）；没有则返回空串 */
export function contentTypeOf(headers: ApiHeaderPair[]): string {
  for (const p of headers || []) {
    if ((p?.key ?? '').trim().toLowerCase() === 'content-type') return p?.value ?? ''
  }
  return ''
}

/**
 * 按 Content-Type 推断请求体在 Monaco 里该用哪种语言高亮。
 *
 * 没有 Content-Type 时默认 json —— 接口调试里绝大多数请求体是 JSON，
 * 也只有给 JSON 才有语法校验与格式化。认不出的类型一律 plaintext：
 * 宁可不高亮，也不要猜成某种代码然后满屏假报错。
 */
export function bodyLanguageOf(contentType: string): string {
  const ct = String(contentType || '')
    .trim()
    .toLowerCase()
  if (!ct) return 'json'
  if (ct.includes('json')) return 'json'
  if (ct.includes('xml')) return 'xml'
  if (ct.includes('html')) return 'html'
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript'
  if (ct.includes('yaml') || ct.includes('yml')) return 'yaml'
  return 'plaintext'
}

/** 响应体美化：JSON（按 Content-Type 或首字符判断）缩进，其余原样返回 */
export function formatBody(body: string, contentType: string, enabled: boolean): string {
  if (!body || !enabled) return body
  const ct = String(contentType || '').toLowerCase()
  const trimmed = body.trimStart()
  const looksJson = ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')
  if (looksJson) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      return body
    }
  }
  return body
}

/** 相对时间（「刚刚」「5 分钟前」…，超过一天显示具体时间） */
export function relTime(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前'
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前'
  return new Date(ts).toLocaleString()
}

/** 响应状态码的配色类（0 表示请求失败） */
export function statusClass(status: number): string {
  if (!status) return 'bg-destructive/15 text-destructive'
  return status < 400 ? 'bg-emerald-500/15 text-emerald-500' : 'bg-destructive/15 text-destructive'
}

/** HTTP 方法的强调色（列表里一眼区分读/写请求） */
export function methodClass(method: string): string {
  switch (String(method || '').toUpperCase()) {
    case 'GET':
      return 'text-emerald-500'
    case 'POST':
      return 'text-blue-500'
    case 'PUT':
      return 'text-amber-500'
    case 'PATCH':
      return 'text-violet-500'
    case 'DELETE':
      return 'text-destructive'
    default:
      return 'text-muted-foreground'
  }
}

/** 字节数的可读展示（响应体大小） */
export function formatBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
