/**
 * 防的回归：偏好总线是「设置窗口改完 → 别的窗口重读」的唯一通道，分发错了的表现很隐蔽
 * —— 要么改了不生效（漏发），要么一个变更把整屏订阅全刷一遍（多发给通配 + 具体 key）。
 *
 * 这里只测 `createPrefsHub`（纯记账，不碰 window）：浏览器那一层只是把 `storage` 事件
 * 喂给 `dispatch` / `dispatchAll`，node 环境测不了也不需要测。
 */
import { describe, expect, it, vi } from 'vitest'
import { createPrefsHub } from './prefs-sync'

describe('prefs-sync', () => {
  it('只通知订了这个 key 的人', () => {
    const hub = createPrefsHub()
    const onRetries = vi.fn()
    const onTheme = vi.fn()
    hub.subscribe('fizz.web.maxRetries', onRetries)
    hub.subscribe('fizz.web.theme', onTheme)

    hub.dispatch('fizz.web.maxRetries')

    expect(onRetries).toHaveBeenCalledTimes(1)
    expect(onTheme).not.toHaveBeenCalled()
  })

  it('没人订的 key 不炸也不误伤', () => {
    const hub = createPrefsHub()
    const onRetries = vi.fn()
    hub.subscribe('fizz.web.maxRetries', onRetries)

    expect(() => hub.dispatch('fizz.web.nobody')).not.toThrow()
    expect(onRetries).not.toHaveBeenCalled()
  })

  it("'*' 订阅者收所有 key；整店清空时也只收一次", () => {
    const hub = createPrefsHub()
    const onAny = vi.fn()
    const onRetries = vi.fn()
    hub.subscribe('*', onAny)
    hub.subscribe('fizz.web.maxRetries', onRetries)

    hub.dispatch('fizz.web.theme')
    expect(onAny).toHaveBeenCalledTimes(1)

    // 清空存储（登出清场）：两个订阅者各一次，订阅了两个 key 的人不会被调两次
    hub.dispatchAll()
    expect(onAny).toHaveBeenCalledTimes(2)
    expect(onRetries).toHaveBeenCalledTimes(1)
  })

  it('同一个回调既订具体 key 又订通配时，一次变更只调一次', () => {
    const hub = createPrefsHub()
    const onChange = vi.fn()
    hub.subscribe('*', onChange)
    hub.subscribe('fizz.web.maxRetries', onChange)

    hub.dispatch('fizz.web.maxRetries')

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('退订只摘自己，不影响同 key 的其它订阅者', () => {
    const hub = createPrefsHub()
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = hub.subscribe('fizz.web.maxRetries', first)
    hub.subscribe('fizz.web.maxRetries', second)

    offFirst()
    hub.dispatch('fizz.web.maxRetries')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('退订通配也不会顺手清掉具体 key 的订阅', () => {
    const hub = createPrefsHub()
    const onAny = vi.fn()
    const onRetries = vi.fn()
    const offAny = hub.subscribe('*', onAny)
    hub.subscribe('fizz.web.maxRetries', onRetries)

    offAny()
    hub.dispatch('fizz.web.maxRetries')

    expect(onAny).not.toHaveBeenCalled()
    expect(onRetries).toHaveBeenCalledTimes(1)
  })
})
