import { describe, expect, it } from 'vitest'
import { pickContainer } from './container-carry'

describe('pickContainer —— 重命名 / 重新登记时容器配置不丢', () => {
  it('重命名只传 name 时保留旧 container', () => {
    const prev = { slug: 'abc', image: 'node', createdAt: 1 } as const
    expect(pickContainer(undefined, prev as never, undefined)).toEqual(prev)
  })

  it('换目录（byPath 命中）时保留 container', () => {
    const byPath = { slug: 'xyz', image: 'php', createdAt: 2 } as const
    expect(pickContainer(undefined, undefined, byPath as never)).toEqual(byPath)
  })

  it('显式传入 container 覆盖旧值', () => {
    const next = { slug: 'new', image: 'golang', createdAt: 3 } as const
    expect(pickContainer(next as never, { slug: 'old' } as never, undefined)).toEqual(next)
  })

  it('三个都没有时返回 undefined（普通项目）', () => {
    expect(pickContainer(undefined, undefined, undefined)).toBeUndefined()
  })
})
