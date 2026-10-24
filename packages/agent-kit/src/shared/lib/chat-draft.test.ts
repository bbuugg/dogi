/**
 * 会话草稿存档的语义：按标签 key 隔离、空内容删除、读写失败静默。
 *
 * 这里没有业务逻辑，坏了的后果是「刷新后草稿串到别的会话」或「悄悄丢字」，
 * 所以把几条边界钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearChatDraft, loadChatDraft, saveChatDraft } from './chat-draft'

const PREFIX = 'fizz.agent.chat.draft.v1:'

class FakeStorage {
  map = new Map<string, string>()
  failWrites = false

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError')
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }
}

let storage: FakeStorage

beforeEach(() => {
  storage = new FakeStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chat-draft', () => {
  it('按标签 key 隔离并原样读回', () => {
    saveChatDraft('conv-a', '给 A 的半句话')
    saveChatDraft('conv-b', '给 B 的半句话')

    expect(loadChatDraft('conv-a')).toBe('给 A 的半句话')
    expect(loadChatDraft('conv-b')).toBe('给 B 的半句话')
    expect(loadChatDraft('conv-c')).toBeNull()
  })

  it('草稿键是「新对话」的 draft:<工作区> 时也能存', () => {
    saveChatDraft('draft:/work/repo', '还没建会话')
    expect(storage.getItem(`${PREFIX}draft:/work/repo`)).toBe('还没建会话')
  })

  it('空内容 = 删掉这一条，不留空串', () => {
    saveChatDraft('conv-a', '有字')
    saveChatDraft('conv-a', '')
    expect(storage.getItem(`${PREFIX}conv-a`)).toBeNull()
    expect(loadChatDraft('conv-a')).toBeNull()
  })

  it('显式清除同样删掉这一条', () => {
    saveChatDraft('conv-a', '有字')
    clearChatDraft('conv-a')
    expect(loadChatDraft('conv-a')).toBeNull()
  })

  it('超长草稿不落盘，且不会把旧草稿当成新内容留下', () => {
    saveChatDraft('conv-a', '旧草稿')
    saveChatDraft('conv-a', 'x'.repeat(300_000))
    expect(loadChatDraft('conv-a')).toBeNull()
  })

  it('storage 写失败 / 读失败都不抛异常', () => {
    storage.failWrites = true
    expect(() => saveChatDraft('conv-a', '写不进去')).not.toThrow()
    expect(loadChatDraft('conv-a')).toBeNull()
    expect(() => clearChatDraft('conv-a')).not.toThrow()
  })
})
