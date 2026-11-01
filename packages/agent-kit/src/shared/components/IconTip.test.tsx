/**
 * `IconTip` 与「自带 `data-state` 的控件」的相容性。
 *
 * 防的回归（用户报的「定时任务详情里那颗启停开关看不见，只有悬停才冒 tooltip」）：
 *
 * - `TooltipTrigger asChild` 会往子元素注 `data-state="closed" | "delayed-open"`；
 * - Radix 的 `Switch` / `Checkbox` / `Toggle` 恰恰靠 `data-state="checked" | "unchecked"`
 *   决定轨道颜色，而且它们内部把外部传进来的 props 排在自带的 `data-state` **之后** ——
 *   tooltip 那个值会把它盖掉（实测渲染出来就是
 *   `<button role="switch" aria-checked="true" data-state="closed" …>`）；
 * - 于是样式表里所有 `data-checked:` / `data-unchecked:` 规则一起失效：轨道没有背景色，
 *   拇指又是 `bg-background`（与面板同色）→ 整个控件看起来「不存在」，只有 tooltip 还在。
 *
 * 结论（也是本文件的断言）：这类控件必须**包一层 `<span>` 当触发器**，不能直接套。
 *
 * 用 `react-dom/server` 的静态渲染就够 —— 要验的是属性合并的结果，不需要 DOM 环境
 * （本仓没有 jsdom，见 AGENTS.md 的测试一节）。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { Switch } from '@fizz/ui/switch'
import { TooltipProvider } from '@fizz/ui/tooltip'
import { IconTip } from './IconTip'

const noop = (): void => {}

/** Radix 的 Tooltip 必须在 Provider 里（应用里由外壳挂），测试里自己包一层 */
const render = (node: ReactNode): string =>
  renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)

/**
 * 取「开关根节点」那个标签的原文。
 *
 * ⚠️ 不能直接对整段 HTML 找 `data-state="checked"`：拇指（`switch-thumb`）**永远**带着
 * checked（tooltip 只碰根节点），所以那样断言会永远为真、测不出问题。
 */
function rootTag(html: string): string {
  const start = html.indexOf('<button')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = html.indexOf('>', start)
  return html.slice(start, end + 1)
}

describe('IconTip 与自带 data-state 的控件', () => {
  it('裸 Switch 的根节点是 checked（基准）', () => {
    const root = rootTag(render(<Switch checked onCheckedChange={noop} />))
    expect(root).toContain('data-state="checked"')
    expect(root).toContain('data-checked:bg-primary')
  })

  it('直接套在 IconTip 上会把根节点的 checked 顶掉（就是那个「按钮不见了」的坑）', () => {
    const root = rootTag(
      render(
        <IconTip label="停用">
          <Switch checked onCheckedChange={noop} />
        </IconTip>
      )
    )
    // 钉住这个坑：tooltip 的 closed 盖掉了 checked → `data-checked:` 全都不命中。
    // 哪天 Radix 不再覆盖，这条会变红 —— 那时再把它改成「两者共存」，
    // 而不是把下面那条 span 写法删掉（外层包一层本来就无害）。
    expect(root).toContain('data-state="closed"')
    expect(root).not.toContain('data-state="checked"')
  })

  it('包一层 span 当触发器时，Switch 根节点保住 checked', () => {
    const html = render(
      <IconTip label="停用">
        <span className="inline-flex items-center">
          <Switch checked onCheckedChange={noop} />
        </span>
      </IconTip>
    )
    // 两个 data-state 各归各的：span 上是 tooltip 的 closed，Switch 上是 checked
    expect(rootTag(html)).toContain('data-state="checked"')
    expect(html).toContain('data-state="closed"')
  })
})
