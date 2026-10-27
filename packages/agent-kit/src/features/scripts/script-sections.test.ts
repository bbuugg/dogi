/**
 * 命令面板脚本分段的顺序规则。
 *
 * 三条边界值得钉住（都是「改一行看不出、上线后才发现脚本少了」的那类）：
 * - 未分组段**恒首位**（与清单页 `ScriptsPanel` 同一口径）；
 * - 分组之间的顺序跟 `scriptGroups` 的排列走，脚本组内顺序跟 `scripts` 走；
 * - `groupId` 指向已不存在的分组 → 归到未分组，**不能丢**。
 */
import { describe, expect, it } from 'vitest'
import { scriptSections, UNGROUPED_SECTION_ID } from './script-sections'
import type { ScriptEntry, ScriptGroup } from '@fizz/contracts/types'

function script(id: string, groupId?: string): ScriptEntry {
  return {
    id,
    name: id,
    description: '',
    content: `echo ${id}`,
    ...(groupId ? { groupId } : {})
  } as ScriptEntry
}

function group(id: string, name = id): ScriptGroup {
  return { id, name } as ScriptGroup
}

/** 只关心分段骨架：[段标题, 每段的脚本 id...] */
function shape(sections: ReturnType<typeof scriptSections>) {
  return sections.map((s) => [s.heading, s.items.map((i) => i.id)])
}

describe('scriptSections', () => {
  it('未分组恒首位，其余按分组排列顺序', () => {
    const out = scriptSections(
      [script('a', 'g2'), script('b'), script('c', 'g1')],
      [group('g1'), group('g2')],
      '未分组'
    )
    expect(shape(out)).toEqual([
      ['未分组', ['b']],
      ['g1', ['c']],
      ['g2', ['a']]
    ])
    expect(out[0].id).toBe(UNGROUPED_SECTION_ID)
  })

  it('组内顺序跟脚本数组走（不按名字重排）', () => {
    const out = scriptSections(
      [script('z', 'g'), script('a', 'g')],
      [group('g')],
      '未分组'
    )
    expect(shape(out)).toEqual([['g', ['z', 'a']]])
  })

  it('groupId 指向已不存在的分组 → 归到未分组，不丢', () => {
    const out = scriptSections([script('a', 'gone')], [group('g')], '未分组')
    expect(shape(out)).toEqual([['未分组', ['a']]])
  })

  it('空分组不出段（命令面板没有拖拽落点，空标题只是噪声）', () => {
    const out = scriptSections([script('a', 'g1')], [group('g1'), group('g2')], '未分组')
    expect(shape(out)).toEqual([['g1', ['a']]])
  })

  it('全部未分组时只有一段（标题由渲染层决定要不要写）', () => {
    const out = scriptSections([script('a'), script('b')], [], '未分组')
    expect(shape(out)).toEqual([['未分组', ['a', 'b']]])
  })

  it('没有脚本时不出段', () => {
    expect(scriptSections([], [group('g')], '未分组')).toEqual([])
  })
})
