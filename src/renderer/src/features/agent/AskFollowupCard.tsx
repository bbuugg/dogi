import { Circle, CircleCheck, CircleQuestionMark, Square, SquareCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from 'antd'
import { cn } from 'cn'
import { CollapsibleRow } from '@/features/agent/CollapsibleRow'
import { ToolCallRow, toolRunStatus } from '@/features/agent/ToolCallRow'
import { useAppStore } from '@/stores/app-store'
import { ASK_FOLLOWUP_TOOL } from '@shared/ask-followup'
import type { AskFollowupAnswer } from '@shared/types'

/**
 * `ask_followup_question` 工具在对话流里的卡片（参考 ainav/sdk 的 AskUserCard 思路，样式全部 Tailwind 重写）。
 *
 * 三种状态：
 * - **待回答**：一张真卡片 —— 表单标题（可选）+ 每道题一个区（单选用单选、多选用复选，选项可带说明）
 *   + 底部统一「提交 / 跳过」。用户作答后工具 resolve，**同一个回合继续往下跑**。
 * - **已回答**：收成一条横条（复用 `CollapsibleRow`），展开看每题选了什么，不给对话流留一块大卡片。
 * - **其它**（出错 / 已中止 / 还在等工具入参）：退回普通 `ToolCallRow`，状态语义与其它工具一致。
 */

interface NormalizedOption {
  label: string
  description?: string
}

interface NormalizedQuestion {
  id: string
  question: string
  header: string
  options: NormalizedOption[]
  multiSelect: boolean
}

/** 模型给的是任意 JSON，这里做一次防御式归一化（缺字段也要能渲染出一张能用的卡） */
function normalize(input: unknown): { title: string; questions: NormalizedQuestion[] } {
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

export function AskFollowupCard({
  toolCallId,
  input,
  output,
  isError,
  streaming
}: {
  toolCallId: string
  /** 工具入参（tool-call 的 input） */
  input: unknown
  /** 工具结果；undefined 表示还没回答 */
  output?: unknown
  isError?: boolean
  /** 所属消息是否仍在生成 */
  streaming?: boolean
}) {
  const resolveFollowup = useAppStore((s) => s.resolveFollowup)
  // 待回答的提问由主进程广播进来，按 toolCallId 定位；没有它说明这次调用已经没有回音了
  const followupReq = useAppStore((s) => s.followupRequests[toolCallId])
  // 本地「已提交」标记：提交后主进程会立刻把 followupRequests 删掉，但工具结果（output）要晚一拍才到，
  // 这中间若直接退回普通横条，表单会闪一下。用 submitted 顶住，等 output 来了再翻成答案摘要。
  const [submitted, setSubmitted] = useState(false)
  const { title, questions } = useMemo(() => normalize(input), [input])

  return (
    <AskFollowupBody
      key={toolCallId}
      title={title}
      questions={questions}
      input={input}
      output={output}
      isError={isError}
      // 有结果 → 已回答；没结果但仍在挂起（或刚提交、结果未到）→ 待回答；都没有 → 交给 ToolCallRow 兜底
      pending={!output && (submitted || !!followupReq)}
      streaming={streaming}
      onSubmit={(answer) => {
        setSubmitted(true)
        void resolveFollowup(toolCallId, answer)
      }}
    />
  )
}

function AskFollowupBody({
  title,
  questions,
  input,
  output,
  isError,
  pending,
  streaming,
  onSubmit
}: {
  title: string
  questions: NormalizedQuestion[]
  input: unknown
  output?: unknown
  isError?: boolean
  pending: boolean
  streaming?: boolean
  onSubmit: (answer: AskFollowupAnswer | null) => void
}) {
  // 已回答 / 出错 / 已经没有回音了 → 退回普通横条（状态语义与其它工具一致）
  if (output !== undefined || isError) {
    return <AnswerSummary title={title} questions={questions} output={output} isError={isError} />
  }
  // 没有结果、主进程那边也不再挂起（中止 / 对话已结束），或入参解析不出题 → 退回普通横条
  if (!pending || questions.length === 0) {
    return (
      <ToolCallRow
        toolName={ASK_FOLLOWUP_TOOL}
        input={input === undefined ? null : input}
        status={toolRunStatus({ confirming: false, hasResult: false, streaming })}
      />
    )
  }

  // 每道题选中的 label 列表（单选存一个，多选存多个）
  const [selected, setSelected] = useState<Record<string, string[]>>({})

  const canSubmit =
    questions.length > 0 && questions.every((q) => (selected[q.id]?.length ?? 0) > 0)

  const toggle = (q: NormalizedQuestion, label: string) => {
    setSelected((prev) => {
      const cur = prev[q.id] ?? []
      if (q.multiSelect) {
        return { ...prev, [q.id]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
      }
      // 单选：直接替换
      return { ...prev, [q.id]: cur.includes(label) ? [] : [label] }
    })
  }

  const submit = () => {
    if (!canSubmit) return
    onSubmit({
      answers: questions.map((q) => ({
        id: q.id,
        question: q.question,
        selected: selected[q.id] ?? []
      }))
    })
  }

  return (
    <div className="w-fit max-w-full rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
      {title && <p className="mb-1.5 text-sm font-medium text-foreground">{title}</p>}
      <div className="flex flex-col gap-3">
        {questions.map((q, qi) => (
          <div key={q.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                {q.header}
              </span>
              <span className="min-w-0 text-sm text-foreground">{q.question}</span>
            </div>
            <div className="flex flex-col gap-0.5 pl-0.5">
              {q.options.map((opt) => {
                const checked = (selected[q.id] ?? []).includes(opt.label)
                const Icon = q.multiSelect ? (checked ? SquareCheck : Square) : checked ? CircleCheck : Circle
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => toggle(q, opt.label)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                      checked ? 'bg-primary/10 text-foreground' : 'text-foreground/80 hover:bg-foreground/10'
                    )}
                  >
                    <Icon
                      className={cn('mt-0.5 size-4 shrink-0', checked ? 'text-primary' : 'text-muted-foreground/60')}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{opt.label}</span>
                      {opt.description && (
                        <span className="block text-xs text-muted-foreground">{opt.description}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
            {qi < questions.length - 1 && <div className="h-px bg-border/60" />}
          </div>
        ))}
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <Button size="small" type="primary" className="h-8 text-[13px]" disabled={!canSubmit} onClick={submit}>
          提交
        </Button>
        <Button size="small" type="text" className="h-8 text-[13px]" onClick={() => onSubmit(null)}>
          跳过
        </Button>
      </div>
    </div>
  )
}

/**
 * 已回答的收起态：`[问号] [标题或首题] [已回答/已跳过] [›]`。
 * 展开显示每道题的选择。
 */
function AnswerSummary({
  title,
  questions,
  output,
  isError
}: {
  title: string
  questions: NormalizedQuestion[]
  output?: unknown
  isError?: boolean
}) {
  const obj = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>
  const answered = obj.answered !== false
  const answers = Array.isArray(obj.answers)
    ? (obj.answers as Array<{ id: string; question: string; selected: string[] }>)
    : []
  const note = typeof obj.note === 'string' ? obj.note : ''
  const byId = new Map(answers.map((a) => [a.id, a]))

  return (
    <CollapsibleRow
      icon={
        <CircleQuestionMark
          className={cn('size-4 shrink-0', isError ? 'text-destructive' : 'text-muted-foreground/70')}
        />
      }
      bodyClassName="flex flex-col gap-2"
      body={
        <>
          {title && <p className="text-xs font-medium text-foreground/80">{title}</p>}
          {questions.map((q) => {
            const sel = byId.get(q.id)?.selected ?? []
            return (
              <div key={q.id} className="flex flex-col gap-1">
                <p className="text-xs text-foreground/80">{q.question}</p>
                {sel.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {sel.map((label, i) => (
                      <span
                        key={`${label}-${i}`}
                        className="inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-xs text-foreground/80"
                      >
                        <span className="min-w-0 truncate">{label}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground/70">{isError ? '提问失败' : '未作答'}</p>
                )}
              </div>
            )
          })}
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
        </>
      }
    >
      <span className="min-w-0 truncate font-medium text-foreground/80">
        {title || questions[0]?.question || '助手的提问'}
      </span>
      <span
        className={cn(
          'shrink-0',
          isError ? 'text-destructive' : answered ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/60'
        )}
      >
        {isError ? '失败' : answered ? '已回答' : '已跳过'}
      </span>
    </CollapsibleRow>
  )
}
