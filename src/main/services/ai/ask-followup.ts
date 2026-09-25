import { randomUUID } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AskFollowupAnswer, AskFollowupRequest } from '@shared/types'
import { ASK_FOLLOWUP_TIMEOUT_MS, ASK_FOLLOWUP_TOOL } from '@shared/ask-followup'

/**
 * `ask_followup_question` 工具：**让 AI 在回合中途向用户收集结构化选择题答案，拿到后继续往下跑**。
 *
 * 机制与「命令执行确认卡」完全一致 —— 工具在主进程执行，这里把它挂起，
 * 通过 IPC 广播给渲染端渲染卡片（一题一区，底部统一提交），用户作答后回填 resolve，
 * `streamText` 的当前回合接着走下一步。ainav 那边是客户端工具（无 execute），
 * 这里做不到（工具跑在主进程），所以走的是确认卡那条路。
 *
 * 两种终态：
 * - 用户作答 → `{ answered: true, answers: [{ id, question, selected }] }`
 * - 跳过 / 超时 / 中止 → `{ answered: false, note }`，模型应当自己接着往下做，
 *   不要反复追问（描述里写死了这条要求）。
 */

/** 由 ipc 层注入：提问卡的弹出与撤销 */
export interface AskFollowupSink {
  /** 弹出一张提问表单卡 */
  request(req: AskFollowupRequest): void
  /** 已有结论（超时 / 中止 / 已作答），渲染端据此移除卡片 */
  resolved(payload: { id: string; toolCallId: string }): void
}

interface PendingAsk {
  requestId: string
  toolCallId: string
  settle: (answer: AskFollowupAnswer | null) => void
  timer: ReturnType<typeof setTimeout>
}

class AskFollowupBroker {
  private sink: AskFollowupSink | null = null
  private pending = new Map<string, PendingAsk>()

  setSink(sink: AskFollowupSink | null): void {
    this.sink = sink
  }

  /** 挂起等待用户回答；拿不到 sink（无窗口）或超时 / 被取消时返回 null */
  ask(req: Omit<AskFollowupRequest, 'id'>): Promise<AskFollowupAnswer | null> {
    const sink = this.sink
    if (!sink) return Promise.resolve(null)
    const id = randomUUID()
    return new Promise<AskFollowupAnswer | null>((resolve) => {
      const settle = (answer: AskFollowupAnswer | null) => {
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        sink.resolved({ id, toolCallId: entry.toolCallId })
        resolve(answer)
      }
      const timer = setTimeout(() => settle(null), ASK_FOLLOWUP_TIMEOUT_MS)
      this.pending.set(id, {
        requestId: req.requestId,
        toolCallId: req.toolCallId,
        settle,
        timer
      })
      sink.request({ id, ...req })
    })
  }

  /** 渲染进程回复 */
  resolve(id: string, answer: AskFollowupAnswer | null): void {
    this.pending.get(id)?.settle(answer)
  }

  /**
   * 中止 / 流结束兜底：把该对话请求下所有待回答的提问按「跳过」处理。
   * 少了这一步，工具会永远挂着（Promise 不 settle，回合卡死）。
   */
  cancel(requestId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.requestId !== requestId) continue
      entry.settle(null)
    }
  }
}

/** 单例：Agent 页与终端 AI 助手共用（渲染端按 toolCallId 定位卡片，不按来源区分） */
export const askFollowupBroker = new AskFollowupBroker()

/**
 * 组装 `ask_followup_question` 工具。
 *
 * ⚠️ 刻意**不走确认流程**：提问本身就是让用户在卡片上做决定，
 * 再套一层「是否允许执行该工具？」只会多一次没意义的点击。
 */
export function buildAskFollowupTool(requestId: string, sessionId?: string | null): ToolSet {
  return {
    [ASK_FOLLOWUP_TOOL]: tool({
      description:
        'Collect structured multiple-choice answers from the user. Provide one or more questions with ' +
        'options, and set multiSelect when multi-select is appropriate. MUST be invoked via the native ' +
        'tool_calls protocol; NEVER emit it as inline XML or pseudo-XML in assistant text (e.g. ' +
        '"<ask_followup_question>..."). Only use this tool when you are highly uncertain and must clarify ' +
        'the issue with the user. You should prefer resolving the problem through reasoning and other tools ' +
        'whenever possible.',
      inputSchema: z.object({
        title: z
          .string()
          .optional()
          .describe('Optional title for the questions form'),
        questions: z
          .array(
            z.object({
              question: z
                .string()
                .min(1)
                .describe('The complete question to ask the user. Should be clear and specific.'),
              header: z
                .string()
                .max(12)
                .describe(
                  'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library".'
                ),
              options: z
                .array(
                  z.union([
                    z.string(),
                    z.object({ label: z.string(), description: z.string().optional() })
                  ])
                )
                .min(1)
                .describe(
                  'The available choices for this question. 2-4 options. Each option can be a string or an ' +
                    'object with "label" and optional "description".'
                ),
              multiSelect: z
                .boolean()
                .optional()
                .describe(
                  'Set to true to allow the user to select multiple options instead of just one. Default false.'
                ),
              id: z
                .string()
                .optional()
                .describe('Optional unique identifier for the question. Auto-generated if absent.')
            })
          )
          .min(1)
          .describe(
            '1 to 4 questions as an array filled with JSON objects. Example: ' +
              '[{"question":"Which framework?","options":[{"label":"React"},{"label":"Vue"}]}]'
          )
      }),
      execute: async (
        input: {
          title?: string
          questions: Array<{
            question: string
            header: string
            options: Array<string | { label: string; description?: string }>
            multiSelect?: boolean
            id?: string
          }>
        },
        opts: { toolCallId: string }
      ) => {
        const answer = await askFollowupBroker.ask({
          requestId,
          toolCallId: opts.toolCallId,
          title: input.title,
          questions: input.questions.map((q, i) => ({
            id: q.id?.trim() || `q${i + 1}`,
            question: q.question,
            header: q.header,
            options: q.options.map((o) =>
              typeof o === 'string' ? { label: o } : { label: o.label, description: o.description }
            ),
            multiSelect: !!q.multiSelect
          })),
          sessionId: sessionId ?? undefined
        })
        if (!answer) {
          return {
            answered: false,
            note: '用户没有作答（已跳过）。请按你自己的判断继续，不要再追问同一个问题。'
          }
        }
        return { answered: true, answers: answer.answers }
      }
    })
  }
}
