/**
 * `toolCardHead` 的头部组装规则。
 *
 * 防的回归：
 * ① `execute_command` 的命令明细被当成「与结果正文重复的噪音」摘掉 —— 头部必须保留
 * `$ 命令`（挤不下就截断 + Tooltip，别让它消失），否则折叠状态下完全看不出跑的什么；
 * ② 有意图时明细丢了工具名 —— 「为什么」和「用什么干的」得同时看得到。
 */
import { describe, expect, it } from 'vitest'
import { toolCardHead, toolCardTitle, type ToolCallPart } from './parts'

/** 造一个最小的 tool-call part（只填头部用得上的字段） */
const call = (toolName: string, input: Record<string, unknown> = {}): ToolCallPart =>
  ({ type: 'tool-call', toolCallId: 'call-1', toolName, input }) as ToolCallPart

describe('toolCardHead', () => {
  it('execute_command 的命令进明细（无意图时与工具名并列）', () => {
    expect(toolCardHead(call('execute_command'), '$ npm run dev')).toEqual({
      title: '执行命令',
      detail: '$ npm run dev'
    })
  })

  it('execute_command 有意图时：意图当标题，明细是「工具名 · 命令」', () => {
    const head = toolCardHead(call('execute_command', { intent: '启动开发服务器' }), '$ npm run dev')
    expect(head.title).toBe('启动开发服务器')
    expect(head.detail).toBe('执行命令 · $ npm run dev')
  })

  it('终端工具同口径（命令进明细）', () => {
    const head = toolCardHead(call('run_in_terminal'), '$ pnpm test')
    expect(head.title).toBe(toolCardTitle('run_in_terminal'))
    expect(head.detail).toBe('$ pnpm test')
  })

  it('文件类工具：无意图时明细是路径，有意图时拼成「工具名 · 路径」', () => {
    expect(toolCardHead(call('read_file'), 'src/parts.ts')).toEqual({
      title: toolCardTitle('read_file'),
      detail: 'src/parts.ts'
    })
    expect(toolCardHead(call('read_file', { intent: '看实现' }), ' src/parts.ts ').detail).toBe(
      `${toolCardTitle('read_file')} · src/parts.ts`
    )
  })

  it('关掉「工具意图」开关：标题回到工具名，明细仍是明细', () => {
    expect(toolCardHead(call('execute_command', { intent: '启动开发服务器' }), '$ npm run dev', false)).toEqual(
      { title: '执行命令', detail: '$ npm run dev' }
    )
  })
})
