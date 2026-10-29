/**
 * `replaceTab`：把某一颗标签**就地换掉**，其它标签原样保留。
 *
 * 钉住的是这个 bug：「新对话」草稿标签（`__new__`）里发出第一条消息建出真实会话后，
 * 草稿应当**变成**那张会话标签。原来只有「面板上只剩这一张草稿」时才就地替换，一旦
 * 用户还开着别的会话 / 终端标签（极常见：从某条会话里点「新建对话」），就会改成
 * `openTab` 新开一张 —— 于是草稿留着、又并排多出一张对话标签，看起来像「发个消息
 * 怎么又开了一个对话」。
 *
 * 这里也钉住「不能退化成 `syncTabs([key])`」：那会把旁边开着的标签一起摘掉。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { NEW_TAB_KEY } from './panel-tabs'
import {
  activeTabKey,
  allTabKeys,
  openTab,
  replaceTab,
  resetLayout
} from './panel-store'

describe('replaceTab', () => {
  beforeEach(() => resetLayout([]))

  it('草稿是唯一标签时，就地换成新会话', () => {
    openTab(NEW_TAB_KEY)
    replaceTab(NEW_TAB_KEY, 'conv-1')
    expect(allTabKeys()).toEqual(['conv-1'])
    expect(activeTabKey()).toBe('conv-1')
  })

  it('旁边还开着别的标签时，只换草稿，其它标签原样保留（bug 本身）', () => {
    openTab('conv-a')
    openTab(NEW_TAB_KEY)
    // 用户在草稿页发消息：草稿是焦点组的活动标签
    expect(activeTabKey()).toBe(NEW_TAB_KEY)

    replaceTab(NEW_TAB_KEY, 'conv-b')

    // 位置保持（替换，而不是追加到末尾）、别的会话没被摘掉、焦点落到新会话
    expect(allTabKeys()).toEqual(['conv-a', 'conv-b'])
    expect(activeTabKey()).toBe('conv-b')
  })

  it('草稿挂在后台时替换也保留旁边标签（不依赖焦点）', () => {
    openTab(NEW_TAB_KEY)
    openTab('conv-a') // 焦点到了 conv-a
    replaceTab(NEW_TAB_KEY, 'conv-b')
    expect(allTabKeys()).toEqual(['conv-b', 'conv-a'])
  })

  it('新 key 已经在别处开着时不会出现两份', () => {
    openTab(NEW_TAB_KEY)
    openTab('conv-b')
    replaceTab(NEW_TAB_KEY, 'conv-b')
    expect(allTabKeys()).toEqual(['conv-b'])
    expect(activeTabKey()).toBe('conv-b')
  })

  it('旧 key 已经不在时退化成普通打开，不把新会话弄丢', () => {
    openTab('conv-a')
    replaceTab(NEW_TAB_KEY, 'conv-b')
    expect(allTabKeys()).toEqual(['conv-a', 'conv-b'])
    expect(activeTabKey()).toBe('conv-b')
  })

  it('oldKey === newKey 是空操作', () => {
    openTab('conv-a')
    replaceTab('conv-a', 'conv-a')
    expect(allTabKeys()).toEqual(['conv-a'])
  })
})
