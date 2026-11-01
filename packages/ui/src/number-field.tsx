import * as React from "react"
import { Input } from "./input"
import {
  isDraftCommittable,
  normalizeNumberDraft,
  parseNumberDraft,
  type NumberDraftRange
} from "./number-field-value"

/**
 * 数字输入框：**打字期间是草稿，失焦才归一化**。
 *
 * ## 为什么不用 `value={state}` + `onChange` 直连
 *
 * 那样写的时候，「清空」会立刻变成一次提交：`''` 被兜成默认值、写回 store、再作为
 * `value` 渲染回来 —— 用户刚删完就看见上一次的数字跳回来，接着打 `5` 得到 `805`
 * 这种串行的结果（设置页里每个数字项都踩过）。根因是**受控值把「正在输入」和
 * 「已保存」混成了同一个东西**。
 *
 * 这里把两件事拆开：
 * - `draft` 是输入框的真源（用户打什么就是什么，删空就是空）；
 * - 只有「完整且在区间内」的草稿才立刻提交（打 `1` `5` `0` 就依次存 1 / 15 / 150，
 *   与原来「改一个字符就生效」的手感一致；`commitWhileTyping={false}` 则只在失焦时提交）；
 * - 失焦（或面板卸载）时才归一化：空 → `null`、小数 → 四舍五入、越界 → 按 `clamp` 夹或原样提交。
 *   越界期间输入框带 `aria-invalid`（红边）+ `title` 提示，不静默吞掉。
 *
 * ⚠️ 外部值变化时**只在没聚焦时**同步草稿。聚焦时同步 = 又把用户正在打的字顶掉，
 * 也就是这条组件存在的理由。
 *
 * 逻辑全在 `number-field-value.ts`（纯函数，node 环境可测）。
 */
export interface NumberFieldProps
  extends Omit<React.ComponentProps<"input">, "value" | "defaultValue" | "onChange" | "type"> {
  /** 已保存的值；`null` = 空输入框（「留空」本身有含义的字段用得上） */
  value: number | null
  min?: number
  max?: number
  /** 只接受整数（默认 true）；`false` 时收小数（如 CPU 核数） */
  integer?: boolean
  /** 越界时夹到边界（默认 true）；`false` = 只标红提示，值原样交给调用方校验 */
  clamp?: boolean
  /** 打字过程中就提交合法值（默认 true）；`false` = 只在失焦时提交一次 */
  commitWhileTyping?: boolean
  /** 提交：`null` = 用户清空了（回默认值还是不限制，由调用方决定） */
  onValueChange: (value: number | null) => void
  /** 草稿越界时给的一句提示（进 `title`），由调用方 `tr()` 好 */
  invalidHint?: string
}

function NumberField({
  value,
  min,
  max,
  integer = true,
  clamp = true,
  commitWhileTyping = true,
  onValueChange,
  invalidHint,
  step = 1,
  title,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: NumberFieldProps) {
  const range: NumberDraftRange = { min, max, integer, clamp, fallback: value }
  const toDraft = (next: number | null): string => (next === null ? "" : String(next))
  const [draft, setDraft] = React.useState(() => toDraft(value))
  const focused = React.useRef(false)
  /** Esc 放弃这一稿：失焦时必须跳过提交，否则刚被放弃的内容又会被存进去 */
  const abandoned = React.useRef(false)
  /** 卸载时要用的最新一份，避免把过期的闭包存进 cleanup */
  const latest = React.useRef({ draft: toDraft(value), value, onValueChange, range })

  React.useEffect(() => {
    latest.current = { draft, value, onValueChange, range }
  })

  // 外部值变化（别的窗口改了 / 服务端回推）才同步草稿；正在输入时绝不覆盖
  React.useEffect(() => {
    if (!focused.current) setDraft(value === null ? "" : String(value))
  }, [value])

  // 面板关掉不会触发 blur：把没提交的草稿在这里落下去，别让「打了没生效」
  React.useEffect(
    () => () => {
      const last = latest.current
      const normalized = normalizeNumberDraft(last.draft, last.range)
      if (normalized !== last.value) last.onValueChange(normalized)
    },
    []
  )

  const parsed = parseNumberDraft(draft)
  // 只有「完整但越界 / 小数」才标红：`""`、`"-"`、`"12."` 是打字过程中的正常中间态
  const invalid = parsed !== null && !isDraftCommittable(draft, range)

  return (
    <Input
      {...props}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      aria-invalid={invalid ? true : undefined}
      title={invalid ? invalidHint : title}
      onFocus={(event) => {
        focused.current = true
        onFocus?.(event)
      }}
      onChange={(event) => {
        const raw = event.target.value
        setDraft(raw)
        const next = parseNumberDraft(raw)
        if (commitWhileTyping && next !== null && isDraftCommittable(raw, range)) {
          onValueChange(next)
        }
      }}
      onBlur={(event) => {
        focused.current = false
        if (abandoned.current) {
          // Esc 之后的那次失焦：只把显示恢复成已保存的值，不回写
          abandoned.current = false
          setDraft(toDraft(value))
          onBlur?.(event)
          return
        }
        const normalized = normalizeNumberDraft(event.target.value, range)
        setDraft(toDraft(normalized))
        if (normalized !== value) onValueChange(normalized)
        onBlur?.(event)
      }}
      onKeyDown={(event) => {
        // 回车 = 确认（等价失焦）；Esc = 放弃这一稿，回到已保存的值
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === "Escape") {
          abandoned.current = true
          event.currentTarget.blur()
        }
        onKeyDown?.(event)
      }}
    />
  )
}

export { NumberField }
