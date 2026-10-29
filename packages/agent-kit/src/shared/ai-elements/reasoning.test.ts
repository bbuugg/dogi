import { describe, expect, it } from 'vitest'

import { reasoningPreview } from './reasoning'

/**
 * 这些用例守的是 `ReasoningPreview` 的两条判据：
 *
 * 1. `line` 只能是**最后一行**（一行高的窗口里跟最新内容走）；
 * 2. `lineKey` 必须**只在真的出现换行时**变化 —— 界面靠它决定「整行往上滚一格」。
 *    第二条尤其容易写错：直觉上会用「新文本不是旧文本的前缀」来判换行，但下面剥
 *    markdown 记号时 `**bo` → `bo` 就不是前缀了，会凭空滚一下。
 */
describe('reasoningPreview', () => {
  it('只取最后一行', () => {
    expect(reasoningPreview('第一行\n第二行').line).toBe('第二行')
    expect(reasoningPreview('只有一行').line).toBe('只有一行')
  })

  it('没有换行时 lineKey 为 -1', () => {
    expect(reasoningPreview('只有一行').lineKey).toBe(-1)
  })

  it('lineKey 只在换行时变', () => {
    const a = reasoningPreview('第一行')
    const b = reasoningPreview('第一行，还在写')
    const c = reasoningPreview('第一行，还在写\n第二')
    expect(b.lineKey).toBe(a.lineKey)
    expect(c.lineKey).toBeGreaterThan(b.lineKey)
  })

  it('剥 markdown 记号造成的前缀断裂不算换行', () => {
    // 行首只有一个「-」时还剥不掉（记号后面还没有空格），凑成「- 列表项」才剥得掉 ——
    // 文本从「-」变成「列表项」，不是前缀关系，但并没有换行
    const dash = reasoningPreview('前文\n-')
    const item = reasoningPreview('前文\n- 列表项')
    expect(dash.line).toBe('-')
    expect(item.line).toBe('列表项')
    expect(item.line.startsWith(dash.line)).toBe(false)
    expect(item.lineKey).toBe(dash.lineKey)
  })

  it('剥掉行首的标题 / 引用 / 列表记号', () => {
    expect(reasoningPreview('## 小标题').line).toBe('小标题')
    expect(reasoningPreview('> 引用').line).toBe('引用')
    expect(reasoningPreview('- 列表项').line).toBe('列表项')
    expect(reasoningPreview('3. 第三项').line).toBe('第三项')
  })

  it('「-5 是负数」的减号不是列表记号', () => {
    expect(reasoningPreview('-5 是负数').line).toBe('-5 是负数')
  })

  it('剥掉行内代码 / 粗体 / 链接 / 强调记号', () => {
    expect(reasoningPreview('看 `code` 这里').line).toBe('看 code 这里')
    expect(reasoningPreview('**重点**').line).toBe('重点')
    expect(reasoningPreview('[文字](https://x.y)').line).toBe('文字')
    expect(reasoningPreview('~~删掉~~').line).toBe('删掉')
  })

  it('换行之后行首记号照样剥掉', () => {
    expect(reasoningPreview('前一行\n  - 第二行').line).toBe('第二行')
  })
})
