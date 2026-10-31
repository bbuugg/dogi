/**
 * `pushGate` 的判据（防的回归：用户报的「工作区不是仓库 / 明明配了远端，按快捷键推送却弹
 * 『管理远端』」）。
 *
 * 两条来路都值得钉住：
 * 1. **不是仓库**时必须 `not-repo` —— 以前面板只看 `remotes.length === 0`，非仓库的
 *    `remotes` 也是空数组，于是开出一个填了也没用的「管理远端」弹窗；
 * 2. **状态还没到**（`null`）必须 `unknown` —— 以前 `status?.remotes.length === 0` 对
 *    `null` 判不出东西，继续往下发请求；一旦有人「顺手」把 `null` 归成空数组，就会退回到
 *    第 1 条那种误弹。
 */
import { describe, expect, it } from 'vitest'
import { pushBlockedMessage, pushGate } from './push-policy'

const repo = (extra?: { detached?: boolean; remotes?: string[] }) => ({
  isRepo: true,
  detached: extra?.detached ?? false,
  remotes: (extra?.remotes ?? ['origin']).map((name) => ({ name, url: `https://example.com/${name}.git` }))
})

describe('pushGate', () => {
  it('状态没拿到时是 unknown（既不能推，也不能当成「没有远端」）', () => {
    expect(pushGate(null)).toBe('unknown')
  })

  it('不是仓库时是 not-repo —— 这时绝不能走「没有远端 → 开管理远端」那条路', () => {
    expect(pushGate({ isRepo: false, detached: false, remotes: [] })).toBe('not-repo')
  })

  it('是仓库但没有远端 → no-remote（这才是该开「管理远端」的情况）', () => {
    expect(pushGate(repo({ remotes: [] }))).toBe('no-remote')
  })

  it('是仓库且有远端 → ok', () => {
    expect(pushGate(repo())).toBe('ok')
  })

  it('分离头指针优先于远端判断', () => {
    expect(pushGate(repo({ detached: true }))).toBe('detached')
    expect(pushGate(repo({ detached: true, remotes: [] }))).toBe('detached')
  })

  it('显式挑了远端就不在本地拦（远端是否存在由服务端说了算）', () => {
    expect(pushGate(repo({ remotes: ['a', 'b'] }), 'b')).toBe('ok')
  })
})

describe('pushBlockedMessage', () => {
  it('not-repo 的话必须提「不是仓库」，别让人以为是缺远端', () => {
    const text = pushBlockedMessage('not-repo')
    expect(text).toContain('还不是 git 仓库')
    expect(text).not.toContain('远端')
  })

  it('ok / no-remote 不说话（前者直接推，后者开弹窗）', () => {
    expect(pushBlockedMessage('ok')).toBeNull()
    expect(pushBlockedMessage('no-remote')).toBeNull()
  })

  it('detached / unknown 各有一句', () => {
    expect(pushBlockedMessage('detached')).toContain('分离头指针')
    expect(pushBlockedMessage('unknown')).toContain('稍等')
  })
})
