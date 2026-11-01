/**
 * 步数预算这套东西的纯函数：系统提示词里的**静态**预算说明（`prompt.ts`）+ 步骤边界的
 * **动态**提醒与它的幂等注入（`prompt.ts` / `agent.ts`）。
 *
 * 防三个回归：
 *
 * 1. **把「还剩几步」写进系统提示词**：那是请求最前面的几 k token，一随步数变化，上游
 *    前缀缓存就从第一个 token 起全部失效（每步按全价重读整段历史）。这里钉住「静态那段
 *    只说总量」。
 * 2. **边界提醒每步都 append**：`prepareStep` 返回的 messages 会一路带到后面的步骤，直接
 *    push 会在 8 个边界上堆出 8 条互相矛盾的「还剩 N 步」。
 * 3. **靠下标找回上一条提醒**：轮中压缩会把消息数组重排，下标一失效就又变回 append。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '@fizz/i18n'
import {
  STEP_BUDGET_MARKER,
  stepBudgetHint,
  stepBudgetRemaining,
  stepBudgetReminder,
  stepBudgetWarnSteps
} from './prompt'
import { applyStepBudgetReminder } from './agent'

afterEach(() => setLanguage('zh'))

describe('系统提示词里的预算说明', () => {
  it('只说总量，绝不出现「还剩」', () => {
    const hint = stepBudgetHint(80)
    expect(hint).toContain('80')
    expect(hint).toContain('步')
    expect(hint).not.toContain('还剩')
  })

  it('切成英文后换一份文案（同一段约定两种语言都有）', () => {
    setLanguage('en')
    const hint = stepBudgetHint(40)
    expect(hint).toContain('40 tool steps')
    expect(hint).not.toContain('步工具预算')
  })
})

describe('预算提醒', () => {
  it('剩余步数按「预算 - 已跑」算', () => {
    expect(stepBudgetRemaining({ maxSteps: 80, used: 72 })).toBe(8)
    expect(stepBudgetRemaining({ maxSteps: 80, used: 79 })).toBe(1)
  })

  it('提醒区起点随预算缩放，但夹在 [3, 8]', () => {
    // 预算很小时按比例只剩 1~2 步，来不及收尾 → 至少给 3 步
    expect(stepBudgetWarnSteps(12)).toBe(3)
    // 预算很大时按比例会到 12 步（太啰嗦）→ 封顶 8 步
    expect(stepBudgetWarnSteps(80)).toBe(8)
    // 中间档按 15% 算
    expect(stepBudgetWarnSteps(30)).toBe(5)
  })

  it('最后一步是「不许再调工具」的硬口吻，且带固定标记', () => {
    const text = stepBudgetReminder({ maxSteps: 80, used: 79 })
    expect(text.startsWith(STEP_BUDGET_MARKER)).toBe(true)
    expect(text).toContain('最后一步')
    expect(text).toContain('不要再调用任何工具')
  })

  it('提醒区里报的是「已用 / 总量 / 还剩」三个数', () => {
    const text = stepBudgetReminder({ maxSteps: 80, used: 74 })
    expect(text).toContain('74 / 80')
    expect(text).toContain('还剩 6 步')
  })
})

describe('applyStepBudgetReminder', () => {
  const user = (text: string) =>
    ({ role: 'user', content: [{ type: 'text', text }] }) as never
  const textOf = (message: { content: unknown }): string =>
    Array.isArray(message.content)
      ? ((message.content[0] as { text?: string }).text ?? '')
      : ''

  it('第一次追加到消息尾部', () => {
    const out = applyStepBudgetReminder([user('历史')], '提醒 A')
    expect(out).toHaveLength(2)
    expect(textOf(out[1])).toBe('提醒 A')
  })

  it('再次注入是原地替换，不会堆出两条', () => {
    // ⚠️ 认的是**固定标记**（真实提醒都以它开头）：不带标记的 user 消息一律当普通消息，
    // 绝不替换 —— 否则一句用户自己说的「还剩 8 步」会被系统提示顶掉。
    const first = applyStepBudgetReminder([user('历史')], `${STEP_BUDGET_MARKER}还剩 8 步`)
    const second = applyStepBudgetReminder(first, `${STEP_BUDGET_MARKER}还剩 7 步`)
    expect(second).toHaveLength(2)
    expect(textOf(second[1])).toBe(`${STEP_BUDGET_MARKER}还剩 7 步`)
    expect(second.filter((m) => textOf(m).includes('还剩'))).toHaveLength(1)
  })

  it('不带标记的普通 user 消息不会被顶掉', () => {
    const out = applyStepBudgetReminder([user('还剩 8 步吗？')], `${STEP_BUDGET_MARKER}还剩 3 步`)
    expect(out).toHaveLength(2)
    expect(textOf(out[0])).toBe('还剩 8 步吗？')
  })

  it('数组被重排（轮中压缩）后仍按内容标记找回旧提醒', () => {
    // 压缩后的形状：摘要消息顶上来、旧提醒被挪到中间，顺序与插入时完全不同
    const compacted = [
      user('摘要'),
      user(`${STEP_BUDGET_MARKER}还剩 8 步`),
      user('用户插话')
    ]
    const out = applyStepBudgetReminder(compacted, `${STEP_BUDGET_MARKER}还剩 3 步`)
    expect(out).toHaveLength(3)
    expect(textOf(out[1])).toBe(`${STEP_BUDGET_MARKER}还剩 3 步`)
    expect(textOf(out[2])).toBe('用户插话')
  })

  it('不传文案时原样返回（不进提醒区就一个字都不动）', () => {
    const input = [user('历史')]
    expect(applyStepBudgetReminder(input, null)).toBe(input)
  })
})
