/**
 * 向模型上游要一份「可选模型清单」（设置页 →「从上游拉取」）。
 *
 * 为什么在服务端做：apiKey 不该出服务端；而且部署在服务器上时，只有服务端能连到
 * 内网网关（Ollama / vLLM / one-api 这类）。
 *
 * 各家的 /models 不是一个协议，这里按 `kind` 分三条路：
 * - OpenAI 系（`openai` / `openai-compatible` / `deepseek`）：`GET {base}/models`，
 *   `Authorization: Bearer <key>`，响应 `{ data: [{ id }] }`；
 * - Anthropic：`GET {base}/models`，`x-api-key` + `anthropic-version`，响应同样是 `{ data: [{ id }] }`；
 * - Google：`GET {base}/models?key=<key>`，响应 `{ models: [{ name: 'models/gemini-…' }] }`
 *   —— 要把 `models/` 前缀去掉，项目里存的模型 id 不带它。
 *
 * 缺省 baseURL 与 AI SDK 各 provider 的缺省保持一致，免得出现「这里拉得到、跑起来 404」。
 */
import type { AiProviderKind } from '@fizz/contracts/types'
import type { UpstreamModelsInput } from '@fizz/contracts/agent-api'

const TIMEOUT_MS = 15_000

/** 各家缺省 baseURL（与 AI SDK 的缺省对齐） */
const DEFAULT_BASE: Partial<Record<AiProviderKind, string>> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta'
}

/**
 * 探测失败。`retryNext` = 值不值得换下一个候选地址再试一次：
 * 404（路径不对）、连不上、超时、返回空清单 —— 值得；
 * 401 / 403（key 不对）、响应不是 JSON —— 换个地址也一样，直接报出来。
 */
class ProbeError extends Error {
  /** 值不值得换下一个候选地址再试一次 */
  readonly retryNext: boolean

  // 刻意不写成 `constructor(msg, readonly retryNext)`：TS 的参数属性在 Node 的
  // strip-only 模式（`--experimental-strip-types`）下会直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，
  // 而本仓的约定就是「这个文件能被 node 直接跑起来做验证」（见 resolve-model.ts 的说明）。
  constructor(message: string, retryNext: boolean) {
    super(message)
    this.name = 'ProbeError'
    this.retryNext = retryNext
  }
}

/** 去掉末尾斜杠；空值返回 '' */
function trimBase(baseURL: string | undefined): string {
  return (baseURL ?? '').trim().replace(/\/+$/, '')
}

/**
 * 候选 baseURL。只填了「主机:端口」（没有路径）时同时试带 `/v1` 的 —— Ollama 就是
 * 这种：填 `http://127.0.0.1:11434` 时 `/models` 会 404，`/v1/models` 才对。
 * 已经带路径的（`…/v1`、`…/api/v1`）只试它自己，不猜。
 */
function baseCandidates(kind: AiProviderKind, baseURL: string | undefined): string[] {
  const given = trimBase(baseURL)
  if (!given) {
    const fallback = DEFAULT_BASE[kind]
    if (!fallback) throw new Error('这个服务商必须填 Base URL 才能拉模型')
    return [fallback]
  }
  let pathname = ''
  try {
    // 用 URL 解析看 pathname，避免把 `host:port` 里的冒号当成路径
    pathname = new URL(given).pathname.replace(/\/+$/, '')
  } catch {
    throw new Error(`Base URL 不是合法的地址：${given}`)
  }
  return pathname ? [given] : [given, `${given}/v1`]
}

/** 从 `{ data: [{ id }] }` 里抠 id（OpenAI 系与 Anthropic 共用这个形状） */
function idsFromData(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const out: string[] = []
  for (const item of data) {
    if (typeof item === 'string') {
      if (item) out.push(item)
      continue
    }
    const id = (item as { id?: unknown })?.id
    if (typeof id === 'string' && id) out.push(id)
  }
  return out
}

/** 从 Google 的 `{ models: [{ name: 'models/x' }] }` 里抠 id，并去掉 `models/` 前缀 */
function idsFromGoogle(payload: unknown): string[] {
  const models = (payload as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  const out: string[] = []
  for (const item of models) {
    const name = (item as { name?: unknown })?.name
    if (typeof name === 'string' && name) out.push(name.replace(/^models\//, ''))
  }
  return out
}

/** 打一次 `{base}/models` 并解析。失败一律抛 ProbeError（带「要不要换地址再试」） */
async function fetchModels(kind: AiProviderKind, base: string, apiKey: string): Promise<string[]> {
  const what = kind === 'google' ? 'Google' : kind === 'anthropic' ? 'Anthropic' : '模型网关'
  const url = new URL(`${base}/models`)
  const headers: Record<string, string> = {}
  if (kind === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey) headers['x-api-key'] = apiKey
  } else if (kind === 'google') {
    if (apiKey) url.searchParams.set('key', apiKey)
  } else {
    // 与 resolveModel 一致：没填 key 时用 EMPTY 占位（本地网关大多不校验，
    // 但少数网关会因为缺少 Authorization 头直接 400）
    headers['authorization'] = `Bearer ${apiKey || 'EMPTY'}`
  }

  let res: Response
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    const timeout = err instanceof Error && err.name === 'TimeoutError'
    throw new ProbeError(
      timeout
        ? `连接 ${what} 超时（${TIMEOUT_MS / 1000}s）：${url.origin}`
        : `连不上 ${what}（${url.origin}）：${err instanceof Error ? err.message : String(err)}`,
      true
    )
  }

  if (!res.ok) {
    // 上游的报错正文常常是关键信息（key 无效 / 没有权限），如实透出来
    const body = await res.text().catch(() => '')
    const snippet = body.replace(/\s+/g, ' ').slice(0, 200)
    throw new ProbeError(
      `${what} 返回 ${res.status}${snippet ? `：${snippet}` : ''}`,
      // 404 = 路径不对，值得试带 /v1 的那个；其余（401/403/429…）换个地址也一样
      res.status === 404
    )
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    throw new ProbeError(`${what} 的响应不是 JSON（${url.origin}${url.pathname}）`, true)
  }

  const ids = kind === 'google' ? idsFromGoogle(payload) : idsFromData(payload)
  if (!ids.length) {
    throw new ProbeError(
      `${what} 返回的清单是空的（${url.origin}${url.pathname}）—— 地址对不对？key 有权限吗？`,
      true
    )
  }
  return [...new Set(ids)]
}

/**
 * 拉一次上游模型清单。拉不到就抛错（附上游状态码与响应片段）——
 * 不返回空数组假装成功，否则设置页会显示「0 个模型」而用户不知道为什么。
 */
export async function probeUpstreamModels(input: UpstreamModelsInput): Promise<string[]> {
  const { kind } = input
  const apiKey = input.apiKey?.trim() ?? ''
  const candidates = baseCandidates(kind, input.baseURL)

  let lastError: Error | null = null
  for (const [index, base] of candidates.entries()) {
    try {
      return await fetchModels(kind, base, apiKey)
    } catch (err) {
      const probe = err instanceof Error ? err : new Error(String(err))
      lastError = probe
      const hasNext = index < candidates.length - 1
      const worthRetry = probe instanceof ProbeError ? probe.retryNext : false
      if (!hasNext || !worthRetry) throw probe
    }
  }
  throw lastError ?? new Error('拉取模型清单失败')
}
