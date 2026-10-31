/**
 * 这组用例在防什么回归：
 *
 * 1. `domain.saveModel` 是**整份替换**语义（`models` 整份写回）。所以「加一个模型 / 改一个
 *    模型的窗口」必须把其余条目原样带回 —— 早写错一次就是「改个窗口，别的模型全没了」。
 * 2. 模型条目的 `settings` 用「缺省不落盘」口径（`true` = 删键）。写成 `settings.toolCall = true`
 *    会让数据文件里堆一堆无意义的显式 true，而设置页判的是「有没有这个键」。
 * 3. `summarizeModelConfig` 是给模型看的视图，**绝不能**把 apiKey 明文带出去。
 */
import { describe, expect, it } from 'vitest'
import type { AiModelEntry } from '@fizz/contracts/types'
import type { ModelView } from '@fizz/contracts/agent-api'
import {
  addModelEntries,
  applySettingsPatch,
  patchModelEntry,
  removeModelEntry,
  summarizeModelConfig
} from './model-tools'

/** 每例一份新数组：这些函数都是纯函数，但共享 fixtures 迟早被某条用例改脏 */
function fixture(): AiModelEntry[] {
  return [{ id: 'gpt-4o', contextWindow: 128000, settings: { toolCall: false } }, { id: 'gpt-4o-mini' }]
}

describe('addModelEntries', () => {
  it('只追加新 id：已存在的跳过、不覆盖原有窗口与设置', () => {
    const { models, added, skipped } = addModelEntries(fixture(), [
      { id: ' o1 ' },
      { id: 'gpt-4o', contextWindow: 512 },
      { id: 'o3', contextWindow: 200000 }
    ])
    expect(added).toEqual(['o1', 'o3'])
    expect(skipped).toEqual(['gpt-4o'])
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'o1', 'o3'])
    // 原有条目一字不改
    expect(models[0]).toEqual({ id: 'gpt-4o', contextWindow: 128000, settings: { toolCall: false } })
    // 缺省窗口不落空字段；给了的按整数存
    expect(models[2]).toEqual({ id: 'o1' })
    expect(models[3].contextWindow).toBe(200000)
  })

  it('空 id 直接丢掉（上游清单里混进空串时不该产生一个无 id 的条目）', () => {
    const { models, added } = addModelEntries([], [{ id: '   ' }])
    expect(models).toEqual([])
    expect(added).toEqual([])
  })

  it('非法窗口当没给（0 / 负数不该把窗口钉成 0）', () => {
    const { models } = addModelEntries([], [{ id: 'x', contextWindow: 0 }, { id: 'y', contextWindow: -1 }])
    expect(models).toEqual([{ id: 'x' }, { id: 'y' }])
  })
})

describe('patchModelEntry', () => {
  it('改 id 时窗口与设置整条搬走，其余条目不动', () => {
    const patched = patchModelEntry(fixture(), 'gpt-4o', { id: 'gpt-4.1' })
    expect(patched?.models.map((m) => m.id)).toEqual(['gpt-4.1', 'gpt-4o-mini'])
    expect(patched?.models[0]).toEqual({
      id: 'gpt-4.1',
      contextWindow: 128000,
      settings: { toolCall: false }
    })
  })

  it('改成已存在的 id 时报 duplicate，且清单不变', () => {
    const before = fixture()
    const patched = patchModelEntry(before, 'gpt-4o', { id: 'gpt-4o-mini' })
    expect(patched?.duplicate).toBe('gpt-4o-mini')
    expect(patched?.models).toEqual(before)
  })

  it('找不到条目返回 null（调用方据此回一句人话，而不是静默成功）', () => {
    expect(patchModelEntry(fixture(), 'nope', { contextWindow: 1024 })).toBeNull()
  })

  it('contextWindow: null = 显式清空（走默认兜底），不是「保持原样」', () => {
    const patched = patchModelEntry(fixture(), 'gpt-4o', { contextWindow: null })
    expect(patched?.models[0]).toEqual({ id: 'gpt-4o', settings: { toolCall: false } })
    expect('contextWindow' in (patched?.models[0] ?? {})).toBe(false)
  })

  it('只传 settings 时保留原窗口', () => {
    const patched = patchModelEntry(fixture(), 'gpt-4o', { settings: { imageInput: false } })
    expect(patched?.models[0]).toEqual({
      id: 'gpt-4o',
      contextWindow: 128000,
      settings: { toolCall: false, imageInput: false }
    })
  })
})

describe('applySettingsPatch', () => {
  it('true = 删掉那个键（缺省即允许），false = 显式落盘', () => {
    const next = applySettingsPatch({ toolCall: false, reasoning: false }, { toolCall: true, imageInput: false })
    expect(next).toEqual({ reasoning: false, imageInput: false })
  })

  it('maxOutputTokens: null 或非法值 = 清空（不是写 0）', () => {
    expect(applySettingsPatch({ maxOutputTokens: 4096 }, { maxOutputTokens: null })).toEqual({})
    expect(applySettingsPatch({ maxOutputTokens: 4096 }, { maxOutputTokens: 0 })).toEqual({})
    expect(applySettingsPatch({}, { maxOutputTokens: 2048 })).toEqual({ maxOutputTokens: 2048 })
  })

  it('apiStyle: null 清回「跟随 kind 默认」', () => {
    expect(applySettingsPatch({ apiStyle: 'responses' }, { apiStyle: null })).toEqual({})
    expect(applySettingsPatch({}, { apiStyle: 'chat-completions' })).toEqual({ apiStyle: 'chat-completions' })
  })
})

describe('removeModelEntry', () => {
  it('摘掉一个、其余保留', () => {
    expect(removeModelEntry(fixture(), 'gpt-4o')?.map((m) => m.id)).toEqual(['gpt-4o-mini'])
  })

  it('删到 0 个也允许（只是暂时不能用于对话，不带走网关与 key）', () => {
    const left = removeModelEntry([{ id: 'only' }], 'only')
    expect(left).toEqual([])
  })

  it('没有这个 id 返回 null', () => {
    expect(removeModelEntry(fixture(), 'nope')).toBeNull()
  })
})

describe('summarizeModelConfig', () => {
  it('绝不带 apiKey 明文，只报 hasApiKey', () => {
    // 模拟「服务端视图对象里混进了密钥」这种错误实现
    const view = {
      id: 'm1',
      name: '中转',
      kind: 'openai-compatible',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5',
      models: [{ id: 'qwen2.5', contextWindow: 32000 }],
      hasApiKey: true,
      apiKey: 'sk-secret-should-never-leak'
    } as unknown as ModelView
    const summary = summarizeModelConfig(view)
    expect(JSON.stringify(summary)).not.toContain('sk-secret-should-never-leak')
    expect(summary.hasApiKey).toBe(true)
    expect(summary.models).toEqual([{ id: 'qwen2.5', contextWindow: 32000 }])
  })

  it('插件注册的只读项带上 readOnly / sourceName，便于模型知道「改不了」', () => {
    const summary = summarizeModelConfig({
      id: 'p1',
      name: '插件模型',
      kind: 'openai',
      model: 'x',
      models: [{ id: 'x' }],
      hasApiKey: false,
      readOnly: true,
      sourceName: 'MyPlugin'
    } as ModelView)
    expect(summary.readOnly).toBe(true)
    expect(summary.sourceName).toBe('MyPlugin')
  })
})
