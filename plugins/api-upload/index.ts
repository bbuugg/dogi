/**
 * 内置插件：把对话附件传到**自己的文件上传服务**（仓库根 `API_UPLOAD.md` 描述的那套）。
 *
 * 与 `plugins/oss.ts` 同一形态，但**只提供上传源，不提供工具**：
 * 输入框回形针 →「传到哪儿」→ 选它 → 附件落进你那个服务，交给模型的是
 * `data.file.url` —— **绝对访问地址**，可直接 `<img src>`，模型侧取得到
 * （这正是 storage.to 那种「分享页」做不到的地方）。
 *
 * ## 为什么走 base64 那个接口
 *
 * 服务有两个上传接口：`POST /api/upload`（multipart）与 `POST /api/upload/base64`（JSON）。
 * 这里用**后者**：插件跑在服务端，`fetch` 发 JSON 最直接，也不必拼 FormData / Blob；
 * 代价是体积胀 1/3，但附件上限 10MB（胀完 ~13MB）完全可接受。
 *
 * ## 两个地址可能不是同一个
 *
 * - `baseUrl`：**接口**地址（控制台那个域名），请求打给它；
 * - `publicBaseUrl`：**文件对外访问**的基址（服务端 `server.assetUrl`，常见于独立静态域名）。
 *
  服务返回的 `url` 用的是后者，而**模型侧取的正是这条**。两者不一致是常态（文档里
 * `assetUrl` 未配置时才回退成请求 host），所以这里把它做成一项设置，并在上传后**当场
 * 比对**：返回的地址不在 `publicBaseUrl` 下就立刻报错并提示该填什么 —— 否则宿主那道
 * 「上传源只能产出自己声明过的域名」的校验会在更后面炸，且不带原因。
 *
 * ## 设置项（设置 →「插件」里填；`apiKey` 经 SecretBox 加密，明文不回浏览器）
 *
 * - `baseUrl`：服务根地址，如 `https://console.example.com`（接口会拼成 `/api/upload/base64`）；
 * - `apiKey`：后台「系统监控 → API Key 管理」创建的 Key（**每次成功调用扣 1 次配额**）；
 * - `dir`：可选，存放子目录（相对上传目录），留空则服务端按 `年/月/日` 归档；
 * - `publicBaseUrl`：文件对外访问的基址，留空则按 `baseUrl` 算；
 * - `verifyUrl`：上传后立刻 GET 一次返回的地址，取不到就报错（默认开）；
 * - `enableUploadProvider`：关掉就只保留配置、不出现在「传到哪儿」里。
 *
 * 配置**只从设置页来**（系统配置），不读环境变量：一个凭据有两个真源，排查「为什么传不
 * 上去」时永远得先问「你到底配在哪」。容器 / 无界面部署用的是同一个设置页。
 *
 * ## 报错口径
 *
 * 上游是 `{code, message, data}` 包装，这里把 `message` **原样**带出来，再按状态码补一句
 * 人话（文档「认证」那节的规则）：401 = Key 不存在 / 已禁用 / 已过期，429 = 配额用尽。
 */
/** 与内置存储同一个口径：10MB（不声明 accept = 用契约白名单：图片 + PDF，10MB） */
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 120_000
const VERIFY_TIMEOUT_MS = 20_000

/**
 * 插件图标：自绘的「上传」图形（data URI）。
 *
 * ⚠️ 不再画那种**深色圆角衬底**：列表里按 40px 显示，衬底会吃掉大半面积，只剩一小块
 * 色块。这里是单色、无衬底 —— 有官方 logo 的项目请直接用 logo（见 `plugins/oss.ts`）。
 *
 * 用 `encodeURIComponent` 现编（而不是贴一段预编码的长串）：源码可读、可 diff，
 * 改形状不用手工转码。
 */
const ICON_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
<title>API 文件上传</title>
<path fill="#0ea5e9" d="M7.2 18.5h9.6a3.6 3.6 0 0 0 .4-7.18 5.7 5.7 0 0 0-10.96-1.4 3.4 3.4 0 0 0 .96 8.58Z"/>
<path fill="none" stroke="#0ea5e9" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M12 15.5V8.2m0 0-2.4 2.4M12 8.2l2.4 2.4"/>
</svg>`
const ICON = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`

interface ApiUploadConfig {
  baseUrl?: string
  apiKey?: string
  dir?: string
  publicBaseUrl?: string
  verifyUrl?: boolean
  enableUploadProvider?: boolean
}

interface ApiUploadSettings {
  baseUrl: string
  apiKey: string
  dir: string
  publicBaseUrl: string
  verifyUrl: boolean
  enableUploadProvider: boolean
}

/** 取设置页里填的值（去首尾空白；**不读环境变量**，见文件头） */
function pick(configured: unknown): string {
  return typeof configured === 'string' ? configured.trim() : ''
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function readSettings(config?: ApiUploadConfig): ApiUploadSettings {
  const baseUrl = stripSlash(pick(config?.baseUrl))
  return {
    baseUrl,
    apiKey: pick(config?.apiKey),
    dir: pick(config?.dir),
    // 没单独配静态域名时，文件就挂在接口那个域下（文档：assetUrl 未配置 → 回退请求 host）
    publicBaseUrl: stripSlash(pick(config?.publicBaseUrl)) || baseUrl,
    // 开关：缺省 = 开（只有显式存成 false 才关）
    verifyUrl: config?.verifyUrl !== false,
    enableUploadProvider: config?.enableUploadProvider !== false
  }
}

/** 还缺哪几项（用于「配齐才注册」的判断与人话报错） */
function missingKeys(s: ApiUploadSettings): string[] {
  const out: string[] = []
  if (!s.baseUrl) out.push('baseUrl')
  if (!s.apiKey) out.push('apiKey')
  if (!s.publicBaseUrl) out.push('publicBaseUrl')
  return out
}

/**
 * `publicBaseUrl` 必须是一条能当 URL 前缀的绝对地址（否则上传源注册会当场抛错）。
 *
 * ⚠️ **http 也收**（与 `plugins/oss.ts` 只收 https 不同）：对象存储都是 https 的，
 * 而这个服务是**自建**的 —— 内网 / 本机跑一套（`http://192.168.x.x:8080`）很常见，
 * 为了能连上就不该强制 https。有 https 的话填 https 更好（模型侧取附件走明文也是明文）。
 */
function validPublicBase(url: string): boolean {
  if (!/^https?:\/\/[^/?#\s]+/i.test(url)) return false
  try {
    const parsed = new URL(url)
    return !parsed.search && !parsed.hash
  } catch {
    return false
  }
}

/**
 * 把状态码翻成人话（文档「认证」那节：401 = Key 无效/禁用/过期，429 = 配额用尽）。
 *
 * 服务的业务错误也在同一个响应体里（如 `code: 51`「文件大小不能超过 20MB」），
 * 那种由状态码之外的 `message` 承担 —— 原样带出即可，别替它改写。
 */
function hintFor(status: number): string {
  if (status === 401) return '（API Key 不存在 / 已禁用 / 已过期 —— 到后台「系统监控 → API Key 管理」核对）'
  if (status === 429) return '（配额用尽：每次成功调用扣 1 次；到后台换 Key 或调整配额）'
  if (status === 413) return '（文件超过服务端上限 20MB）'
  return ''
}

/** 上传一个文件，返回**可直接访问的绝对地址**（`data.file.url`） */
async function uploadFile(
  s: ApiUploadSettings,
  input: { name: string; bytes: Uint8Array }
): Promise<string> {
  const endpoint = `${s.baseUrl}/api/upload/base64`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-api-key': s.apiKey
    },
    body: JSON.stringify({
      filename: input.name,
      content_base64: Buffer.from(input.bytes).toString('base64'),
      // 空就不传：留空服务端按「年/月/日」归档（文档：dir 非法也回退成按日期）
      ...(s.dir ? { dir: s.dir } : {})
    }),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
  }).catch((err: unknown) => {
    throw new Error(
      `连不上上传服务（${s.baseUrl}）：${err instanceof Error ? err.message : String(err)} —— 检查 baseUrl 是否可达`
    )
  })

  const raw = await res.text().catch(() => '')
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object') {
    // 常见于前面挂了网关 / 鉴权页：响应是一张 HTML，那不是本服务的回包
    throw new Error(
      `上传服务的响应不是 JSON（HTTP ${res.status}）：${raw.replace(/\s+/g, ' ').trim().slice(0, 200)}`
    )
  }

  const body = parsed as {
    code?: unknown
    message?: unknown
    data?: { file?: { url?: unknown; name?: unknown; size?: unknown; hash?: unknown } }
  }
  const code = Number(body.code)
  const message = typeof body.message === 'string' ? body.message : ''
  if (!res.ok || !Number.isFinite(code) || code !== 0) {
    throw new Error(
      `上传失败（HTTP ${res.status}${Number.isFinite(code) ? `，code ${code}` : ''}）：` +
        `${message || '服务没给原因'} ${hintFor(res.status)}`.trim()
    )
  }

  const url = body.data?.file?.url
  if (typeof url !== 'string' || !url) {
    throw new Error('上传服务没在 `data.file.url` 里返回地址（响应格式与文档不一致）')
  }

  /**
   * 地址必须落在声明过的域名下：宿主会按 `urlPrefixes` 校验（fail-closed），
   * 与其让它在一个不带原因的地方炸，不如这里当场说清该填什么。
   */
  if (!url.startsWith(s.publicBaseUrl)) {
    throw new Error(
      `上传成功，但返回的地址（${url}）不在「公网访问基址」（${s.publicBaseUrl}）之下 —— ` +
        '文件多半挂在另一个静态域名上（服务端配置 `server.assetUrl`）。' +
        `把插件设置里的 publicBaseUrl 改成它的 origin（例如 ${originOf(url)}）即可。`
    )
  }

  if (s.verifyUrl) {
    // 取不到的话，「附件发出去、模型读不到」会拖到下一轮才暴露 —— 这里当场说清
    const check = await fetch(url, {
      method: 'GET',
      // 只要 1 字节：有些 CDN 不放行 HEAD，用 GET + Range 最稳
      headers: { range: 'bytes=0-0' },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    }).catch((err: unknown) => {
      throw new Error(
        `上传成功，但回读地址失败：${err instanceof Error ? err.message : String(err)} —— ` +
          `检查 ${url} 能不能从本机访问`
      )
    })
    if (!check.ok) {
      throw new Error(
        `上传成功，但地址取不到（${check.status}）：${url} —— ` +
          '文件不是匿名可读，或 publicBaseUrl 写错了域名。模型侧取的就是这条地址，' +
          '所以这里按失败处理（可在插件设置里关掉 verifyUrl 跳过这项检查）'
      )
    }
  }

  return url
}

/** 取一个地址的 origin（报错里告诉用户该填什么） */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

// ---------- 插件本体 ----------

/**
 * 插件参数类型是**结构化手写**的（不 import `@fizz/plugin`）：插件目录可能不在仓库里，
 * 指望解析到 workspace 包不可靠（见 skills/create-fizz-plugin/SKILL.md）。
 */
interface PluginCtx {
  logger: { warn: (...args: unknown[]) => void }
  inject(deps: string[], cb: (ctx: PluginCtx) => void | (() => void)): unknown
  ui: { icon(uri: string): unknown; setting(item: unknown): unknown }
  uploads: { register(spec: unknown): unknown }
}

/** 设置项那行「当前状态」：为什么它（还没）出现在上传源下拉里 */
function providerStatus(missing: string[]): string {
  return missing.length
    ? `当前还缺 ${missing.join('、')}，所以「传到哪儿」里不会出现它。`
    : '当前已配齐，「传到哪儿」里可以选到它。'
}

export default {
  name: 'API 文件上传',
  /**
   * 顶层不声明依赖 = **任何 context 都 apply**（设置项声明必须在设置页那次 inspect 里跑）。
   * 只用到 `uploads`（长驻 upload context 上才有），那一半自己 `ctx.inject` 声明。
   */
  inject: [],

  apply(ctx: PluginCtx, config?: ApiUploadConfig) {
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
        description: `开启后，输入框的「传到哪儿」里会出现这个服务；关掉则只保留配置。${providerStatus(missing)}`
      })
      c.ui.setting({
        id: 'baseUrl',
        title: '服务地址',
        type: 'string',
        placeholder: 'https://console.example.com',
        description:
          '上传服务的根地址（接口会拼成 {baseUrl}/api/upload/base64）。文档见仓库根的 API_UPLOAD.md'
      })
      c.ui.setting({
        id: 'apiKey',
        title: 'API Key',
        type: 'string',
        secret: true,
        placeholder: 'sk-xxxxxxxx',
        description:
          '后台「系统监控 → API Key 管理」里创建的 Key。每次成功调用扣 1 次配额；无效 / 禁用 / 过期会返回 401，配额用尽返回 429。'
      })
      c.ui.setting({
        id: 'publicBaseUrl',
        title: '公网访问基址',
        type: 'string',
        placeholder: 'https://static.example.com',
        description:
          '上传后返回的那个地址所在的域名（服务端配置 `server.assetUrl`）。留空则按「服务地址」算 —— 若两者不同，这里必须填，否则地址校验会失败'
      })
      c.ui.setting({
        id: 'dir',
        title: '存放子目录',
        type: 'string',
        placeholder: 'images（留空则按 年/月/日 归档）',
        description: '相对上传目录的子目录；含 `..` / `.` 会被服务端视为非法并回退成按日期归档'
      })
      c.ui.setting({
        id: 'verifyUrl',
        title: '上传后回读校验',
        type: 'boolean',
        default: true,
        description:
          '上传完立刻 GET 一次返回的地址，取不到就当场报错（宁可在上传时失败，也不要留下模型取不到的附件）'
      })
    })

    // ---- 附件上传提供商：只挂长驻 upload context ----
    if (settings.enableUploadProvider) {
      ctx.inject(['uploads'], (c) => {
        // 没配齐就不注册：`urlPrefixes` 为空会当场抛错，那会把整个插件的挂载带崩
        if (missing.length > 0) {
          return
        }
        if (!validPublicBase(settings.publicBaseUrl)) {
          return
        }
        c.uploads.register({
          id: 'api-upload',
          title: 'API 文件上传',
          // 自己声明「我只产出这个域名下的地址」：服务端据此 fail-closed 校验 put 的返回值
          urlPrefixes: [settings.publicBaseUrl],
          // 不声明 accept = 用契约白名单（图片 + PDF，10MB），与内置存储同一个口径
          async put(input: { name: string; mediaType: string; bytes: Uint8Array }) {
            if (input.bytes.length > UPLOAD_MAX_BYTES) {
              throw new Error(
                `文件太大：${(input.bytes.length / 1024 / 1024).toFixed(1)}MB，上限 ${UPLOAD_MAX_BYTES / 1024 / 1024}MB`
              )
            }
            // mediaType 不发给服务：它按文件内容嗅探 MIME（文档：「未指定时按文件内容嗅探」）
            return { url: await uploadFile(settings, { name: input.name, bytes: input.bytes }) }
          }
        })
      })
    }
  }
}
