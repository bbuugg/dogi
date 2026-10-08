import type { AiModelConfig } from '@shared/types'

/**
 * 配置下的可用模型列表：新数据在 `models` 数组，兼容只有旧 `model` 单值的记录。
 * 两者皆空 = 这条配置没有可用模型 —— 下拉与「已配置」判定都必须把它排除，
 * 否则会渲染出 label 为 undefined 的选项，选中后请求也解析不出模型。
 */
export function configModels(config: AiModelConfig): string[] {
  const list = config.models?.length ? config.models : config.model ? [config.model] : []
  return list.filter(Boolean)
}

/** 该配置 id 是否指向一条「有可用模型」的配置（undefined / 不存在 / 无模型都算否） */
export function hasUsableConfig(configs: AiModelConfig[], id?: string | null): boolean {
  if (!id) return false
  const config = configs.find((c) => c.id === id)
  return !!config && configModels(config).length > 0
}

// ---------------------------------------------------------------------------
// 模型下拉的选项：按「模型配置」分组
// ---------------------------------------------------------------------------

/** antd Select 的分组形态（`{ label, options }`） */
export interface ModelOptionGroup {
  label: string
  options: { value: string; label: string }[]
}

/**
 * 把模型 id 编码成下拉的选中值。
 *
 * ⚠️ 这个编码是**跨模块契约**（构建选项的这里、解析的 `parseCfgModelValue`、
 * 以及两处 `modelSelectValue` 的当前值都要用同一套），别在别处手写模板串。
 */
export function cfgModelValue(configId: string, modelId: string): string {
  return `cfg:${configId}:${modelId}`
}

/**
 * 解析 `cfg:<配置id>:<模型id>`。
 *
 * ⚠️ **必须按第一个冒号切，不能 `value.split(':')` 再取第 3 段** —— 模型 id 自己
 * 经常带冒号（Ollama 的 `llama3:8b`、OpenRouter 的 `…:beta` / `…:free`），
 * 用 split 会把 id 从第一个冒号处截断，表现为「选了 A 实际发的是 B」这种静默错配。
 */
export function parseCfgModelValue(value: string): { configId: string; modelId: string } | null {
  if (!value.startsWith('cfg:')) return null
  const at = value.indexOf(':', 4)
  if (at < 0) return null
  return { configId: value.slice(4, at), modelId: value.slice(at + 1) }
}

/**
 * mastra 会话的模型下拉选项：**每条配置一个顶层分组**，组内是该配置的裸模型 id。
 *
 * 为什么这样分组：一份配置下可以挂很多模型（同一个 baseURL 下的 gpt-5.1 / gpt-5.1-mini），
 * 用户挑模型时的心智是「先选哪个网关/账号，再选哪个模型」，按配置分组正好对上。
 *
 * ⚠️ 只能有**一层**分组（antd 6 的 `@rc-component/select` 在 `flattenOptions` 里把
 * 「组的子项」一律当可选 option、不再下钻）：想再套一层「AI 模型 > 配置 > 模型」会让
 * 内层分组变成 `value: undefined` 的选项 —— 模型一个都不渲染、点了也没反应。
 * 所以配置**直接就是顶层分组**，而不是塞进一个「AI 模型」大组里（见 6.5 第 11 条）。
 *
 * 没有可用模型的配置**不产出空分组**（组头下面一条都没有，看着像坏了）。
 */
export function configModelGroups(configs: AiModelConfig[]): ModelOptionGroup[] {
  return configs
    .map((config) => ({ config, models: configModels(config) }))
    .filter((entry) => entry.models.length > 0)
    .map((entry) => ({
      label: entry.config.name,
      options: entry.models.map((m) => ({
        value: cfgModelValue(entry.config.id, m),
        label: m
      }))
    }))
}
