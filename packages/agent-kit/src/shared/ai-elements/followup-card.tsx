/**
 * `ask_followup_question` 工具在对话流里的卡片（web 版，样式与桌面端同构）。
 *
 * 三种状态：
 * - **待回答**：一张真卡片 —— 标题（可选）+ 题目 + 底部「提交 / 跳过」；
 *   非「是/否」型题目在选项末尾追加一项「其他」，选中后展开输入框，允许用户不选预设项
 *   而是自己写内容（答案经 `other` 字段回传给模型）。
 *   **多题时一题一屏、底部左右切换**（不再把题目竖着摞成一条长卡，见 `FollowupForm` 文件头）；
 * - **已回答**：收成一条**与工具调用卡同构**的折叠条（图标 / 标题 / 状态徽章 / 箭头），
 *   看每题选了什么，不给对话流留大卡片；
 * - **退回兜底**：出错 / 已中止 / 入参解析不出题 → 普通一行说明。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleQuestionMark,
  CircleSlash,
  Square,
  SquareCheck,
  XCircle
} from 'lucide-react'
import { Badge } from '@fizz/ui/badge'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@fizz/ui/collapsible'
import { useConversationOptional } from '@fizz/agent-kit/shared/ai-elements/conversation'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import {
  normalizeFollowup,
  getResumedFollowup,
  markFollowupResumed,
  type NormalizedQuestion
} from '@fizz/agent-kit/shared/lib/ask-followup'
import type { AskFollowupAnswer } from '@fizz/contracts/types'

export function AskFollowupCard({
  toolCallId,
  input,
  output,
  isError,
  pending,
  resumable,
  onResolve
}: {
  /** 这次工具调用的 id —— 只用来查「这张卡补答过没有」（见 `getResumedFollowup`） */
  toolCallId?: string
  /** 工具入参（tool-call 的 input） */
  input: unknown
  /** 工具结果；undefined 表示还没回答 */
  output?: unknown
  isError?: boolean
  /** 是否仍处于「等用户回答」状态（决定渲染成卡片还是退回横条） */
  pending: boolean
  /**
   * 那一轮已经结束、这张提问卡从没拿到过答案（应用退出 / 点了停止 / 进程崩了）。
   *
   * 此时照样渲染成可作答的表单，但答案**回填不到工具里**（run 只在内存，早没了）——
   * 提交时由调用方把答案拼成一条新消息发出去（见 `formatFollowupAnswer`）。
   * 以前这种情况只显示一行「助手的提问（无待作答表单）」，问题等于白问了。
   */
  resumable?: boolean
  onResolve: (answer: AskFollowupAnswer | null) => void
}) {
  const tr = useT()
  const { title, questions } = useMemo(() => normalizeFollowup(input), [input])
  /** 补答过的答案：有它就收成「已回答」，不再给表单（见 `markFollowupResumed`） */
  const resumed = toolCallId ? getResumedFollowup(toolCallId) : undefined

  if (resumed) {
    return (
      <AnswerSummary
        title={title}
        questions={questions}
        output={{ answered: true, answers: resumed.answers }}
      />
    )
  }

  /**
   * 能不能作答只看这两件事：有题、且不是「工具已经报错」。
   *
   * ⚠️ 顺序很重要：`output !== undefined` 时以前直接进 `AnswerSummary`（收成一条
   * 「已回答 / 已跳过」的折叠条）。而中断收场往往也留了一个 `{ answered: false }` 的
   * 结果，按 output 判就把「可以补答」判成了「已跳过」。所以先判可作答，再判摘要。
   */
  const answerable = !isError && questions.length > 0 && (pending || !!resumable)
  if (answerable) {
    return (
      <FollowupForm
        title={title}
        questions={questions}
        onResolve={(answer) => {
          // 补答成功 = 这张卡的历史使命结束了：记下来，让它下次渲染成「已回答」
          if (answer && resumable && !pending && toolCallId) markFollowupResumed(toolCallId, answer)
          onResolve(answer)
        }}
        // 只有「补答」才挂这句提示：正常待答时答案回填给同一个回合，说「作为新消息发出」是错的
        note={pending ? undefined : tr('这一轮已经结束，作答会作为一条新消息发出去。')}
      />
    )
  }
  if (output !== undefined || isError) {
    return <AnswerSummary title={title} questions={questions} output={output} isError={isError} />
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <CircleQuestionMark className="size-4 shrink-0" />
      {tr('助手的提问（无待作答表单）')}
    </p>
  )
}

/** 「其他」自由输入的哨兵 label：选中它就展开一个输入框，让用户不选预设项也能自己写。 */
import { useT } from '@fizz/agent-kit/shared/lib/language'
const OTHER_LABEL = '其他'

/** 是/否 型问题（正好两个「是 / 否」类选项）不加「其他」——这两类问题的语义封闭，
 *  开放输入反而让答案变模糊。只对真正的「单选 / 多选」题开放自定义输入。 */
function isYesNoQuestion(q: NormalizedQuestion): boolean {
  if (q.options.length !== 2) return false
  const YES = new Set(['是', '是的', '对', '好', 'yes', 'y', 'true', 'ok'])
  const NO = new Set(['否', '不是', '不对', '不行', 'no', 'n', 'false'])
  const norm = (s: string): string => s.trim().toLowerCase()
  const a = norm(q.options[0].label)
  const b = norm(q.options[1].label)
  return (YES.has(a) && NO.has(b)) || (NO.has(a) && YES.has(b))
}

/**
 * 待回答的表单。
 *
 * ## 多题 = **一题一屏 + 左右切换**（不再把题目竖着摞成一条长卡）
 *
 * 模型一次问 3~5 道题时，竖排会把卡片拉成一长条：对话流被这一张卡占满，后面的消息全被
 * 推到屏幕外；而且看到第 3 题时，用户根本不知道「一共几题、还差几题、提交要满足什么」。
 * 现在一次只显示一题，底部 `‹ ● ● ● ›` 左右切换：点圆点可直接跳题，圆点同时表达该题
 * **是否已作答**（当前那颗拉长、已答的实心）；**「第 2 / 3 题」贴在顶部整体描述那一行的右端**
 * （不放题干行 —— 题干可换行、长短不一，计数贴它会忽左忽右）。
 * **只有一题时这套导航整块不渲染**，与改动前完全一致。
 *
 * ⚠️ **没答完时主按钮是「下一题」而不是「提交」**：多题场景下用户最常做的动作是「往后翻」，
 * 而「提交」在没答完时是禁用的死键 —— 摆在最显眼的位置却点不动，只能去点左边那颗 `›`。
 * 所以多题且未答完时它变「下一题」（点一下跳到**下一道未作答**的题，循环查找；
 * 若只剩当前这题没答就顺移一题，保证点了有反馈），全部答完才变回「提交」。
 * 单题没有这个状态，仍是「没答 = 禁用提交」。
 *
 * ⚠️ 多题时卡片**宽度钉成固定值**（`w-[min(100%,26rem)]`），高度只给**下限**
 * （`min-h-[18rem]`）：卡片原本宽是 `w-fit`、高随内容 —— 一题一屏之后宽度跟着当前题的
 * 长短变，翻页时卡片左右来回跳，所以宽度钉死；高度留一个下限让短题不至于把导航条顶到
 * 卡片中间，**超过下限就跟着内容长**。
 *
 * ⚠️ **选项区不滚动**（原来的 `overflow-y-auto` + 固定 `h-[18rem]` 已撤）：带滚动条时
 * 最后一两个选项只露半行，而选项正是这张卡的全部内容 —— 用户要的是「一眼看全、直接点」，
 * 不是「先滚一下」。选项再多也让卡片长高，高过一屏时由**消息区**自己滚（卡片在正常文档流
 * 里，不会撑破布局）。单题那个 `max-h-[18rem]` 同理，一并去掉。
 * （用 `grow` 而非 `flex-1`：`flex-basis: auto` 才能让「高度 auto + min-height」的容器
 * 正确按内容做内在尺寸计算，`flex-1` 的 `0%` 基准在嵌套 flex 里容易把中间层压成 0 高。）
 *
 * ⚠️ 「其他」那个自由输入框的焦点：**只有刚勾上「其他」的那一刻才聚焦**。原来靠 `autoFocus`，
 * 但输入框现在是随当前题挂载 / 卸载的，翻页回到这一题会再抢一次焦点（用户正在点 `‹ ›`
 * 翻页，焦点却被拽进输入框，接着按 ← → 就变成在输入框里移光标而不是翻页）。
 * 所以改用「待聚焦的题 id」记一次、在 effect 里消费掉。
 *
 * 键盘：卡片内按 ← / → 翻页（焦点在输入框里时让位给光标移动）。
 */
function FollowupForm({
  title,
  questions,
  note,
  onResolve
}: {
  title: string
  questions: NormalizedQuestion[]
  /** 卡片顶部的一句提示（补答时说明「答案会作为新消息发出」）；不传就不占位置 */
  note?: string
  onResolve: (answer: AskFollowupAnswer | null) => void
}) {
  const tr = useT()
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  /** 「其他」里用户自己写的内容，按题 id 存 */
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  /** 当前显示第几题（0 基）。题目集合变了也不会越界 —— 下面用 `index` 夹一次。 */
  const [page, setPage] = useState(0)
  /** 翻页方向：决定下一题的滑入动画从哪一侧进来 */
  const [dir, setDir] = useState<'next' | 'prev'>('next')

  /** 多题才有一题一屏 + 左右切换这套导航 */
  const multiple = questions.length > 1
  const index = Math.min(page, Math.max(0, questions.length - 1))
  const current = questions[index]

  /** 待聚焦的题 id：`toggle` 勾上「其他」时写入，effect 消费一次就清掉（见文件头） */
  const focusPendingRef = useRef<string | null>(null)
  const otherInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (focusPendingRef.current !== current?.id) return
    focusPendingRef.current = null
    otherInputRef.current?.focus()
  })

  /** 一题算「已作答」：要么真选了至少一个预设项，要么选了「其他」且填了内容。
   *  「其他」勾了却没写字视同未答 —— 否则等于交了一个空答案给模型。 */
  const isAnswered = (q: NormalizedQuestion): boolean => {
    const sel = selected[q.id] ?? []
    const real = sel.filter((x) => x !== OTHER_LABEL)
    const otherVal = (otherText[q.id] ?? '').trim()
    const hasOther = sel.includes(OTHER_LABEL)
    if (hasOther && !otherVal) return false
    return real.length > 0 || (hasOther && otherVal.length > 0)
  }

  const canSubmit = questions.length > 0 && questions.every(isAnswered)
  const answeredCount = questions.filter(isAnswered).length
  const remaining = questions.length - answeredCount

  const go = (next: number): void => {
    const clamped = Math.max(0, Math.min(questions.length - 1, next))
    if (clamped === index) return
    setDir(clamped > index ? 'next' : 'prev')
    setPage(clamped)
  }

  /** 多题没答完时主按钮「下一题」的去向：从当前题往后**循环**找第一道未作答的题；
   *  若只剩当前这题没答（找不到别的），就顺移一题 —— 总之按钮点了一定有反馈。 */
  const goNextUnanswered = (): void => {
    for (let step = 1; step < questions.length; step++) {
      const i = (index + step) % questions.length
      if (!isAnswered(questions[i])) {
        go(i)
        return
      }
    }
    go((index + 1) % questions.length)
  }

  /** 多题 + 还没答完 → 主按钮变「下一题」；答完（或单题）→ 「提交」（见文件头）。 */
  const showNext = multiple && !canSubmit

  const toggle = (q: NormalizedQuestion, label: string): void => {
    const cur = selected[q.id] ?? []
    // 勾上「其他」= 接下来要打字，把焦点交给它那个输入框（见文件头）
    if (label === OTHER_LABEL && !cur.includes(OTHER_LABEL)) focusPendingRef.current = q.id
    setSelected((prev) => {
      const prevCur = prev[q.id] ?? []
      if (q.multiSelect) {
        return {
          ...prev,
          [q.id]: prevCur.includes(label) ? prevCur.filter((x) => x !== label) : [...prevCur, label]
        }
      }
      return { ...prev, [q.id]: prevCur.includes(label) ? [] : [label] }
    })
  }

  const submit = (): void => {
    if (!canSubmit) return
    onResolve({
      answers: questions.map((q) => {
        const sel = selected[q.id] ?? []
        const other = (otherText[q.id] ?? '').trim()
        return {
          id: q.id,
          question: q.question,
          // 预设项里不保留「其他」这个哨兵：它是 UI 细节，不是模型给的真实选项
          selected: sel.filter((x) => x !== OTHER_LABEL),
          ...(other ? { other } : {})
        }
      })
    })
  }

  // 是/否题不加「其他」；其余（单选 / 多选）在末尾追加一项
  const shownOptions = isYesNoQuestion(current)
    ? current.options
    : [...current.options, { label: OTHER_LABEL, description: tr('自己输入') }]
  const otherSelected = (selected[current.id] ?? []).includes(OTHER_LABEL)

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5',
        // 多题：宽度钉死（翻页时卡片左右不跳），高度只给下限 —— 选项多了跟着长，
        // 不再固定 18rem + 内部滚动（见文件头「选项区不滚动」）
        multiple ? 'min-h-[18rem] w-[min(100%,26rem)]' : 'w-fit max-w-full'
      )}
      onKeyDown={(e) => {
        if (!multiple) return
        // 输入框里的 ← → 是移光标，别抢
        const t = e.target as HTMLElement
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          go(index - 1)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          go(index + 1)
        }
      }}
    >
      {/* 顶部一行：整体描述（title）+ 「第 N / M 题」计数。
          计数**跟着整体描述走**（不再挂在题干那一行的右端）—— 题干本身可能很长会换行，
          计数贴着题干会被挤到忽左忽右；钉在描述行右端，翻页时位置稳定。
          描述**换行不截断**（`break-words`）：它就是用户要读的那句话，截掉半截没法看。
          只有多题（`multiple`）才显示计数。 */}
      {(title || multiple) && (
        <div className="mb-2 flex shrink-0 items-start gap-2">
          {title && (
            <p className="min-w-0 grow break-words text-sm font-medium text-foreground">{title}</p>
          )}
          {multiple && (
            <span className="ml-auto shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
              {tr('第 {index} / {total} 题', { index: index + 1, total: questions.length })}
            </span>
          )}
        </div>
      )}

      {/* 补答提示（只有「这一轮已经结束」时才有）：说清按下去会发生什么，
          不然用户会以为还在给原来那一轮作答 */}
      {note && <p className="mb-2 shrink-0 text-xs text-muted-foreground">{note}</p>}

      {/* 当前这一题。`key` 跟着题走 —— 换题 = 重挂载，滑入动画才会重放。
          题面（题号徽标 + 题干）与选项区都**不设高度上限**：选项全量铺开、不滚，
          内容高过一屏时由消息区滚（见文件头「选项区不滚动」）。 */}
      <div
        key={current.id}
        className={cn(
          'flex min-h-0 grow flex-col gap-1',
          multiple && 'animate-in fade-in duration-150',
          multiple && (dir === 'next' ? 'slide-in-from-right-2' : 'slide-in-from-left-2')
        )}
      >
        <div className="flex shrink-0 items-start gap-1.5">
          <span className="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
            {current.header}
          </span>
          {/* 题干**换行不截断**：这是用户真正要读的内容，截断等于把问题吃掉一半 */}
          <span className="min-w-0 grow break-words text-sm text-foreground">{current.question}</span>
        </div>
        <div className="flex grow flex-col gap-0.5 pl-0.5">
          {shownOptions.map((opt) => {
            const checked = (selected[current.id] ?? []).includes(opt.label)
            const Icon = current.multiSelect
              ? checked
                ? SquareCheck
                : Square
              : checked
                ? CircleCheck
                : Circle
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => toggle(current, opt.label)}
                className={cn(
                  'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                  checked ? 'bg-primary/10 text-foreground' : 'text-foreground/80 hover:bg-foreground/10'
                )}
              >
                <Icon
                  className={cn('mt-0.5 size-4 shrink-0', checked ? 'text-primary' : 'text-muted-foreground')}
                />
                <span className="min-w-0">
                  <span className="block break-words">{opt.label === OTHER_LABEL ? tr(OTHER_LABEL) : opt.label}</span>
                  {opt.description && (
                    <span className="block text-xs text-muted-foreground">{opt.description}</span>
                  )}
                </span>
              </button>
            )
          })}
          {/* 选中「其他」后展开自由输入：单选时它就是唯一答案，多选时可与预设项并存 */}
          {otherSelected && (
            <Input
              ref={otherInputRef}
              value={otherText[current.id] ?? ''}
              onChange={(e) => setOtherText((prev) => ({ ...prev, [current.id]: e.target.value }))}
              placeholder={tr('补充你的回答…')}
              aria-label={tr('其他（自由输入）')}
              className="mt-1 h-8 text-[0.8125rem]"
            />
          )}
        </div>
      </div>

      <div className="mt-2.5 flex shrink-0 items-center gap-2">
        {multiple && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={index === 0}
              aria-label={tr('上一题')}
              title={tr('上一题（←）')}
              onClick={() => go(index - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            {/* 圆点：当前那颗拉长，已作答的实心 —— 一眼看出还剩哪几题没答 */}
            <div className="flex items-center gap-1">
              {questions.map((q, i) => (
                <button
                  key={q.id}
                  type="button"
                  aria-label={isAnswered(q) ? tr('第 {index} 题（已作答）', { index: i + 1 }) : tr('第 {index} 题（未作答）', { index: i + 1 })}
                  aria-current={i === index}
                  title={q.header || q.question}
                  onClick={() => go(i)}
                  className={cn(
                    'h-1.5 rounded-full transition-all',
                    i === index
                      ? 'w-4 bg-primary'
                      : cn(
                          'w-1.5',
                          isAnswered(q) ? 'bg-primary/45' : 'bg-foreground/20 hover:bg-foreground/35'
                        )
                  )}
                />
              ))}
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={index === questions.length - 1}
              aria-label={tr('下一题')}
              title={tr('下一题（→）')}
              onClick={() => go(index + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            className="h-8 text-[0.8125rem]"
            disabled={!showNext && !canSubmit}
            title={canSubmit ? tr('提交全部答案') : tr('还有 {count} 题没答', { count: remaining })}
            onClick={showNext ? goNextUnanswered : submit}
          >
            {showNext ? tr('下一题') : tr('提交')}
          </Button>
          {/* 补答（那一轮已经结束）没有「跳过」可言：跳过意味着什么都不做，
              而这里按下去本来就是发一条新消息 —— 给一颗点了没反应的按钮只会让人困惑 */}
          {!note && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-[0.8125rem]"
              onClick={() => onResolve(null)}
            >
              {tr('跳过')}
            </Button>
          )}

        </div>
      </div>
    </div>
  )
}

/**
 * 已回答的收起态。
 *
 * **样式与工具调用卡（`PartView` 的 `ToolCallCard`）完全同构**：同一个 `Collapsible`
 * 外壳、同一个触发行口径（`text-muted-foreground` + hover 提亮 + 无边框无底色）、
 * 同一个 `ChevronRight` 箭头（展开时 `rotate-90`，不是另画一个 ▾）、
 * 同一个状态 `Badge`。所以两类卡在一条消息里交替出现时看起来是一套东西，
 * 而不是「工具条是一种样式、提问条是另一种」。
 *
 * 与工具卡一致的两处行为细节：
 * - **受控 `open`**（初值恒 false，只由用户点开）：理由见 `ToolCallCard` 的注释 ——
 *   一轮结束时 `loadMessages()` 用服务端权威消息覆盖本地那份，消息 id 变化 → 子树重挂载，
 *   `defaultOpen` 会被重新取值。
 * - **开合时 `holdScroll()`**：展开内容在原地向下长，不把视图拽到底部。
 *
 * 与工具卡唯一的**有意**差异：内容区仍然带 `border`（问答题的展开内容是「每题 + 选项」，
 * 用盒子圈起来比裸排一堆 chip 好读；工具卡的直显内容同样带 `border`，见 `PartView`
 * 的 `acpDirect / fileDiff / builtinDirect` 分支）。
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
  const tr = useT()
  const [open, setOpen] = useState(false)
  // 消息区的滚动上下文（可能不在 Conversation 里，拿不到就退化成空操作）
  const conversation = useConversationOptional()
  const obj = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>
  const answered = obj.answered !== false
  const answers = Array.isArray(obj.answers)
    ? (obj.answers as Array<{ id: string; question: string; selected: string[]; other?: string }>)
    : []
  const note = typeof obj.note === 'string' ? obj.note : ''
  const byId = new Map(answers.map((a) => [a.id, a]))

  // 状态徽章：图标 + 文案 + secondary 底色（工具卡那边已改成**只留图标**，这里没跟着改 ——
  // 提问卡的三种结局「已回答 / 已跳过 / 失败」光看图标分不清，文案是必要信息）。
  const StatusIcon = isError ? XCircle : answered ? CircleCheck : CircleSlash
  const statusLabel = isError ? tr('失败') : answered ? tr('已回答') : tr('已跳过')

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        conversation?.holdScroll()
        setOpen(next)
      }}
      defaultOpen={false}
      className="not-prose my-1 w-full rounded-md"
    >
      {/* 触发行照抄 ToolHeader：`flex max-w-full flex-col items-start` + 内层
          `inline-flex items-center gap-2`（触发区只占内容宽度，箭头贴着文字而不是
          被推到整行最右端）。图标与标题都不带自己的颜色类，靠继承跟随 hover 变化；
          问号图标的底色例外 —— 它要区分「正常 / 失败」，见下面的 className。 */}
      <CollapsibleTrigger
        className="group flex max-w-full flex-col items-start gap-1 rounded-md text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="inline-flex min-w-0 max-w-full items-center gap-2">
          <CircleQuestionMark
            className={cn('size-4 shrink-0', isError ? 'text-destructive' : 'text-muted-foreground')}
          />
          {/* 标题可截断（`min-w-0 truncate`）：提问文本可能很长，不截会把它后面的
              状态徽章和箭头顶出可视区 —— 与 ToolHeader 里 detail 的处理同一个道理。 */}
          <span className="min-w-0 truncate text-sm">
            {title || questions[0]?.question || tr('助手的提问')}
          </span>
          <Badge className="gap-1.5" variant="secondary">
            <StatusIcon
              className={cn(
                'size-4',
                isError
                  ? 'text-red-600 dark:text-red-500'
                  : answered
                    ? 'text-green-600 dark:text-green-500'
                    : 'text-muted-foreground'
              )}
            />
            {statusLabel}
          </Badge>
          {/* 箭头展开时转 90°：`group` + `data-state` 都在触发器上（同 ToolHeader）。
              没有 `group` 箭头就永远朝右。 */}
          <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        </span>
      </CollapsibleTrigger>
      {/* 内容区：动画 class 与 `ToolContent` 逐条一致（同一套淡入淡出 + 上下位移），
          边框盒与 `PartView` 直显分支的 `border border-border rounded-lg mt-2` 一样。
          Radix 在 `data-state=closed` 时给 hidden，所以收起后不占位。 */}
      <CollapsibleContent className="data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in flex flex-col gap-2 border border-border rounded-lg mt-2 p-3">
        {questions.map((q) => {
          const answer = byId.get(q.id)
          const sel = answer?.selected ?? []
          const other = answer?.other?.trim() ?? ''
          return (
            <div key={q.id} className="flex flex-col gap-1">
              <p className="text-xs text-foreground/80">{q.question}</p>
              {sel.length > 0 || other ? (
                <div className="flex flex-wrap gap-1.5">
                  {sel.map((label, i) => (
                    <span
                      key={`${label}-${i}`}
                      className="inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-xs text-foreground/80"
                    >
                      <span className="min-w-0 truncate">{label}</span>
                    </span>
                  ))}
                  {/* 「其他」自由输入的内容：和预设项并排展示，模型拿到的也是同一个字段 */}
                  {other && (
                    <span className="inline-flex max-w-full items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-xs text-foreground">
                      <span className="min-w-0 truncate">
                        {tr(OTHER_LABEL)}：{other}
                      </span>
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{isError ? tr('提问失败') : tr('未作答')}</p>
              )}
            </div>
          )
        })}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CollapsibleContent>
    </Collapsible>
  )
}