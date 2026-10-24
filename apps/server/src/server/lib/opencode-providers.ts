/**
 * 「设置 → AI 模型」→ 容器内 opencode 的自定义 provider。
 *
 * 容器里的 opencode 配置是 entrypoint 现写的（见 `docker/container-project/`），
 * 此前只有两条模型路由：内置 provider 透传（认证靠 `FORWARDED_ENV_KEYS` 转发的密钥环境
 * 变量）与「单一 custom 包装」（OPENAI_BASE_URL + OPENAI_API_KEY）—— fizz 里配的
 * 模型网关进不去，想用只能在容器 Agent 配置的 env 里手抄一遍 baseURL/key，而且抄一份
 * 只能多一个网关。
 *
 * 这里的做法：起流程节点容器时，把 store 里的每份
 * 模型配置**解密**、转成 opencode 的 provider 块（npm 包 + baseURL + apiKey + models），
 * 序列化成 JSON 经 `AGENT_OPENCODE_PROVIDERS` 注入。entrypoint 把它 merge 进
 * opencode.json 的 `provider`，并让 `AGENT_MODEL` 的前缀命中注入 provider 时直接透传。
 * 于是「系统里配了哪些网关，容器内 opencode 就有哪些 provider」—— 与主会话的模型下拉
 * 同源，配置一处即可，不用再抄环境变量。
 *
 * 安全边界：apiKey 经 env 明文进容器，与 `FORWARDED_ENV_KEYS` 转发密钥是同一信任级别
 * （`docker inspect` 可见）；密钥只解密进内存与 env，不落盘、不出网。
 */
import type { AiModelConfig, AiProviderKind } from '@fizz/contracts/types'
import { store } from '../state'

/** 注入容器用的环境变量名（entrypoint 按它 merge 进 opencode.json） */
export const OPENCODE_PROVIDERS_ENV = 'AGENT_OPENCODE_PROVIDERS'

/**
 * opencode 的自定义 provider 走 AI SDK 的包，kind → npm 包名（与主会话 ai-sdk 后端同一族）。
 * 容器里没预装这些包 —— opencode 在首次使用该 provider 时自己拉（与现有 custom 包装同机制）。
 */
const KIND_NPM: Record<AiProviderKind, string> = {
  openai: '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
  deepseek: '@ai-sdk/deepseek',
  google: '@ai-sdk/google',
  'openai-compatible': '@ai-sdk/openai-compatible'
}

/**
 * provider id 会用作 `AGENT_MODEL` 的 `provider/model` 前缀，只留安全字符
 * （models.dev 的 id 就是这个口径）。空了给个兜底（调用方按序号补）。
 */
function sanitizeProviderId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 把模型配置列表转成 opencode 的 provider 块（providerId → 配置）。
 *
 * 纯函数（models 与解密器都由调用方给）—— 便于脱离 store 单测。
 * 跳过没挂任何模型的配置（选不了，与 `resolveModelConfig` 的口径一致）；
 * id 重名时顺位加 `-2` / `-3` 后缀，保证每份配置都进得去而不是悄悄丢掉。
 */
export function buildOpencodeProviders(
  models: readonly AiModelConfig[],
  decryptSecret: (value: string | undefined) => string | undefined
): Record<string, unknown> {
  const providers: Record<string, unknown> = {}
  for (const [index, config] of models.entries()) {
    const modelIds = (config.models ?? [])
      .map((m) => (typeof m?.id === 'string' ? m.id.trim() : ''))
      .filter(Boolean)
    if (!modelIds.length) continue
    const base = sanitizeProviderId(config.name) || `custom-${index + 1}`
    let pid = base
    for (let n = 2; providers[pid]; n++) pid = `${base}-${n}`
    const apiKey = decryptSecret(config.apiKey)
    providers[pid] = {
      npm: KIND_NPM[config.kind] ?? KIND_NPM['openai-compatible'],
      name: config.name,
      options: {
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        ...(apiKey ? { apiKey } : {})
      },
      models: Object.fromEntries(modelIds.map((id) => [id, { name: id }]))
    }
  }
  return providers
}

/**
 * 起容器时要追加的 env；没有任何可注入的配置时返回 undefined（调用方原样 Object.assign，
 * 不留一个空变量）。
 */
export function opencodeProvidersEnv(): Record<string, string> | undefined {
  const providers = buildOpencodeProviders(store.snapshot().models ?? [], (value) =>
    store.decryptSecret(value)
  )
  if (!Object.keys(providers).length) return undefined
  return { [OPENCODE_PROVIDERS_ENV]: JSON.stringify(providers) }
}
