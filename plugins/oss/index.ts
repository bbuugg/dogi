/**
 * 内置插件：把附件 / 文件传到**自己的对象存储**（S3 兼容协议）。
 *
 * 覆盖阿里云 OSS、腾讯云 COS、Cloudflare R2、MinIO、AWS S3 以及任何 S3 兼容服务 ——
 * 它们都认同一套鉴权：**AWS Signature Version 4**（`AWS4-HMAC-SHA256`）。所以这里不引入
 * 任何 SDK，用 `node:crypto` 手写签名（见下面 `signV4` 的说明），插件保持单文件、零依赖。
 *
 * ## 它同时提供两样东西（各自可开关）
 *
 * 1. **附件上传提供商**（`ctx.uploads.register`）—— 输入框回形针 →「传到哪儿」→ 选它，
 *    附件就落进你的桶，交给输入框的是一条**公网直链**（模型侧能取到，与 storage.to 那种
 *    分享页不同）。要出现在下拉里必须先配齐下面的设置项。
 * 2. **工具**（`ctx.tools.register`）—— `upload_to_oss`：让模型把工作区里的某个文件传上去
 *    并拿到直链（例如「把这个报告传上去给我个链接」）。
 *
 * 两个开关在 设置 →「插件」里：`enableUploadProvider` / `enableTools`。
 *
 * ## ⚠️ 为什么是「两半分别注册」而不是一个 `inject`
 *
 * 工具挂在**每轮对话的 turn context**（有 tools / workspace，没有 uploads），上传源挂在
 * **长驻的 upload context**（有 uploads / ui / tools，没有 workspace）。所以本插件顶层
 * `inject` 为空（**任何 context 都 apply**：设置项声明才能在设置页出现），两半各自用
 * `ctx.inject([...])` 声明依赖 —— 依赖齐了就注册，没齐就静默等（不报错、不空跑）。
 *
 * ⚠️ 别把 `workspace` 写进顶层 `inject`：设置页收集声明用的是临时 inspect context，
 * 那里没有工作区，写进去会把**整个插件**推迟挂载，连设置表单都看不到。
 *
 * ## 设置项（值在 设置 →「插件」里填，密钥经 SecretBox 加密、明文不回传浏览器）
 *
 * 以阿里云 OSS 为例（其它家同理，见每项的说明）：
 * - `endpoint`：**S3 兼容** endpoint，如 `https://s3.oss-cn-hangzhou.aliyuncs.com`
 *   （注意带 `s3.` 前缀；`https://oss-cn-hangzhou.aliyuncs.com` 是 OSS 原生接口，签名规则不同）；
 * - `region`：`cn-hangzhou`（R2 填 `auto`，MinIO 常见 `us-east-1`）；
 * - `bucket` / `accessKeyId` / `secretAccessKey`：RAM 用户的 AK/SK（**别用主账号 AK**）；
 * - `publicBaseUrl`：桶的公网访问基址，如 `https://my-bucket.oss-cn-hangzhou.aliyuncs.com`
 *   或你自己的 CDN 域名。**它必须指向这个桶且可匿名读** —— 模型侧就是去取它；
 * - `keyPrefix`：对象键前缀（默认 `fizz/`）；
 * - `verifyPublicRead`：上传后立刻回读一次公网地址，读不到就当场报错（默认开）。
 *   没有它的话，「桶不是公共读」会表现成「附件发出去、模型读不到」，比报错难查得多。
 *
 * 环境变量兜底（容器 / 无界面部署）：`OSS_ENDPOINT`、`OSS_REGION`、`OSS_BUCKET`、
 * `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_PUBLIC_BASE_URL`。
 *
 * ## 签名细节（排障时看这里）
 *
 * - 走 **path-style**（`endpoint/bucket/key`）；若 `endpoint` 的主机名本身以 `<bucket>.`
 *   开头，则自动改成 **virtual-host style**（`bucket.oss-cn-hangzhou.aliyuncs.com` 这种）——
 *   这样用户从控制台复制哪种地址都能用，不用多一个开关。
 * - 路径**只编码一次**：规范请求里的 CanonicalURI 直接取 URL 上已编码的 pathname
 *   （S3 明确要求不做二次编码，服务端不做归一化）。
 * - `x-amz-content-sha256` = 请求体的 SHA-256（S3 强制要求，且必须与签名里的哈希一致）。
 * - 报错会把上游 XML 的 `Code` / `Message` 原样带出来：
 *   `SignatureDoesNotMatch` 多半是 region / endpoint 不对（OSS 要求 endpoint 与桶同地域），
 *   `AccessDenied` 是 RAM 策略没给 `oss:PutObject`，
 *   回读失败则是桶没开公共读、或 `publicBaseUrl` 写错了域名。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { z } from 'zod'
import { tool } from 'ai'

/** 附件上传与内置存储同一个口径：10MB —— 模型附件本来就是图片 / PDF */
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
/** 工具路径放宽一些（分享个压缩包 / 大图很常见），但仍是「读进内存再 PUT」，不放开到 GB 级 */
const TOOL_MAX_BYTES = 32 * 1024 * 1024
const PUT_TIMEOUT_MS = 120_000
const VERIFY_TIMEOUT_MS = 20_000
/** S3 的签名服务名（所有 S3 兼容实现都用它） */
const SERVICE = 's3'

/**
 * 插件图标：自绘的「存储桶」SVG（data URI）。
 *
 * 为什么用矢量 + 画粗：列表里按 **24px** 显示，细节在这个尺寸下会糊成一团（原来桶身上那道
 * 半透明小横条缩到 24px 就没了），所以只留「桶身 + 桶沿」两个大色块。
 *
 * 为什么不放阿里云 / AWS 的 logo：那是各家商标，放进来是版权与背书问题；一个中性图标
 * 足够说明「这是对象存储」。用 URL 编码（而不是 base64）是为了源码可读、可 diff。
 */
/**
 * 插件图标：**阿里云官方 logo**（Simple Icons 那份，`#FF6A00`，775 字符）。
 *
 * 早先是自画的一个带深色衬底的方块 —— 那种衬底在 40px 的列表里只剩一小块色块，
 * 图形反而看不清。这里直接用官方 logo、**不加衬底**。
 *
 * 这插件是「S3 兼容」的（OSS / COS / R2 / MinIO 都能连），图标取阿里云是因为主场景
 * 就是它；要用别的云，按同样方式换一段 `data:image/svg+xml,…` 即可（只收 data URI，
 * 理由见 `ctx.ui.icon` 的说明）。
 */
const ICON =
  'data:image/svg+xml,%3Csvg%20fill%3D%22%23FF6A00%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3EAlibaba%20Cloud%3C%2Ftitle%3E%3Cpath%20d%3D%22M3.996%204.517h5.291L8.01%206.324%204.153%207.506a1.668%201.668%200%200%200-1.165%201.601v5.786a1.668%201.668%200%200%200%201.165%201.6l3.857%201.183%201.277%201.807H3.996A3.996%203.996%200%200%201%200%2015.487V8.513a3.996%203.996%200%200%201%203.996-3.996m16.008%200h-5.291l1.277%201.807%203.857%201.182c.715.227%201.17.889%201.165%201.601v5.786a1.668%201.668%200%200%201-1.165%201.6l-3.857%201.183-1.277%201.807h5.291A3.996%203.996%200%200%200%2024%2015.487V8.513a3.996%203.996%200%200%200-3.996-3.996m-4.007%208.345H8.002v-1.804h7.995Z%22%2F%3E%3C%2Fsvg%3E'

/** 工具上传时按扩展名猜 Content-Type（对象存储里这个头决定浏览器怎么打开它） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

// ---------- SigV4 ----------

/** 十六进制 SHA-256 */
function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** HMAC-SHA256，返回**原始二进制**（派生密钥链要求逐层以 Buffer 作 key） */
function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * 派生签名密钥：`AWS4+secret` → 日期 → 区域 → 服务 → `aws4_request`。
 *
 * 顺序与串值是规范的一部分（写错任何一个都只会得到 `SignatureDoesNotMatch`），
 * 所以这一步有官方测试向量兜底：见 `scripts/verify-oss-signature.mjs`。
 */
function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

/** `2026-05-12T10:15:30.000Z` → `20260512T101530Z`（SigV4 的时间戳格式） */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

/**
 * RFC 3986 百分号编码。
 *
 * `encodeURIComponent` 会漏掉 `!'()*` 这四个（规范要求它们必须编码），
 * 所以补一道；其余输出本来就是大写十六进制，与 AWS 一致。
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/** 把对象键编成 URL 路径（逐段编码、保留 `/`） */
function encodePath(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`
  return withSlash.split('/').map(uriEncode).join('/')
}

export interface SignV4Input {
  method: string
  /** ⚠️ `url.pathname` 必须是**已编码**的路径（本文件的 `buildObjectUrl` 就是这么给的） */
  url: URL
  region: string
  accessKeyId: string
  secretAccessKey: string
  payload: Uint8Array
  /** 额外参与签名的头（小写化后并入，如 `content-type`） */
  headers?: Record<string, string>
  service?: string
  /** 只为测试向量可复现而存在；缺省 = 现在 */
  date?: Date
}

export interface SignedV4 {
  /** 直接交给 fetch 的头（含 authorization / x-amz-date / x-amz-content-sha256） */
  headers: Record<string, string>
  canonicalRequest: string
  stringToSign: string
  signature: string
  authorization: string
}

/**
 * 生成一个 SigV4 签名的请求头。
 *
 * 规范请求的拼装顺序是固定的（方法 / CanonicalURI / CanonicalQuery / CanonicalHeaders /
 * SignedHeaders / 载荷哈希），其中 **CanonicalHeaders 的每一行都以 `\n` 结尾**（所以它与
 * SignedHeaders 之间会出现一个空行）—— 这正是最容易手写错、又最难从报错里看出来的地方，
 * 因此 `scripts/verify-oss-signature.mjs` 用 AWS 官方文档里的示例（含期望的十六进制签名）
 * 把它钉住：整条链路（规范请求串 → 待签名串 → 派生密钥 → 签名）任何一处错了都会对不上。
 */
export function signV4(input: SignV4Input): SignedV4 {
  const { method, url, region, accessKeyId, secretAccessKey, payload } = input
  const service = input.service ?? SERVICE
  const date = input.date ?? new Date()

  const payloadHash = sha256Hex(payload)
  const stamp = amzDate(date)
  const dateStamp = stamp.slice(0, 8)

  // 参与签名的头：host + 两个 x-amz-* 是必需的，其余由调用方给（键统一小写）
  const all: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    all[name.toLowerCase()] = value
  }
  const names = Object.keys(all).sort()
  const canonicalHeaders = names
    .map((name) => `${name}:${all[name].trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  const signedHeaders = names.join(';')

  // 查询串：我们的 PUT 没有 query，但排序 + 编码规则照实现（少一处「以后有人加就错」的坑）
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

  const canonicalRequest = [
    method,
    url.pathname || '/', // 已编码的路径，**不再编码**（S3 不做二次编码 / 不做路径归一化）
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    sha256Hex(canonicalRequest)
  ].join('\n')

  const signature = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, service))
    .update(stringToSign, 'utf8')
    .digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`

  return {
    headers: {
      ...(input.headers ?? {}),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
      authorization
    },
    canonicalRequest,
    stringToSign,
    signature,
    authorization
  }
}

// ---------- 配置 ----------

interface OssConfig {
  endpoint?: string
  region?: string
  bucket?: string
  accessKeyId?: string
  secretAccessKey?: string
  publicBaseUrl?: string
  keyPrefix?: string
  verifyPublicRead?: boolean
  enableUploadProvider?: boolean
  enableTools?: boolean
}

interface OssSettings {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  publicBaseUrl: string
  keyPrefix: string
  verifyPublicRead: boolean
  enableUploadProvider: boolean
  enableTools: boolean
}

/** 设置页里填的值优先，环境变量兜底（容器 / 无界面部署） */
function pick(configured: unknown, envName: string): string {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  return process.env[envName]?.trim() ?? ''
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function readSettings(config?: OssConfig): OssSettings {
  return {
    endpoint: stripSlash(pick(config?.endpoint, 'OSS_ENDPOINT')),
    region: pick(config?.region, 'OSS_REGION'),
    bucket: pick(config?.bucket, 'OSS_BUCKET'),
    accessKeyId: pick(config?.accessKeyId, 'OSS_ACCESS_KEY_ID'),
    secretAccessKey: pick(config?.secretAccessKey, 'OSS_ACCESS_KEY_SECRET'),
    publicBaseUrl: stripSlash(pick(config?.publicBaseUrl, 'OSS_PUBLIC_BASE_URL')),
    keyPrefix: pick(config?.keyPrefix, 'OSS_KEY_PREFIX') || 'fizz/',
    // 开关：缺省 = 开（只有显式存成 false 才关）
    verifyPublicRead: config?.verifyPublicRead !== false,
    enableUploadProvider: config?.enableUploadProvider !== false,
    enableTools: config?.enableTools !== false
  }
}

/** 还缺哪几项（用于「配齐才注册」的判断与人话报错） */
function missingKeys(s: OssSettings): string[] {
  const out: string[] = []
  if (!s.endpoint) out.push('endpoint')
  if (!s.region) out.push('region')
  if (!s.bucket) out.push('bucket')
  if (!s.accessKeyId) out.push('accessKeyId')
  if (!s.secretAccessKey) out.push('secretAccessKey')
  if (!s.publicBaseUrl) out.push('publicBaseUrl')
  return out
}

/** `publicBaseUrl` 必须是一条能当 URL 前缀的 https 地址（否则上传源注册会当场抛错） */
function validPublicBase(url: string): boolean {
  if (!/^https:\/\/[^/?#\s]+/i.test(url)) return false
  try {
    const parsed = new URL(url)
    return !parsed.search && !parsed.hash
  } catch {
    return false
  }
}

/**
 * 设置页里那行「当前状态」：为什么它（还没）出现在上传源下拉里。
 *
 * 为什么需要：配置不全时本插件**不注册**上传源（注册要求 `urlPrefixes`，空值会当场抛错，
 * 见下面 `ctx.inject(['uploads'])` 里那段），那是一次**静默缺席** —— 用户只看到「回形针菜单里
 * 没有它」，而且只要没有第二个源，连选择器本身都不显示（前端既有设计）。把「缺什么」写在他
 * 填设置的地方，就不必去猜「选项哪去了」。
 *
 * 措辞刻意写成**一句平铺**（前端把 description 渲染成一段文字，换行会被折叠）。
 */
function providerStatus(s: OssSettings): string {
  if (!s.enableUploadProvider) return '当前状态：已关闭，不会出现在上传源下拉里（下面那个工具不受影响）。'
  const missing = missingKeys(s)
  if (missing.length > 0) {
    return `当前状态：还缺 ${missing.join('、')}，补齐后才会出现在回形针菜单的「传到哪儿」里。`
  }
  if (!validPublicBase(s.publicBaseUrl)) {
    return `当前状态：publicBaseUrl「${s.publicBaseUrl}」不是合法的 https 前缀（要写成 https://主机[/路径]），所以还没生效。`
  }
  return '当前状态：已生效，回形针菜单的「传到哪儿」里可以选它。'
}

// ---------- 对象键与请求地址 ----------

/** 对象键：`<prefix><uuid><ext>`（扩展名保留，浏览桶时一眼看出是什么文件） */
function objectKey(s: OssSettings, fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''
  return `${s.keyPrefix}${randomUUID()}${safeExt}`
}

/**
 * 上传地址。**path-style**（`endpoint/bucket/key`）为主；若 endpoint 的主机名本身以
 * `<bucket>.` 开头（用户复制的是虚拟主机样式地址），自动切成 virtual-host style。
 */
function buildObjectUrl(s: OssSettings, key: string): URL {
  const base = new URL(s.endpoint)
  const virtualHost = base.host === s.bucket || base.host.startsWith(`${s.bucket}.`)
  const path = virtualHost ? `/${key}` : `/${s.bucket}/${key}`
  // 用字符串拼（而不是给 base.pathname 赋值）：路径只编码一次，且与签名里的 CanonicalURI 完全一致
  return new URL(`${base.origin}${encodePath(path)}`)
}

/** 公开访问地址（交给模型 / 输入框的那条） */
function publicUrl(s: OssSettings, key: string): string {
  return `${s.publicBaseUrl}${encodePath(key)}`
}

/** 从对象存储的 XML 错误体里挖出 Code / Message（排障全靠它） */
function describeStorageError(status: number, body: string): string {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1]
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1]
  const flat = body.replace(/\s+/g, ' ').trim().slice(0, 300)
  const head = `对象存储拒绝了这个请求（${status}）`
  if (code === 'SignatureDoesNotMatch') {
    return `${head}：SignatureDoesNotMatch${message ? `（${message}）` : ''} —— 常见原因是 region 与桶的实际地域不符，或 endpoint 用了非 S3 兼容的那种（阿里云 OSS 要 https://s3.oss-<region>.aliyuncs.com）`
  }
  if (code === 'AccessDenied') {
    return `${head}：AccessDenied${message ? `（${message}）` : ''} —— 检查 RAM 用户是否有 oss:PutObject 权限，以及桶的归属`
  }
  return `${head}${code ? `：${code}` : ''}${message ? `（${message}）` : ''}${code ? '' : `：${flat}`}`
}

// ---------- 上传 ----------

interface PutObjectInput {
  key: string
  bytes: Uint8Array
  mediaType: string
}

/**
 * 真正落到桶里的一步：签名 → PUT → （可选）回读公网地址。
 *
 * 附件提供商与工具共用它 —— 两条路只有「谁在调」不同，签名与校验不该有两份实现。
 */
async function putObject(s: OssSettings, input: PutObjectInput): Promise<string> {
  const url = buildObjectUrl(s, input.key)
  const signed = signV4({
    method: 'PUT',
    url,
    region: s.region,
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    payload: input.bytes,
    headers: { 'content-type': input.mediaType }
  })

  const res = await fetch(url, {
    method: 'PUT',
    headers: signed.headers,
    // `Uint8Array` 在 fetch 规范里是合法 BodyInit，只是 TS 的 lib 类型没收这一支
    body: input.bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(PUT_TIMEOUT_MS)
  }).catch((err: unknown) => {
    throw new Error(
      `连不上对象存储（${url.origin}）：${err instanceof Error ? err.message : String(err)} —— 检查 endpoint 是否可达`
    )
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(describeStorageError(res.status, body))
  }

  const publicHref = publicUrl(s, input.key)

  if (s.verifyPublicRead) {
    // 桶不是公共读的话，「附件发出去、模型取不到」会拖到下一轮才暴露 —— 这里当场说清
    const check = await fetch(publicHref, {
      method: 'GET',
      // 只要 1 字节：有些 CDN 不放行 HEAD，用 GET + Range 最稳
      headers: { range: 'bytes=0-0' },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    }).catch((err: unknown) => {
      throw new Error(
        `上传成功，但回读公网地址失败：${err instanceof Error ? err.message : String(err)}——` +
          `检查 publicBaseUrl（${s.publicBaseUrl}）能不能从本机访问`
      )
    })
    if (!check.ok) {
      throw new Error(
        `上传成功，但公网地址取不到（${check.status}）：${publicHref} ——` +
          '桶 / 对象不是匿名可读，或 publicBaseUrl 写错了域名。模型侧取的就是这条地址，' +
          '所以这里按失败处理（可在插件设置里关掉 verifyPublicRead 跳过这项检查）'
      )
    }
  }

  return publicHref
}

/** 本地文件 → 上传（工具用）：读盘 + 大小与类型判定 */
async function uploadLocalFile(
  s: OssSettings,
  absPath: string,
  overrideKey?: string
): Promise<{ url: string; bytes: number; mediaType: string }> {
  let size: number
  try {
    const info = await stat(absPath)
    if (!info.isFile()) throw new Error('不是一个文件')
    size = info.size
  } catch (err) {
    throw new Error(`读不到文件：${absPath}（${err instanceof Error ? err.message : String(err)}）`)
  }
  if (size > TOOL_MAX_BYTES) {
    throw new Error(
      `文件太大：${(size / 1024 / 1024).toFixed(1)}MB，上限 ${TOOL_MAX_BYTES / 1024 / 1024}MB`
    )
  }
  const bytes = new Uint8Array(await readFile(absPath))
  const mediaType = MIME_BY_EXT[extname(absPath).toLowerCase()] ?? 'application/octet-stream'
  const key = overrideKey?.trim() || objectKey(s, absPath)
  const url = await putObject(s, { key, bytes, mediaType })
  return { url, bytes: bytes.length, mediaType }
}

// ---------- 插件本体 ----------

/**
 * 插件参数类型是**结构化手写**的（不 import `@fizz/plugin`）：插件目录可能不在仓库里，
 * 指望解析到 workspace 包不可靠。`zod` / `ai` 是例外 —— 工具要用它们建 schema，
 * 而内置插件根随仓库分发，这条依赖是明确的（见 skills/create-fizz-plugin/SKILL.md）。
 */
interface PluginCtx {
  logger: { warn: (...args: unknown[]) => void }
  inject(deps: string[], cb: (ctx: PluginCtx) => void | (() => void)): unknown
  ui: { icon(uri: string): unknown; setting(item: unknown): unknown }
  uploads: { register(spec: unknown): unknown }
  tools: { register(name: string, tool: unknown, opts?: unknown): unknown }
  workspace: { path: string; label: string; resolve(p: string): string }
}

export default {
  name: 'oss',
  /**
   * 顶层不声明依赖 = **任何 context 都 apply**（设置项声明必须在设置页那次 inspect 里跑），
   * 两半能力各自用 `ctx.inject([...])` 声明依赖。见文件头的说明。
   */
  inject: [],

  apply(ctx: PluginCtx, config?: OssConfig) {
    const settings = readSettings(config)
    const missing = missingKeys(settings)

    // ---- 设置项与图标：只要宿主提供 ui（设置页 inspect / 长驻 upload context 都有）----
    ctx.inject(['ui'], (c) => {
      c.ui.icon(ICON)
      c.ui.setting({
        id: 'enableUploadProvider',
        title: '作为附件上传提供商',
        type: 'boolean',
        default: true,
        description: `开启后，输入框的「传到哪儿」里会出现这个桶；关掉则只保留下面的工具。${providerStatus(settings)}`
      })
      c.ui.setting({
        id: 'enableTools',
        title: '提供 upload_to_oss 工具',
        type: 'boolean',
        default: true,
        description: '开启后模型可以调用 upload_to_oss 把工作区里的文件传上去并拿到直链'
      })
      c.ui.setting({
        id: 'endpoint',
        title: 'S3 兼容 Endpoint',
        type: 'string',
        placeholder: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
        description:
          '要带 s3. 前缀的 S3 兼容地址（阿里云 OSS）；腾讯云 COS 形如 https://cos.ap-guangzhou.myqcloud.com，Cloudflare R2 形如 https://<账号>.r2.cloudflarestorage.com，MinIO 填你自己的地址'
      })
      c.ui.setting({
        id: 'region',
        title: 'Region',
        type: 'string',
        placeholder: 'cn-hangzhou',
        description: 'OSS / COS 填地域 ID；Cloudflare R2 填 auto；MinIO 常见 us-east-1'
      })
      c.ui.setting({
        id: 'bucket',
        title: 'Bucket',
        type: 'string',
        placeholder: 'my-bucket'
      })
      c.ui.setting({
        id: 'accessKeyId',
        title: 'AccessKey ID',
        type: 'string',
        description: '建议用只授予该桶读写权限的 RAM 子账号，不要用主账号 AK'
      })
      c.ui.setting({
        id: 'secretAccessKey',
        title: 'AccessKey Secret',
        type: 'string',
        secret: true,
        description: '落盘经 SecretBox 加密，明文不回传浏览器'
      })
      c.ui.setting({
        id: 'publicBaseUrl',
        title: '公网访问基址',
        type: 'string',
        placeholder: 'https://my-bucket.oss-cn-hangzhou.aliyuncs.com',
        description:
          '桶的公网可读地址（或你自己的 CDN 域名）。模型侧取附件取的就是它 —— 填错 / 桶不是公共读，附件就取不到'
      })
      c.ui.setting({
        id: 'keyPrefix',
        title: '对象键前缀',
        type: 'string',
        default: 'fizz/',
        placeholder: 'fizz/',
        description: '上传文件的键前缀，默认 fizz/'
      })
      c.ui.setting({
        id: 'verifyPublicRead',
        title: '上传后回读校验',
        type: 'boolean',
        default: true,
        description:
          '上传完立刻 GET 一次公网地址，取不到就当场报错（宁可在上传时失败，也不要留下模型取不到的附件）'
      })
    })

    // ---- 附件上传提供商：只挂长驻 upload context ----
    if (settings.enableUploadProvider) {
      ctx.inject(['uploads'], (c) => {
        // 没配齐就不注册：`urlPrefixes` 为空会当场抛错，那会把整个插件的挂载带崩
        if (missing.length > 0) {
          c.logger.warn(
            `[oss] 还不完整（缺 ${missing.join('、')}），暂不作为附件上传提供商 —— ` +
              '在 设置 →「插件」里补齐后，下一次上传即可用'
          )
          return
        }
        if (!validPublicBase(settings.publicBaseUrl)) {
          c.logger.warn(
            `[oss] publicBaseUrl「${settings.publicBaseUrl}」不是合法的 https 前缀，暂不作为附件上传提供商`
          )
          return
        }
        c.uploads.register({
          id: 'oss',
          title: '对象存储（OSS）',
          // 自己声明「我只产出这个域名下的地址」：服务端据此 fail-closed 校验 put 的返回值
          urlPrefixes: [settings.publicBaseUrl],
          // 不声明 accept = 用契约白名单（图片 + PDF，10MB），与内置存储同一个口径
          async put(input: { name: string; mediaType: string; bytes: Uint8Array }) {
            if (input.bytes.length > UPLOAD_MAX_BYTES) {
              throw new Error(
                `文件太大：${(input.bytes.length / 1024 / 1024).toFixed(1)}MB，上限 ${UPLOAD_MAX_BYTES / 1024 / 1024}MB`
              )
            }
            return {
              url: await putObject(settings, {
                key: objectKey(settings, input.name),
                bytes: input.bytes,
                mediaType: input.mediaType
              })
            }
          }
        })
      })
    }

    // ---- 工具：挂有 tools + workspace 的回合（上传 context 里也会跑一遍，那边没人用注册表）----
    if (settings.enableTools) {
      ctx.inject(['tools', 'workspace'], (c) => {
        if (missing.length > 0) {
          // 工具照样注册：调用时再报「缺哪几项」，比「工具凭空消失」好查
          c.logger.warn(`[oss] 还不完整（缺 ${missing.join('、')}），upload_to_oss 调用会直接报错`)
        }
        c.tools.register(
          'upload_to_oss',
          tool({
            description:
              '把一个本地文件上传到对象存储，返回可公开访问的直链（用于把产出物分享出去）。' +
              'path 用相对工作区根的路径（或绝对路径）。',
            inputSchema: z.object({
              path: z.string().describe('文件路径：相对工作区根，或绝对路径'),
              key: z
                .string()
                .optional()
                .describe('自定义对象键（可选）。不给就按前缀 + 随机名自动生成')
            }),
            execute: async ({ path, key }: { path: string; key?: string }) => {
              const missing2 = missingKeys(settings)
              if (missing2.length > 0) {
                throw new Error(
                  `对象存储还没配置完整：缺 ${missing2.join('、')}（在 设置 →「插件」→ oss 里填）`
                )
              }
              const abs = c.workspace.resolve(path)
              const { url, bytes, mediaType } = await uploadLocalFile(settings, abs, key)
              return `已上传：${url}\n（${(bytes / 1024).toFixed(1)}KB，${mediaType}）`
            }
          }),
          { source: 'oss', mutating: true }
        )
      })
    }
  }
}

/**
 * 只为 `scripts/verify-oss-signature.mjs` 存在：把签名相关的纯函数暴露出来，
 * 好让验证脚本用 **AWS 官方文档里的示例**（含期望的十六进制签名）把算法钉住，
 * 不必接触真实桶。插件加载器只认 `default`，多导出一个命名导出不影响挂载。
 */
export const __signing = { signV4, encodePath, buildObjectUrl, sha256Hex, signingKey, amzDate }
