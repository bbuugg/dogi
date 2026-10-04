/**
 * Agent 会话列表投影（`features/agent/conversation-list-meta.ts`）的验证：直接跑真源码，
 * 不需要打包 / 不起 Electron。
 *
 * 验的是「侧边栏消息一多就卡」那个修复的核心断言：**流式输出每个 token 换掉整个
 * `agentConversations` 数组时，列表订阅到的投影必须保持 `Object.is` 相等**
 * （= zustand 不触发重渲染）；而增删 / 改名 / 转正 / 排序键变化必须换引用（= 列表会更新）。
 *
 * 能直接跑：node --experimental-strip-types scripts/verify-agent-list-projection.ts
 */

import assert from 'node:assert/strict'
import {
  selectConversationListMeta,
  type ConversationListMeta
} from '../src/renderer/src/features/agent/conversation-list-meta.ts'
import type { AgentConversation } from '../src/shared/types.ts'

let passed = 0
const check = (label: string, ok: boolean): void => {
  assert.ok(ok, `FAIL: ${label}`)
  passed++
  console.log(`  ok  ${label}`)
}

const conv = (id: string, extra: Partial<AgentConversation> = {}): AgentConversation => ({
  id,
  workspaceId: 'ws1',
  kind: 'mastra',
  title: `会话 ${id}`,
  messages: [],
  createdAt: 1,
  updatedAt: 1000,
  ...extra
})

/** 模拟流式的一个 token：只有目标会话的 messages / parts 被换掉，整表引用也换掉 */
const streamTick = (list: AgentConversation[], id: string, text: string): AgentConversation[] =>
  list.map((c) =>
    c.id === id
      ? {
          ...c,
          messages: [
            ...c.messages,
            { role: 'assistant', parts: [{ type: 'text', text }] } as never
          ]
        }
      : c
  )

// ---------- 基础投影：只留列表可见字段 ----------
{
  const list = [conv('a'), conv('b', { kind: 'acp', acpAgentId: 'ag1', acpSessionId: 's1' })]
  const meta = selectConversationListMeta(list)
  check('投影条数与输入一致', meta.length === 2)
  check('字段齐全（id/归属/形态/标题/排序键）', meta[0].id === 'a' && meta[0].updatedAt === 1000)
  check('ACP 绑定带上（删除确认框要读）', meta[1].acpSessionId === 's1' && meta[1].kind === 'acp')
  check(
    '不含 messages（列表不读历史）',
    !Object.prototype.hasOwnProperty.call(meta[0] as Record<string, unknown>, 'messages')
  )
  check(
    '草稿标记带上（列表据此把它滤掉）',
    selectConversationListMeta([conv('d', { draft: true })])[0].draft === true
  )
}

// ---------- 流式 500 个 token：引用必须保持不变 ----------
{
  let list = [conv('a'), conv('b'), conv('c')]
  const before = selectConversationListMeta(list)
  let stableArray = true
  let stableEntries = true
  for (let i = 0; i < 500; i++) {
    list = streamTick(list, 'a', `片段 ${i}`)
    const now = selectConversationListMeta(list)
    if (now !== before) stableArray = false
    if (now[0] !== before[0] || now[1] !== before[1]) stableEntries = false
  }
  check('500 次流式增量后投影数组仍是同一个引用（Object.is 成立 → 不重渲染）', stableArray)
  check('条目对象也逐个复用（memo 化的行不会被重建）', stableEntries)
  check('会话内容确实在变（对照组：别把 bug 修成不更新）', list[0].messages.length === 500)
}

// ---------- 列表可见字段变化：必须换引用 ----------
{
  const base = [conv('a'), conv('b')]
  const m0 = selectConversationListMeta(base)

  const renamed = selectConversationListMeta([{ ...base[0], title: '改了名' }, base[1]])
  check('改名 → 新数组', renamed !== m0)
  check('改名 → 只有那一行是新条目', renamed[0] !== m0[0] && renamed[1] === m0[1])

  const bumped = selectConversationListMeta([base[0], { ...base[1], updatedAt: 2000 }])
  check('updatedAt 变化（组内重排）→ 新数组', bumped !== m0)

  const promoted = selectConversationListMeta([{ ...base[0], draft: false }, base[1]])
  check('草稿转正（draft 标记清掉）→ 新数组', promoted !== m0)

  const rebound = selectConversationListMeta([
    base[0],
    { ...base[1], kind: 'acp', acpSessionId: 's9' }
  ])
  check('ACP 绑定回填 → 新数组', rebound !== m0)

  const removed = selectConversationListMeta([base[0]])
  check('删除会话 → 新数组', removed !== m0 && removed.length === 1)

  const reordered = selectConversationListMeta([base[1], base[0]])
  check('顺序变化（新增/删除导致位移）→ 新数组', reordered !== m0)
  check('位移后各条目内容仍按新顺序对齐', reordered[0].id === 'b' && reordered[1].id === 'a')
}

// ---------- 同一个数组重复调用：连遍历都省掉 ----------
{
  const list = [conv('a')]
  check('同一数组重复投影返回同一引用', selectConversationListMeta(list) === selectConversationListMeta(list))
}

console.log(`\nALL PASS（${passed} 条）`)