/**
 * 模型配置工具组：列 / 增 / 改 / 删模型配置（= 一个网关：kind + baseURL + apiKey），
 * 配置下的模型条目（增 / 改 / 删），以及从上游拉模型清单。
 *
 * ## 挂在哪
 * **只挂给全局 AI 助手**（`apps/server/src/server/assistant-turn.ts` 的 `scope: 'project'`），
 * 与 `project-tools.ts` 同一批装配。普通会话不挂：改模型配置等于改「agent 用哪个大脑 + 哪把
 * 钥匙」，这是环境级操作，不该出现在某个项目的代码对话里（与 `project-tools` 同一条理由）。
 *
 * ## 审批口径（与 project-tools.ts 完全一致）
 * - `readonly` 档：全部变更直接拒绝；
 * - 其余档：**一律弹审批卡** —— 配置里有长期凭证（apiKey），且「把模型换成没有工具调用的
 *   那个」能让 agent 立刻变哑巴，动手前必须让用户看一眼；
 * - 只读的两个（`list_model_configs` / `fetch_upstream_models`）任何档都不拦。
 *
 * ## 三条容易写错的地方
 * 1. **`models` 是整份替换语义**（`domain.saveModel`）。所以「改一个模型条目」必须先取全量
 *    清单、改一项、整份写回 —— 直接传一项等于把其余模型全删掉。
 * 2. **apiKey 只写不读**：读回来的视图只有 `hasApiKey`，工具结果里也永远不出现明文；
 *    改别的字段时不传 apiKey = 服务端保留原密钥。
 * 3. **改动对下一轮生效**：这一轮的 provider 已经构造好了，改配置不会把当前这轮切走。
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { tr } from '@fizz/i18n'
import type { AiApiStyle, AiModelEntry, AiModelSettings, AiProviderKind } from '@fizz/contracts/types'
import type { ModelInput, ModelView, UpstreamModelsInput } from '@fizz/contracts/agent-api'
import { guardMutation, type MutationGuardDeps } from './project-tools'

/**
 * 工具组依赖：服务端注入 `domain.listModels / saveModel / deleteModel` 与
 * `probeUpstreamModels`（apiKey 解密在服务端做，见 `server/model-probe.ts`）。
 * 签名全部结构化 —— `packages/tools` 不 import 领域包 / 服务端模块。
 */
export interface ModelToolsDeps extends MutationGuardDeps {
  models: {
    /** 已脱敏的配置清单（插件注册的项带 readOnly） */
    list(): ModelView[]
    /** 整份 upsert；不传 apiKey = 保留原密钥 */
    save(input: ModelInput): ModelView
    remove(id: string): void
    /** 拉上游 `/models`；带 id 时由服务端解出已存的 key */
    probe(input: UpstreamModelsInput): Promise<string[]>
  }
}

/** 本组的工具名清单（与其它工具组同一风格，便于集中核对） */
export const MODEL_TOOLS = [
  'list_model_configs',
  'fetch_upstream_models',
  'create_model_config',
  'update_model_config',
  'delete_model_config',
  'add_model_entries',
  'update_model_entry',
  'remove_model_entry'
] as const

/** 服务商类型（与 `AiProviderKind` 一一对应；zod 需要具体字面量） */
const PROVIDER_KIND = z.enum(['openai', 'anthropic', 'deepseek', 'google', 'openai-compatible'])

/** 接口风格（只有 openai / openai-compatible 有意义） */
const API_STYLE = z.enum(['chat-completions', 'responses'])

/** 新增模型条目入参：id 必给，窗口可缺省（缺省 = 走 `DEFAULT_CONTEXT_WINDOW` 兜底） */
const ENTRY_INPUT = z.object({
  id: z.string(),
  contextWindow: z.number().optional()
})

/** 模型条目补丁：`null` = 显式清空（回到默认），缺省 = 保持原样 */
const ENTRY_PATCH = z.object({
  id: z.string().optional(),
  contextWindow: z.number().nullable().optional(),
  settings: z
    .object({
      maxOutputTokens: z.number().nullable().optional(),
      toolCall: z.boolean().optional(),
      imageInput: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      apiStyle: API_STYLE.nullable().optional()
    })
    .optional()
})

export interface ModelEntryInput {
  id: string
  contextWindow?: number
}

export interface ModelSettingsPatch {
  maxOutputTokens?: number | null
  toolCall?: boolean
  imageInput?: boolean
  reasoning?: boolean
  apiStyle?: AiApiStyle | null
}

export interface ModelEntryPatch {
  id?: string
  contextWindow?: number | null
  settings?: ModelSettingsPatch
}

/** 正整数才算有效窗口；0 / 负数 / NaN 一律当没给（手改坏的输入不该把窗口钉成 0） */
function normalizeWindow(value: number | undefined | null): number | undefined {
  if (value == null) return undefined
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * 把若干模型条目并进清单：**已在清单里的跳过**（不覆盖用户已配的窗口 / 能力），
 * 返回新清单与「加了哪些 / 跳过了哪些」，供工具如实回话。
 */
export function addModelEntries(
  current: readonly AiModelEntry[],
  input: readonly ModelEntryInput[]
): { models: AiModelEntry[]; added: string[]; skipped: string[] } {
  const models = [...current]
  const added: string[] = []
  const skipped: string[] = []
  for (const item of input) {
    const id = item.id?.trim()
    if (!id) continue
    if (models.some((entry) => entry.id === id)) {
      skipped.push(id)
      continue
    }
    const window = normalizeWindow(item.contextWindow)
    models.push({ id, ...(window !== undefined ? { contextWindow: window } : {}) })
    added.push(id)
  }
  return { models, added, skipped }
}

/**
 * 应用进阶设置补丁。缺省项**不落盘**（`true` = 删掉那个 key，与设置页同一口径），
 * 数据文件里只出现「被削过的能力」。
 */
export function applySettingsPatch(base: AiModelSettings | undefined, patch: ModelSettingsPatch): AiModelSettings {
  const next: AiModelSettings = { ...(base ?? {}) }
  if (patch.maxOutputTokens !== undefined) {
    const tokens = normalizeWindow(patch.maxOutputTokens)
    if (tokens === undefined) delete next.maxOutputTokens
    else next.maxOutputTokens = tokens
  }
  for (const key of ['toolCall', 'imageInput', 'reasoning'] as const) {
    const value = patch[key]
    if (value === undefined) continue
    if (value) delete next[key]
    else next[key] = false
  }
  if (patch.apiStyle !== undefined) {
    if (patch.apiStyle === null) delete next.apiStyle
    else next.apiStyle = patch.apiStyle
  }
  return next
}

/**
 * 改一个模型条目（改名时窗口 / 设置整条跟着搬走）。
 * 返回 `null` = 清单里没这个 id；`duplicate` = 改出来的新 id 已存在（清单不变）。
 */
export function patchModelEntry(
  models: readonly AiModelEntry[],
  modelId: string,
  patch: ModelEntryPatch
): { models: AiModelEntry[]; duplicate?: string } | null {
  const current = models.find((entry) => entry.id === modelId)
  if (!current) return null
  const nextId = patch.id?.trim() || current.id
  if (nextId !== current.id && models.some((entry) => entry.id === nextId)) {
    return { models: [...models], duplicate: nextId }
  }
  const entry: AiModelEntry = { id: nextId }
  if (patch.contextWindow === null) {
    // 显式清空 = 不留 contextWindow，走默认兜底
  } else if (patch.contextWindow !== undefined) {
    const window = normalizeWindow(patch.contextWindow)
    if (window !== undefined) entry.contextWindow = window
  } else if (current.contextWindow !== undefined) {
    entry.contextWindow = current.contextWindow
  }
  const settings = patch.settings ? applySettingsPatch(current.settings, patch.settings) : current.settings
  if (settings && Object.keys(settings).length) entry.settings = settings
  return { models: models.map((item) => (item.id === modelId ? entry : item)) }
}

/**
 * 从清单里摘掉一个模型。返回 `null` = 没有这个 id。
 *
 * ⚠️ 与设置页一致：允许删到 0 个 —— 空清单的配置只是暂时不能用于对话，
 * 不会顺手把网关与 key 一起带走（那个动作是 `delete_model_config`）。
 */
export function removeModelEntry(models: readonly AiModelEntry[], modelId: string): AiModelEntry[] | null {
  if (!models.some((entry) => entry.id === modelId)) return null
  return models.filter((entry) => entry.id !== modelId)
}

/** 给模型看的配置摘要：**永远不含 apiKey 明文**，只报 hasApiKey */
export function summarizeModelConfig(view: ModelView): Record<string, unknown> {
  return {
    id: view.id,
    name: view.name,
    kind: view.kind,
    ...(view.baseURL ? { baseURL: view.baseURL } : {}),
    hasApiKey: !!view.hasApiKey,
    ...(view.apiStyle ? { apiStyle: view.apiStyle } : {}),
    models: (view.models ?? []).map((entry) => ({
      id: entry.id,
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.settings && Object.keys(entry.settings).length ? { settings: entry.settings } : {})
    })),
    ...(view.readOnly ? { readOnly: true, ...(view.sourceName ? { sourceName: view.sourceName } : {}) } : {})
  }
}

/** 把模型清单压成一行 id，供审批文案 / 回话用 */
function idList(models: readonly AiModelEntry[]): string {
  return models.map((entry) => entry.id).join(', ') || '（空）'
}

/** 保存类调用统一把异常转成人话（service 层抛的已经是中文原因） */
function rethrow(err: unknown): never {
  throw err instanceof Error ? err : new Error(String(err))
}

/** 构建模型配置工具集（只由全局助手装配，见文件头） */
export function buildModelTools(deps: ModelToolsDeps): ToolSet {
  return {
    list_model_configs: tool({
      description: tr(
        '列出已保存的全部模型配置（每份 = 一个网关：服务商类型 + Base URL + API key）及其下的模型 id / 上下文窗口 / 进阶设置。API key 只显示有无（hasApiKey），拿不到明文。改 / 删配置或改模型前先用它拿 id；readOnly=true 的是插件注册的，只能改插件。',
        'List every saved model configuration (each = a gateway: provider kind + base URL + API key) with its model ids, context windows and advanced settings. API keys are never exposed, only hasApiKey. Use it to get ids before editing / deleting configs or models; readOnly=true entries come from plugins and can only be changed there.'
      ),
      inputSchema: z.object({}),
      execute: async () => {
        const list = deps.models.list().map(summarizeModelConfig)
        if (!list.length) {
          return '还没有任何模型配置。要新建一份用 create_model_config（先问用户要服务商类型 / Base URL / API key）。'
        }
        return JSON.stringify(list, null, 2)
      }
    }),

    fetch_upstream_models: tool({
      description: tr(
        '向上游网关拉一份可选模型清单（GET {baseURL}/models）。给 id 就用那份已存配置的 kind / Base URL / 密钥（apiKey 留空 = 服务端用已存的，拿不到明文）；也可以不建配置、直接给 kind + baseURL + apiKey 先探一下。清单可能几百条：用 keyword 过滤、limit 控制条数（缺省 80，上限 500）。拉不到会带出上游状态码与消息。只读，不弹审批。',
        'Fetch available model ids from the upstream gateway (GET {baseURL}/models). Pass id to reuse a saved configuration’s kind / base URL / key (empty apiKey = server uses the stored secret); or probe bare kind + baseURL + apiKey without saving. Lists can hold hundreds of ids: filter with keyword and cap with limit (default 80, max 500). Failures surface the upstream status and message. Read-only, no approval.'
      ),
      inputSchema: z.object({
        id: z
          .string()
          .optional()
          .describe(tr('已保存的模型配置 id（用它就不用再传 kind / baseURL / apiKey）', 'Id of a saved configuration (then kind / baseURL / apiKey are unnecessary)')),
        kind: PROVIDER_KIND.optional().describe(
          tr('服务商类型（各家 /models 协议不同，必填，除非给了 id）', 'Provider kind (each has its own /models protocol; required unless id is given)')
        ),
        baseURL: z.string().optional().describe(tr('上游地址；缺省用该配置已存的，再缺省用服务商官方地址', 'Upstream URL; defaults to the saved one, then the provider default')),
        apiKey: z.string().optional().describe(tr('临时试探用的 key（不落盘）；缺省用已存配置的密钥。绝不回显', 'Ad-hoc key for a one-off probe (not persisted); defaults to the stored secret. Never echoed')),
        keyword: z.string().optional().describe(tr('按 id 子串过滤（不区分大小写）', 'Case-insensitive substring filter on ids')),
        limit: z.number().optional().describe(tr('最多返回多少条（缺省 80，上限 500）', 'Max entries returned (default 80, capped at 500)'))
      }),
      execute: async ({ id, kind, baseURL, apiKey, keyword, limit }) => {
        const configId = id?.trim() || undefined
        let targetKind: AiProviderKind | undefined = kind
        let targetBase = baseURL?.trim() || undefined
        if (configId) {
          const saved = deps.models.list().find((item) => item.id === configId)
          if (!saved) return `找不到模型配置 ${configId}（用 list_model_configs 拿最新清单）。`
          if (saved.readOnly) {
            return `「${saved.name}」由插件注册，服务端没有它的密钥，没法从这里拉模型；请让用户在插件里看，或在「设置 → 模型」里手动加模型 id。`
          }
          targetKind = saved.kind
          targetBase = targetBase ?? saved.baseURL
        }
        if (!targetKind) {
          return '缺少 kind：要么给 id（用已保存的配置），要么给 kind（openai / anthropic / deepseek / google / openai-compatible）。'
        }
        let upstream: string[]
        try {
          upstream = await deps.models.probe({
            ...(configId ? { id: configId } : {}),
            kind: targetKind,
            ...(targetBase ? { baseURL: targetBase } : {}),
            ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {})
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return `拉取失败：${message}\n（地址或 key 不对时改 baseURL / apiKey 再试；仍然不行就如实告诉用户原因，不要反复重试同一次调用。）`
        }
        const kw = keyword?.trim().toLowerCase()
        const matched = kw ? upstream.filter((item) => item.toLowerCase().includes(kw)) : upstream
        const max = Math.min(Math.max(Math.floor(limit ?? 80), 1), 500)
        const shown = matched.slice(0, max)
        return JSON.stringify(
          {
            ok: true,
            total: upstream.length,
            matched: matched.length,
            returned: shown.length,
            models: shown,
            ...(matched.length > shown.length
              ? { note: `还有 ${matched.length - shown.length} 个没列出：用 keyword 过滤或调大 limit（上限 500）。` }
              : {}),
            hint: '选好 id 后用 add_model_entries 加进配置，或建新配置时直接带上。'
          },
          null,
          2
        )
      }
    }),

    create_model_config: tool({
      description: tr(
        '新建一份模型配置（= 一个网关）。同一网关 + 同一 key 下的多个模型共用一份配置。apiKey 只在**用户明确给出**时才传（服务端加密落盘，之后只显示有无），不要编造 key；本地网关（Ollama / vLLM）通常不填。models 可缺省，之后再补。保存后立刻出现在「设置 → 模型」，但**这一轮仍用原模型**。创建前会弹审批卡。',
        'Create a model configuration (one gateway). Models behind the same gateway + key share it. Only pass apiKey when the user explicitly provides it (stored encrypted; later reads only report presence) — never invent one; local gateways (Ollama / vLLM) usually need none. models may be omitted and added later. It appears in Settings → Models immediately, but **this turn keeps its model**. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        name: z.string().optional().describe(tr('展示名（可中文）；缺省用第一个模型 id', 'Display name (may be Chinese); defaults to the first model id')),
        kind: PROVIDER_KIND.describe(
          tr('服务商类型（中转 / Ollama / vLLM 这类都是 openai-compatible）', 'Provider kind (relays, Ollama and vLLM are openai-compatible)')
        ),
        baseURL: z
          .string()
          .optional()
          .describe(tr('网关地址，如 http://127.0.0.1:11434/v1；缺省用官方地址', 'Gateway URL, e.g. http://127.0.0.1:11434/v1; defaults to the provider default')),
        apiKey: z.string().optional().describe(tr('API key（仅当用户明确提供；不要编造）', 'API key (only when the user provides it; never invent one)')),
        apiStyle: API_STYLE.optional().describe(tr('接口风格覆盖；缺省按 kind 取默认', 'API style override; defaults per kind')),
        models: z
          .array(ENTRY_INPUT)
          .optional()
          .describe(tr('模型清单（顺序即展示顺序）；可缺省，之后用 add_model_entries 补', 'Model entries (order is display order); optional — add later with add_model_entries'))
      }),
      execute: async ({ name, kind, baseURL, apiKey, apiStyle, models }, options) => {
        const entries = models ?? []
        if (entries.some((item) => !item.id?.trim())) {
          return '模型清单里有空 id：每一项都要给 id（上游模型名，如 gpt-4o-mini）。'
        }
        const { models: merged } = addModelEntries([], entries)
        const label = name?.trim() || merged[0]?.id || kind
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: '模型配置未创建',
          command: `新建模型配置「${label}」（${kind}${baseURL?.trim() ? `，${baseURL.trim()}` : ''}${
            apiKey?.trim() ? '，并写入提供的 API key' : ''
          }）${merged.length ? `，含模型 ${idList(merged)}` : '（暂不含模型）'}`,
          toolCallId: options.toolCallId,
          toolName: 'create_model_config'
        })
        if (refused) return refused
        try {
          const saved = deps.models.save({
            name: name?.trim() || merged[0]?.id || '',
            kind,
            models: merged,
            ...(baseURL?.trim() ? { baseURL: baseURL.trim() } : {}),
            ...(apiStyle ? { apiStyle } : {}),
            ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {})
          })
          return JSON.stringify({
            ok: true,
            config: summarizeModelConfig(saved),
            note: '已保存。「设置 → 模型」立刻显示；这一轮仍用原模型，下一轮才按新配置走。'
          })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    update_model_config: tool({
      description: tr(
        '修改一份已保存的模型配置（网关本身：名称 / 服务商类型 / Base URL / 接口风格 / API key）。**只传要改的字段，其余保持原样**；模型清单不受影响（改模型用 update_model_entry / add_model_entries / remove_model_entry）。apiKey 缺省 = 保留原密钥（要换就传新值，之后读不回来）。baseURL 传空串 = 清空改用服务商缺省；改 kind 且没给 baseURL 时会顺带清空旧地址。插件注册的配置只读。修改前会弹审批卡。',
        'Update a saved model configuration (the gateway itself: name / provider kind / base URL / API style / API key). **Pass only the fields to change; the rest stay as-is**; the model list is untouched (use update_model_entry / add_model_entries / remove_model_entry for models). Omitted apiKey keeps the stored secret (pass a new value to replace it; it can never be read back). An empty baseURL clears it in favour of the provider default; changing kind without baseURL clears the old URL too. Plugin-registered configs are read-only. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('模型配置 id（list_model_configs 返回的 id）', 'Configuration id (as returned by list_model_configs)')),
        name: z.string().optional().describe(tr('新的展示名', 'New display name')),
        kind: PROVIDER_KIND.optional().describe(tr('新的服务商类型', 'New provider kind')),
        baseURL: z
          .string()
          .optional()
          .describe(tr('新的 Base URL；传空串 = 清空改用服务商缺省地址', 'New base URL; empty string clears it in favour of the provider default')),
        apiStyle: API_STYLE.nullable().optional().describe(tr('接口风格；null = 跟随 kind 默认', 'API style; null = follow the kind default')),
        apiKey: z
          .string()
          .optional()
          .describe(tr('新的 API key（缺省保留原密钥；用户没给就别传）', 'New API key (omit to keep the stored one; never pass one the user did not give)'))
      }),
      execute: async ({ id, name, kind, baseURL, apiStyle, apiKey }, options) => {
        const config = findConfig(deps, id)
        if (typeof config === 'string') return config
        const nextKind = kind ?? config.kind
        const kindChanged = nextKind !== config.kind
        // baseURL 三态：缺省 = 保留（但换 kind 时清空，旧地址对新服务商没意义）；'' = 显式清空；其它 = 新地址
        const nextBase = baseURL === undefined ? (kindChanged ? undefined : config.baseURL) : baseURL.trim() || undefined
        const nextStyle = apiStyle === undefined ? config.apiStyle : apiStyle ?? undefined
        const changes: string[] = []
        if (name?.trim() && name.trim() !== config.name) changes.push(`名称改为「${name.trim()}」`)
        if (kindChanged) changes.push(`服务商类型改为 ${nextKind}`)
        if (nextBase !== config.baseURL) changes.push(nextBase ? `Base URL 改为 ${nextBase}` : '清除 Base URL（改用服务商缺省）')
        if (nextStyle !== config.apiStyle) changes.push(`接口风格改为 ${nextStyle ?? '跟随默认'}`)
        if (apiKey?.trim()) changes.push('替换 API key')
        if (!changes.length) return '没有给出要修改的字段（name / kind / baseURL / apiStyle / apiKey 至少给一个）。'
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: '模型配置未修改',
          command: `修改模型配置「${config.name}」：${changes.join('、')}`,
          toolCallId: options.toolCallId,
          toolName: 'update_model_config'
        })
        if (refused) return refused
        try {
          // 网关字段先算成「生效后」的样子，再交给 carryOver —— 它按有值才带，空值即被清掉
          const effective: ModelView = { ...config, baseURL: nextBase, apiStyle: nextStyle }
          const saved = deps.models.save({
            ...carryOver(effective),
            id: config.id,
            name: name?.trim() || config.name,
            kind: nextKind,
            // 整份带回：saveModel 是整份重建，漏了就把模型全删了
            models: config.models ?? [],
            ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {})
          })
          return JSON.stringify({ ok: true, config: summarizeModelConfig(saved), note: '下一轮对话生效。' })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    delete_model_config: tool({
      description: tr(
        '删除一份模型配置：网关地址、API key 与整份模型清单一并丢弃，删掉就得重新填。绑定到它的会话会失效、发送时要重新选模型 —— 动手前先向用户复述要删哪一份（含下面有几个模型）。插件注册的配置删不了。删除前会弹审批卡。',
        'Delete a model configuration: base URL, API key and the whole model list are discarded and must be re-entered. Conversations bound to it break and need a new model choice — restate which config (and how many models it holds) before deleting. Plugin-registered configs cannot be deleted. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        id: z.string().describe(tr('模型配置 id（list_model_configs 返回的 id）', 'Configuration id (as returned by list_model_configs)'))
      }),
      execute: async ({ id }, options) => {
        const config = findConfig(deps, id)
        if (typeof config === 'string') return config
        if (config.readOnly) return `「${config.name}」由插件注册，不能从这里删除（停用 / 卸载插件即可）。`
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: '模型配置未删除',
          command: `删除模型配置「${config.name}」（${config.kind}${
            config.models?.length ? `，含 ${config.models.length} 个模型：${idList(config.models)}` : ''
          }），API key 与 Base URL 一并丢弃`,
          toolCallId: options.toolCallId,
          toolName: 'delete_model_config'
        })
        if (refused) return refused
        try {
          deps.models.remove(config.id)
          return JSON.stringify({ ok: true, removed: config.name, note: '绑定这份配置的会话发送时要重新选模型。' })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    add_model_entries: tool({
      description: tr(
        '把模型 id 加进一份已有配置（通常先把 fetch_upstream_models 的结果挑出来再调它）。**已在配置里的 id 会跳过、不覆盖原有的窗口与进阶设置**。新增项可带 contextWindow（可缺省，缺省走默认兜底）。配置里原有模型、网关字段与 API key 都保持不变。添加前会弹审批卡。',
        'Add model ids to an existing configuration (usually after picking from fetch_upstream_models). **Ids already present are skipped and keep their context window and advanced settings.** New entries may carry contextWindow (optional; defaults otherwise). Existing models, gateway fields and the API key stay unchanged. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        configId: z.string().describe(tr('模型配置 id', 'Configuration id')),
        models: z.array(ENTRY_INPUT).describe(tr('要添加的模型条目（至少一个）', 'Model entries to add (at least one)'))
      }),
      execute: async ({ configId, models }, options) => {
        const config = writableConfig(deps, configId)
        if (typeof config === 'string') return config
        if (!models.length) return '没有给出模型：要加哪些 id？'
        const { models: next, added, skipped } = addModelEntries(config.models ?? [], models)
        if (!added.length) return `这些模型已经在「${config.name}」里了：${skipped.join(', ')}（未做修改）。`
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: '模型未添加',
          command: `给模型配置「${config.name}」添加模型：${added.join(', ')}${
            skipped.length ? `（已存在跳过：${skipped.join(', ')}）` : ''
          }`,
          toolCallId: options.toolCallId,
          toolName: 'add_model_entries'
        })
        if (refused) return refused
        try {
          const saved = deps.models.save({ ...carryOver(config), id: config.id, name: config.name, kind: config.kind, models: next })
          return JSON.stringify({
            ok: true,
            added,
            skipped,
            models: summarizeModelConfig(saved).models,
            note: '下一轮对话生效。'
          })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    update_model_entry: tool({
      description: tr(
        '修改配置下**某一个模型条目**：改 id（上游模型名，如换新版本）、改上下文窗口、改进阶设置（maxOutputTokens / toolCall / imageInput / reasoning / apiStyle）。只传要改的项，其余保持原样；`contextWindow: null` 或 `settings.xxx: null` = 清空回默认。**注意别把 toolCall 关掉**：那个模型之后就没法调用工具（你自己也会变哑巴）。修改前会弹审批卡。',
        'Edit **one model entry** inside a configuration: its id (upstream model name, e.g. bumping versions), context window, or advanced settings (maxOutputTokens / toolCall / imageInput / reasoning / apiStyle). Pass only what changes; `contextWindow: null` or `settings.xxx: null` resets to default. **Do not switch toolCall off** — that model can no longer call tools (you would go mute too). A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        configId: z.string().describe(tr('模型配置 id', 'Configuration id')),
        modelId: z.string().describe(tr('要改的模型 id（现状里的那一个）', 'Current model id to edit')),
        ...ENTRY_PATCH.shape
      }),
      execute: async ({ configId, modelId, id, contextWindow, settings }, options) => {
        const config = writableConfig(deps, configId)
        if (typeof config === 'string') return config
        if (contextWindow != null && normalizeWindow(contextWindow) === undefined) {
          return 'contextWindow 要给正整数（或 null 表示清空回默认）。'
        }
        const patched = patchModelEntry(config.models ?? [], modelId, { id, contextWindow, settings })
        if (!patched) return `「${config.name}」里没有「${modelId}」这个模型（用 list_model_configs 拿最新清单）。`
        if (patched.duplicate) return `「${patched.duplicate}」已经在清单里了，改 id 会撞车 —— 先确认是不是同一个模型。`
        const changes: string[] = []
        const nextId = id?.trim() || modelId
        if (nextId !== modelId) changes.push(`id 改为 ${nextId}`)
        if (contextWindow === null) changes.push('清空上下文窗口（走默认）')
        else if (contextWindow !== undefined) changes.push(`上下文窗口改为 ${normalizeWindow(contextWindow)}`)
        if (settings) changes.push(`进阶设置：${Object.keys(settings).join(' / ')}`)
        if (!changes.length) return '没有给出要修改的项（id / contextWindow / settings 至少给一个）。'
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: '模型条目未修改',
          command: `修改模型配置「${config.name}」里的「${modelId}」：${changes.join('、')}`,
          toolCallId: options.toolCallId,
          toolName: 'update_model_entry'
        })
        if (refused) return refused
        try {
          const saved = deps.models.save({ ...carryOver(config), id: config.id, name: config.name, kind: config.kind, models: patched.models })
          return JSON.stringify({ ok: true, models: summarizeModelConfig(saved).models, note: '下一轮对话生效。' })
        } catch (err) {
          rethrow(err)
        }
      }
    }),

    remove_model_entry: tool({
      description: tr(
        '从配置里删掉一个模型条目（网关、API key 与其它模型都留着）。删到 0 个也允许 —— 那份配置只是暂时不能用于对话。绑定这个模型的会话会失效。删除前会弹审批卡。',
        'Remove one model entry from a configuration (gateway, API key and other models stay). Emptying the list is allowed — that config just cannot be used for chat. Conversations bound to that model break. A confirmation card is shown first.'
      ),
      inputSchema: z.object({
        configId: z.string().describe(tr('模型配置 id', 'Configuration id')),
        modelId: z.string().describe(tr('要删的模型 id', 'Model id to remove'))
      }),
      execute: async ({ configId, modelId }, options) => {
        const config = writableConfig(deps, configId)
        if (typeof config === 'string') return config
        const next = removeModelEntry(config.models ?? [], modelId)
        if (!next) return `「${config.name}」里没有「${modelId}」这个模型（用 list_model_configs 拿最新清单）。`
        const refused = await guardMutation(deps, {
          needsConfirm: true,
          denied: '模型未删除',
          command: `从模型配置「${config.name}」里删除模型 ${modelId}${next.length ? '' : '（删完这份配置就没有模型了）'}`,
          toolCallId: options.toolCallId,
          toolName: 'remove_model_entry'
        })
        if (refused) return refused
        try {
          const saved = deps.models.save({ ...carryOver(config), id: config.id, name: config.name, kind: config.kind, models: next })
          return JSON.stringify({ ok: true, models: summarizeModelConfig(saved).models, note: '下一轮对话生效。' })
        } catch (err) {
          rethrow(err)
        }
      }
    })
  }
}

/** 取一份配置视图（找得到才算数）；返回字符串 = 直接回给模型的说明 */
function findConfig(deps: ModelToolsDeps, id: string): ModelView | string {
  const found = deps.models.list().find((item) => item.id === id)
  if (!found) return `找不到模型配置 ${id}（用 list_model_configs 拿最新清单）。`
  return found
}

/** 取一份**可写**的配置；插件注册的只读项回一句说明 */
function writableConfig(deps: ModelToolsDeps, id: string): ModelView | string {
  const found = findConfig(deps, id)
  if (typeof found === 'string') return found
  if (found.readOnly) return `「${found.name}」由插件注册，只能改插件（设置页里也是只读的）。`
  return found
}

/**
 * 把「这次不打算改」的字段原样带回。
 *
 * `saveModel` 是**整份重建**：`baseURL` / `apiStyle` / `temperature` / `maxTokens` /
 * `contextMessages` 不传就从结果里消失，于是「加一个模型」会顺手把这几个参数抹掉。
 */
function carryOver(config: ModelView): Partial<ModelInput> {
  return {
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(config.apiStyle ? { apiStyle: config.apiStyle } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    ...(config.contextMessages !== undefined ? { contextMessages: config.contextMessages } : {})
  }
}

