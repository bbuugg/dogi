/**
 * 子任务偏好归一化：步数上限是**用户手填**的，必须当成不可信输入。
 *
 * 防的是三件事：手改坏的数据文件让读接口抛错；越界值被悄悄夹到边界，用户看不出
 * 「我填的 500 变成了 128」；未知 id 混进 maxSteps 让设置页渲染出一个不存在的子任务。
 */
import { describe, expect, it } from 'vitest'
import {
  SUBAGENT_MAX_STEPS,
  SUBAGENT_MIN_STEPS,
  normalizeSubagentSettings
} from './types'

describe('normalizeSubagentSettings · 步数上限', () => {
  it('范围内的整数原样保留（按 id 分开）', () => {
    const settings = normalizeSubagentSettings({ maxSteps: { explorer: 30, reviewer: 12 } })

    expect(settings.maxSteps).toEqual({ explorer: 30, reviewer: 12 })
  })

  it('越界值整条丢弃（回到默认），不夹到边界', () => {
    const settings = normalizeSubagentSettings({
      maxSteps: { explorer: SUBAGENT_MAX_STEPS + 1, reviewer: SUBAGENT_MIN_STEPS - 1 }
    })

    expect(settings.maxSteps).toBeUndefined()
  })

  it('边界值本身是合法的', () => {
    const settings = normalizeSubagentSettings({
      maxSteps: { explorer: SUBAGENT_MAX_STEPS, reviewer: SUBAGENT_MIN_STEPS }
    })

    expect(settings.maxSteps).toEqual({
      explorer: SUBAGENT_MAX_STEPS,
      reviewer: SUBAGENT_MIN_STEPS
    })
  })

  it('非数字 / NaN / 未知 id 一律丢掉', () => {
    const settings = normalizeSubagentSettings({
      maxSteps: {
        explorer: '20',
        reviewer: Number.NaN,
        // 手改坏的数据文件里什么都可能有；参数是 unknown，所以这里能塞得进去
        coder: 20
      }
    })

    expect(settings.maxSteps).toBeUndefined()
  })

  it('小数截断成整数；全被丢掉时不留下空对象', () => {
    expect(normalizeSubagentSettings({ maxSteps: { explorer: 12.9 } }).maxSteps).toEqual({
      explorer: 12
    })
    expect(normalizeSubagentSettings({ maxSteps: {} }).maxSteps).toBeUndefined()
  })

  it('没设步数时结果里不出现这个字段（老数据不受影响）', () => {
    expect('maxSteps' in normalizeSubagentSettings({ enabled: ['explorer'] })).toBe(false)
  })
})
