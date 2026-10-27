/**
 * 命令面板「运行脚本」的分段规则（**纯函数、零依赖**，单测直接跑它）。
 *
 * 抽出来是因为这条规则有两个容易漂的点：
 * - 「未分组」段的位置（与清单页一样**恒首位**）；
 * - `groupId` 指向已不存在的分组（分组被删、脚本没跟上）时算哪一边 —— 按未分组处理，
 *   否则那条脚本会在列表里凭空消失。
 *
 * 空分组**不出段**：清单页要显示它是因为那是拖拽落点，命令面板没有拖拽。
 */
import type { ScriptEntry, ScriptGroup } from '@fizz/contracts/types'

/** 未分组段的固定 id（不与真实分组 id 冲突，只做 React key） */
export const UNGROUPED_SECTION_ID = '__ungrouped__'

export interface ScriptSection {
  /** React key：未分组段是 {@link UNGROUPED_SECTION_ID}，其余是分组 id */
  id: string
  /** 段标题（未分组段是调用方传进来的本地化文案） */
  heading: string
  items: ScriptEntry[]
}

export function scriptSections(
  scripts: ScriptEntry[],
  groups: ScriptGroup[],
  ungroupedLabel: string
): ScriptSection[] {
  const known = new Set(groups.map((g) => g.id))
  const ungrouped: ScriptEntry[] = []
  const byGroup = new Map<string, ScriptEntry[]>()
  for (const script of scripts) {
    if (script.groupId && known.has(script.groupId)) {
      const list = byGroup.get(script.groupId)
      if (list) list.push(script)
      else byGroup.set(script.groupId, [script])
    } else {
      ungrouped.push(script)
    }
  }
  const out: ScriptSection[] = []
  if (ungrouped.length > 0) {
    out.push({ id: UNGROUPED_SECTION_ID, heading: ungroupedLabel, items: ungrouped })
  }
  for (const group of groups) {
    const items = byGroup.get(group.id)
    if (items?.length) out.push({ id: group.id, heading: group.name, items })
  }
  return out
}
