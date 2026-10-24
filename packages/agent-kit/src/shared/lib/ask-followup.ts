/**
 * ask_followup_question 提问表单的防御式归一化（web / 桌面端同构）。
 *
 * 模型给的是任意 JSON，这里规整成能渲染出一张可用卡片的结构；缺字段就兜底。
 */
import type { AgentMessagePart, AskFollowupAnswer } from '@fizz/contracts/types'

export interface NormalizedOption {
  label: string
  description?: string
}

export interface NormalizedQuestion {
  id: string
  question: string
  header: string
  options: NormalizedOption[]
  multiSelect: boolean
}

export interface NormalizedFollowup {
  title: string
  questions: NormalizedQuestion[]
}

/** 模型给的是任意 JSON，这里做一次防御式归一化（缺字段也要能渲染出一张能用的卡） */
export function normalizeFollowup(input: unknown): NormalizedFollowup {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  const rawQs = Array.isArray(obj.questions) ? obj.questions : []
  const questions: NormalizedQuestion[] = []
  rawQs.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return
    const q = raw as Record<string, unknown>
    const question = typeof q.question === 'string' ? q.question.trim() : ''
    if (!question) return
    const header = typeof q.header === 'string' && q.header.trim() ? q.header.trim() : `问题 ${i + 1}`
    const multiSelect = q.multiSelect === true
    const options: NormalizedOption[] = []
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (typeof o === 'string') {
          const label = o.trim()
          if (label) options.push({ label })
        } else if (o && typeof o === 'object') {
          const ob = o as Record<string, unknown>
          const label = typeof ob.label === 'string' ? ob.label.trim() : ''
          if (label) {
            options.push({
              label,
              description:
                typeof ob.description === 'string' && ob.description.trim()
                  ? ob.description.trim()
                  : undefined
            })
          }
        }
      }
    }
    if (options.length === 0) return
    questions.push({
      id: (typeof q.id === 'string' && q.id.trim()) || `q${i + 1}`,
      question,
      header,
      options,
      multiSelect
    })
  })
  return { title, questions }
}

/**
 * 把「补答」拼成一条用户消息。
 *
 * 用在哪：那一轮已经结束了（应用退出 / 用户点了停止 / 进程崩了），提问卡上的答案
 * **再也回填不到工具里** —— 只能当新的一轮发出去。所以题目必须一起带上：模型看到的
 * 是一句普通的话，不重复题目它不知道在回答什么。
 *
 * 格式刻意做成「一句说明 + 每行一题」：模型读得懂，用户在自己的消息里也看得懂
 * （这条会作为普通 user 气泡留在对话里）。
 */
export function formatFollowupAnswer(answer: AskFollowupAnswer, title?: string): string {
  const lines = answer.answers.map((item) => {
    const picked = [...item.selected]
    const other = item.other?.trim()
    if (other) picked.push(other)
    return `- ${item.question} → ${picked.length ? picked.join('、') : '（未选）'}`
  })
  const head = title?.trim() ? `（补答你之前的提问：${title.trim()}）` : '（补答你之前的提问）'
  return [head, ...lines].join('\n')
}

/**
 * 已经「补答」过的提问（toolCallId → 答案）。
 *
 * 补答 = 发一条新消息，**没有地方能把「这张卡答过了」写回历史**（那一轮的工具结果
 * 在服务端早就定格成 `answered: false` 了，历史是只读的）。所以用一份客户端现场把
 * 卡片收成「已回答」，避免用户对着同一张卡反复作答。
 *
 * 只活在内存里：刷新 / 重开后会再变回可作答一次 —— 那时对话里已经有他刚发的那条
 * 答案（紧接着就是回答），不至于误点。要彻底解决得让服务端在历史里记这个状态，
 * 代价是改会话文件结构，本次没做。
 */
const resumedFollowups = new Map<string, AskFollowupAnswer>()

/** 记下「这张卡已经补答过」（渲染层据此收成已回答的折叠条） */
export function markFollowupResumed(toolCallId: string, answer: AskFollowupAnswer): void {
  resumedFollowups.set(toolCallId, answer)
}

/** 补答过的答案（没补答过 = `undefined`） */
export function getResumedFollowup(toolCallId: string): AskFollowupAnswer | undefined {
  return resumedFollowups.get(toolCallId)
}

/** ask_followup_question 的工具名（与 `shared/lib/parts.ts` 的常量同值，这里避开循环依赖） */
const ASK_FOLLOWUP_TOOL_NAME = 'ask_followup_question'

/**
 * 这个 part 是不是**一张没拿到答案的提问卡**（可以补答）。
 *
 * 判据三件事：
 * 1. 是 `ask_followup_question` 的 tool-call，且有题目（`normalizeFollowup` 能解析出来）；
 * 2. 工具没报错，而且**没拿到答案** —— 有 `output` 时必须带 `interrupted: true`
 *    （服务端 abort 时打的那个标记，见 `@fizz/tools` 的 `AskFollowupSink.interrupted`）。
 *    用户自己点「跳过」的结果没有这个标记：他刚说不要了，别再把表单弹回来；
 * 3. 没有活跃的待答请求 —— 那条由调用方判（`requests[toolCallId]`），这里拿不到。
 *
 * 「这一轮是不是已经结束」也由调用方判（`turnDone`，只有它知道消息是不是末条）。
 */
export function isUnansweredFollowup(part: AgentMessagePart): boolean {
  if (part.type !== 'tool-call' || part.toolName !== ASK_FOLLOWUP_TOOL_NAME) return false
  if (part.isError) return false
  if (part.output && typeof part.output === 'object') {
    const out = part.output as { answered?: unknown; interrupted?: unknown }
    if (out.answered === true) return false
    if (out.interrupted !== true) return false
  }
  return normalizeFollowup(part.input).questions.length > 0
}