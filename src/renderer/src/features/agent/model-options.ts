import type { ReactNode } from 'react'
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

/**
 * 下拉**选中后**显示在横条上的文字：只留模型名，不要提供商前缀。
 *
 * 选项的 label 是 `提供商 · 模型` —— 展开时靠它区分同名模型属于哪条配置，
 * 但收起后那点宽度里前缀会把模型名本身挤掉。这里截掉最后一个 ` · `（含）之前的部分；
 * 没有该分隔符的（ACP agent 名、管理项等）原样返回，非字符串（自定义节点）不动。
 */
export function modelNameOnly(label: ReactNode): ReactNode {
  if (typeof label !== 'string') return label
  const at = label.lastIndexOf(' · ')
  return at === -1 ? label : label.slice(at + 3)
}
