/**
 * ACP 历史回放装配（`services/ai/acp-history.ts`）验证：不起 Electron，直接跑真源码。
 *
 * 背景（用户报告）：导入的 ACP 会话里，很多消息被折进「思考 ×n · 工具调用 ×n」折叠条，
 * **正文也跟着被折掉**，界面上看不到任何输出，只看到一个复制按钮。
 *
 * 根因一：`session/load` 回放的「工具调用 → 完成更新」之间可能夹着**下一条消息的正文**
 * （分段只看 `ContentChunk.messageId`，而 `ToolCall` / `ToolCallUpdate` 压根没有 messageId）。
 * 结果被挂到「当前消息」（= 新那条）上，渲染端按 toolCallId 找不到对应调用，只能当孤儿结果
 * 补在末尾 —— 于是那条消息变成「正文 + 末尾两条工具」，末尾不是正文就被整条折起来。
 *
 * 根因二（渲染侧，见 `features/agent/turn-fold.tsx` 的 findTailStart）：
 * 折叠规则只认「末尾连续正文」，末尾不是正文时 `tailStart === units.length`，整条消息全折。
 *
 * 跑：node --experimental-strip-types scripts/verify-acp-history.ts
 */

import assert from 'node:assert/strict'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { HistoryAssembler, pushHistoryUpdate } from '../src/main/services/ai/acp-history.ts'

const check = (label: string, ok: boolean, extra?: string): void => {
  assert.ok(ok, `FAIL: ${label}${extra ? ` :: ${extra}` : ''}`)
  console.log(`  ok  ${label}`)
}

// ---------- 事件构造小工具 ----------
const user = (text: string, messageId: string): SessionUpdate =>
  ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, messageId }) as SessionUpdate
const agent = (text: string, messageId: string): SessionUpdate =>
  ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    messageId
  }) as SessionUpdate
const thought = (text: string, messageId: string): SessionUpdate =>
  ({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text },
    messageId
  }) as SessionUpdate
const call = (toolCallId: string, title = 'Read file'): SessionUpdate =>
  ({ sessionUpdate: 'tool_call', toolCallId, title, rawInput: { path: 'a.ts' } }) as SessionUpdate
const done = (toolCallId: string, status = 'completed'): SessionUpdate =>
  ({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
    rawOutput: { ok: true }
  }) as SessionUpdate

/** parts → 便于断言的紧凑串（如 `text:结论` / `tool-call:call-1`） */
const shape = (parts: { type: string; toolCallId?: string; text?: string }[]): string[] =>
  parts.map((p) => `${p.type}${p.toolCallId ? `:${p.toolCallId}` : ''}`)

const run = (updates: SessionUpdate[]) => {
  const assembler = new HistoryAssembler()
  for (const update of updates) pushHistoryUpdate(assembler, update)
  return assembler.finish()
}

// ---------- 1. 用户报告的场景：结果落到了下一条消息上 ----------
{
  const messages = run([
    user('帮我看看这个 bug', 'u1'),
    thought('先读一下文件', 'm1'),
    agent('我先看一下 a.ts', 'm1'),
    call('call-1'),
    // ⚠️ 下一段正文开了**新消息**（messageId 变了），而 call-1 的完成更新还在后面
    agent('看完了，结论是 b.ts 少判空', 'm2'),
    done('call-1')
  ])

  check('消息条数：用户 1 条 + 助手 2 条（按 messageId 分段）', messages.length === 3, String(messages.length))
  check('用户消息只有正文', shape(messages[0].parts).join('|') === 'text', shape(messages[0].parts).join('|'))
  check(
    '工具结果回到**调用所在**的那条消息（不是下一条）',
    shape(messages[1].parts).join('|') === 'reasoning|text|tool-call:call-1|tool-result:call-1',
    shape(messages[1].parts).join('|')
  )
  check(
    '最后一条消息只有正文（末尾不是工具 ⇒ 渲染端才不会被整条折起来）',
    shape(messages[2].parts).join('|') === 'text',
    shape(messages[2].parts).join('|')
  )
}

// ---------- 2. 末尾**确实**是工具调用（正文在前的合法顺序）：装配必须原样保留 ----------
{
  const messages = run([
    agent('我改一下，然后跑测试', 'm1'),
    call('call-1'),
    done('call-1'),
    call('call-2'),
    done('call-2')
  ])
  check(
    '调用与结果按回放顺序成对保留（渲染端按 toolCallId 合并，不会多出孤儿行）',
    shape(messages[0].parts).join('|') ===
      'text|tool-call:call-1|tool-result:call-1|tool-call:call-2|tool-result:call-2',
    shape(messages[0].parts).join('|')
  )
}

// ---------- 3. 没有 messageId 的启发式：助手内容连续追加，结果仍按 id 找宿主 ----------
{
  const messages = run([
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '你好' } } as SessionUpdate,
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '看' } } as SessionUpdate,
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '这里' } } as SessionUpdate,
    call('call-9'),
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-9',
      status: 'completed'
    } as SessionUpdate,
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好了' } } as SessionUpdate
  ])
  check('无 messageId：用户块单独成条、助手块连续归一条', messages.length === 2, String(messages.length))
  check(
    '无 messageId：工具与结果都留在助手那条里',
    shape(messages[1].parts).join('|') === 'text|text|tool-call:call-9|tool-result:call-9|text',
    shape(messages[1].parts).join('|')
  )
}

// ---------- 4. 进行中的工具更新不落结果卡（否则同一张卡会重复出现） ----------
{
  const messages = run([agent('看一下', 'm1'), call('call-1'), done('call-1', 'in_progress'), done('call-1')])
  check(
    '只有 completed / failed 才落结果卡',
    shape(messages[0].parts).join('|') === 'text|tool-call:call-1|tool-result:call-1',
    shape(messages[0].parts).join('|')
  )
}

// ---------- 5. 孤儿结果（找不到调用）不丢：兜底挂在助手消息里 ----------
{
  const messages = run([agent('正文', 'm1'), done('call-404')])
  check(
    '查不到调用的结果仍然保留（兜底成完整工具卡，不让结果消失）',
    shape(messages[0].parts).join('|') === 'text|tool-result:call-404',
    shape(messages[0].parts).join('|')
  )
}

// ---------- 6. 思考块与空消息 ----------
{
  const messages = run([
    thought('想一想', 'm1'),
    agent('答案', 'm1'),
    { sessionUpdate: 'available_commands_update', availableCommands: [] } as SessionUpdate
  ])
  check('思考块是 reasoning part（渲染成可折叠的思考条）', shape(messages[0].parts)[0] === 'reasoning')
  check('只有状态更新的「空消息」不产出', messages.length === 1, String(messages.length))
}

// ---------- 7. 没有 messageId 也没有 user 消息：多轮助手内容要拆成多条消息 ----------
{
  // 模拟 agent 在 session/load 回放时既不给 messageId、也不回放 user 消息的常见情况：
  // 两轮各自的「工具调用 → 结果 → 答案」被启发式合并成一条会整段折叠，必须按轮拆开。
  const messages = run([
    call('c1'),
    done('c1'),
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一轮结论' } } as SessionUpdate,
    call('c2'),
    done('c2'),
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第二轮结论' } } as SessionUpdate
  ])
  check('无 messageId 多轮：每轮拆成独立的助手消息', messages.length === 2, String(messages.length))
  check(
    '第一轮：调用/结果/答案成对保留',
    shape(messages[0].parts).join('|') === 'tool-call:c1|tool-result:c1|text',
    shape(messages[0].parts).join('|')
  )
  check(
    '第二轮：调用/结果/答案成对保留',
    shape(messages[1].parts).join('|') === 'tool-call:c2|tool-result:c2|text',
    shape(messages[1].parts).join('|')
  )
}

console.log('\nALL PASS')
