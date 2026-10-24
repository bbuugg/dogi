import { describe, expect, it } from 'vitest'
import {
  adoptSentConversation,
  floatProjectGroups,
  initialSelection,
  projectDisplayName,
  resolveContentKind,
  selectConversation,
  selectProject
} from './float-selection'

const convs = [
  { id: 'c1', workspaceId: 'w1' },
  { id: 'c2', workspaceId: 'w2' }
]

describe('initialSelection', () => {
  it('uses the seed conversation and its project', () => {
    expect(initialSelection('c2', convs, 'w1')).toEqual({ projectId: 'w2', conversationId: 'c2' })
  })
  it('keeps the seed id but falls back to the active project when the list is not loaded', () => {
    expect(initialSelection('c9', [], 'w1')).toEqual({ projectId: 'w1', conversationId: 'c9' })
  })
  it('is a draft on the active project when there is no seed', () => {
    expect(initialSelection(undefined, convs, 'w1')).toEqual({ projectId: 'w1', conversationId: null })
  })
})

describe('selectConversation / selectProject', () => {
  it('selecting a conversation sets its project and the conversation', () => {
    expect(selectConversation({ projectId: 'w1', conversationId: null }, 'c2', 'w2')).toEqual({
      projectId: 'w2',
      conversationId: 'c2'
    })
  })
  it('selecting a project enters the draft page (conversationId null)', () => {
    expect(selectProject({ projectId: 'w1', conversationId: 'c1' }, 'w2')).toEqual({
      projectId: 'w2',
      conversationId: null
    })
  })
})

describe('adoptSentConversation', () => {
  it('follows the new conversation created from a draft (picks its project)', () => {
    expect(
      adoptSentConversation({ projectId: 'w1', conversationId: null }, 'c2', convs)
    ).toEqual({ projectId: 'w2', conversationId: 'c2' })
  })
  it('keeps the draft project when the new conversation is not in the list yet', () => {
    expect(
      adoptSentConversation({ projectId: 'w1', conversationId: null }, 'c9', convs)
    ).toEqual({ projectId: 'w1', conversationId: 'c9' })
  })
  it('does nothing while still a draft without an active conversation', () => {
    expect(adoptSentConversation({ projectId: 'w1', conversationId: null }, null, convs)).toBeNull()
  })
  it('never hijacks when already viewing a conversation', () => {
    expect(
      adoptSentConversation({ projectId: 'w1', conversationId: 'c1' }, 'c2', convs)
    ).toBeNull()
  })
})

describe('resolveContentKind', () => {
  const env = { conversationsLoaded: true, hasProjects: true, conversationExists: true }
  it('is loading until the lists land (never decide "missing" early)', () => {
    expect(resolveContentKind({ projectId: 'w1', conversationId: 'c1' }, { ...env, conversationsLoaded: false })).toBe('loading')
  })
  it('is empty when there are no projects', () => {
    expect(resolveContentKind({ projectId: null, conversationId: null }, { ...env, hasProjects: false })).toBe('empty')
  })
  it('is the draft page when no conversation is selected', () => {
    expect(resolveContentKind({ projectId: 'w1', conversationId: null }, env)).toBe('draft')
  })
  it('is missing when the selected conversation no longer exists', () => {
    expect(resolveContentKind({ projectId: 'w1', conversationId: 'c1' }, { ...env, conversationExists: false })).toBe('missing')
  })
  it('is the conversation otherwise', () => {
    expect(resolveContentKind({ projectId: 'w1', conversationId: 'c1' }, env)).toBe('conversation')
  })
})

describe('floatProjectGroups', () => {
  const ws = [
    { id: 'w1', name: '项目一', path: '/a' },
    { id: 'w2', name: '项目二', path: '/b' },
    { id: 'task', name: '任务', path: undefined },
    // 临时工作区：有真实目录，但属于「不选项目」发消息时自动建的那种
    { id: 's1', name: '临时会话', path: '/data/conversations/c2', scratch: true }
  ]
  const cs = [
    { id: 'c1', title: '会话一', workspaceId: 'w1' },
    { id: 'c2', title: '临时', workspaceId: 's1' },
    { id: 'c3', title: '任务会话', workspaceId: 'task' }
  ]
  it('drops virtual / scratch workspaces and appends the synthetic scratch group', () => {
    expect(floatProjectGroups(ws, cs).map((g) => g.id)).toEqual(['w1', 'w2', '__scratch__'])
  })
  it('groups conversations under their workspace', () => {
    const g = floatProjectGroups(ws, cs)
    expect(g.find((x) => x.id === 'w1')?.conversations.map((c) => c.id)).toEqual(['c1'])
  })
  it('labels the synthetic group and lists only scratch conversations', () => {
    const s = floatProjectGroups(ws, cs).find((g) => g.id === '__scratch__')
    expect(s?.name).toBe('临时会话')
    expect(s?.conversations.map((c) => c.id)).toEqual(['c2'])
  })
  it('omits the scratch group when there are none', () => {
    const g = floatProjectGroups(ws, [{ id: 'c1', title: 'x', workspaceId: 'w1' }])
    expect(g.some((x) => x.id === '__scratch__')).toBe(false)
  })
  it('keeps an empty project as an empty group', () => {
    expect(floatProjectGroups(ws, []).map((g) => g.id)).toEqual(['w1', 'w2'])
  })
})

describe('projectDisplayName', () => {
  const ws = [{ id: 'w1', name: '项目一', path: '/a' }]
  it('uses the workspace name', () => {
    expect(projectDisplayName(ws, 'w1')).toBe('项目一')
  })
  it('labels the synthetic scratch group', () => {
    expect(projectDisplayName(ws, '__scratch__')).toBe('临时会话')
  })
  it('labels a scratch workspace (auto-created for a no-project session) too', () => {
    const withScratch = [...ws, { id: 's1', name: 'conversations/abc', path: '/data/abc', scratch: true }]
    expect(projectDisplayName(withScratch, 's1')).toBe('临时会话')
  })
  it('falls back when nothing is selected', () => {
    expect(projectDisplayName(ws, null)).toBe('选择项目')
  })
})
