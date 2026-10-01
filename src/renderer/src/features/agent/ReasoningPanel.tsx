import { Brain } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { cn } from 'cn'
import { CollapsibleRow } from '@/features/agent/CollapsibleRow'

/**
 * 思考过程横条（参考 ainav/sdk 的 ReasoningPanel，样式全部 Tailwind 重写）。
 *
 * 收起时就一行：[图标] [思考中 / 思考过程] [单行实时预览] [›]
 * - **思考中默认展开**（展开体实时滚动跟随最新内容），思考结束自动折叠；
 * - 流式（用户手动收起后）：spinner + 「思考中」柔和流光（见 index.css 的 .reasoning-thinking）
 *   + 单行预览**纵向**跟随最新一行（新行进来平滑向上滚），不显示箭头；
 * - 完成：脑图标 + 「思考过程」，右侧箭头可展开完整内容；
 * - 展开体流式期间自动吸底（用户上滚则暂停跟随）。
 *
 * 两处跟随都用 `use-stick-to-bottom`（与消息区 Conversation 同一套），所以是 spring
 * 平滑跟随而不是逐 token 瞬时跳转 —— 详见下面两处注释。
 *
 * 是「一条横条」而不是卡片 —— 无边框、无底色，只有 hover 时的淡底。
 * Agent 页（工作区助手）与终端 AI 助手共用同一份实现。
 */
/**
 * 思考时长文案（收起时横条上那四个字）。
 *
 * fishwork 只到「思考了 N 秒」一档，这里补了分钟档 —— 复杂任务思考几分钟很常见，
 * 显示成「思考了 187 秒」不如「思考了 3 分 7 秒」直觉。
 *
 * ⚠️ `null`（没量到）/ 不足 1 秒（ceil 出来是 0）都显示「思考了一会儿」：那是「想了一下」的
 * 自然说法，比「思考了 0 秒」体面。fishwork 对 `duration === 0` 也是这么处理的，它还特意注释
 * 过一件事：这时**绝不能再走「正在思考…」那个流光分支**，否则思考不到 1 秒就结束时，
 * 收起后的头部会一直闪着，看着像还没想完。
 */
export function thinkingDurationText(durationSec: number | null): string {
  if (durationSec === null || durationSec <= 0) return '思考了一会儿'
  if (durationSec < 60) return `思考了 ${durationSec} 秒`
  const minutes = Math.floor(durationSec / 60)
  const rest = durationSec % 60
  if (rest === 0) return `思考了 ${minutes} 分钟`
  return `思考了 ${minutes} 分 ${rest} 秒`
}

export function ReasoningPanel({ text, streaming }: { text: string; streaming: boolean }) {
  // 思考中**默认展开**（内容实时可见），思考结束后**自动折叠**成一条横条。
  // 展开态跟随 streaming 的跳变：true→false 折叠，false→true（多步推理又开思考）展开；
  // 用户中途手动收起 / 展开以他的操作为准，不会被强制拉回。
  const [open, setOpen] = useState(streaming)
  const prevStreamingRef = useRef(streaming)
  useEffect(() => {
    if (prevStreamingRef.current === streaming) return
    prevStreamingRef.current = streaming
    setOpen(streaming)
  }, [streaming])

  /**
   * 思考计时：与 fishwork `ai-elements/reasoning.tsx` 的 duration 同一口径 ——
   * 只在这个组件里量「流式开始 → 流式结束」这段墙钟时间（`Date.now()`），**不落盘**。
   *
   * 为什么不落盘：思考时长是过程信息，ACP 会话的消息根本不在本地（回放时 agent 也没报这次
   * 思考花了多久），想让它跨重载存活只能让主进程给 reasoning part 补时间戳，链路长且对
   * ACP 回放无解。代价是组件卸载（切走会话 / 重新挂载）后退化成「思考了一会儿」—— fishwork
   * 同样如此：它的 duration 也只活在组件状态里。
   */
  const startAtRef = useRef<number | null>(null)
  const [durationSec, setDurationSec] = useState<number | null>(null)
  useEffect(() => {
    if (streaming) {
      // 多步推理时流式会 true→false→true 反复：只在「上一轮已结算」后才重新起表
      if (startAtRef.current === null) startAtRef.current = Date.now()
      return
    }
    if (startAtRef.current === null) return
    const elapsed = Date.now() - startAtRef.current
    startAtRef.current = null
    // 多步推理（同一次思考里流式暂停又继续）是**累加**而不是覆盖：每一段都算了时间，
    // 最后显示的才是这次思考的总时长，而不是最后那一段。
    const segmentSec = Math.ceil(elapsed / 1000) // 向上取整：0.4 秒也说「1 秒」
    setDurationSec((prev) => (prev ?? 0) + segmentSec)
  }, [streaming])

  /**
   * 单行预览的「纵向跟随最新一行」同样交给 `use-stick-to-bottom`（与展开体、消息区同一套）：
   * 视口只有一行高，模型每吐出一个换行内容就长高，库用 spring 平滑把它顶上去 —— 就是
   * 「换行时向上滚动一下」的观感。
   *
   * ⚠️ 别改回手写的「瞬时吸底 + 换行时 scrollTo({behavior:'smooth'}) + 400ms 动画窗口期」：
   * token 间隔远小于动画时长，下一个 token 的 scrollTop 赋值会把 smooth 动画当场打断，
   * 永远看不到滚动（这套曾经踩过的坑，用库就不用再维护时间窗口）。
   * 也不用 nowrap + scrollLeft 横向滚 —— 换行符会被折叠成空格，整段思考挤成一条横线。
   * `initial: 'instant'` 兼管「预览重新挂载时直接落到最新一行」。
   */
  const { scrollRef: lineScrollRef, contentRef: lineContentRef } = useStickToBottom({
    initial: 'instant'
  })

  return (
    <CollapsibleRow
      open={open}
      onOpenChange={setOpen}
      stickToBottom
      showChevron={!streaming}
      icon={<Brain className="size-4 shrink-0 text-muted-foreground/70" />}
      body={
        // 思考内容整体比正文浅一档（text-muted-foreground，与 CollapsibleRow 的默认一致，
        // 这里显式写出来是为了别被外层样式改动带跑）：它是过程，不是正文
        <div className="whitespace-pre-wrap text-muted-foreground">{text}</div>
      }
    >
      {/* 「思考中」带柔和流光（见 index.css 的 .reasoning-thinking）：思考结束换成静止的
          「思考了 X 秒 / X 分 X 秒」，动画只服务于「还在进行中」这件事；两种状态都用 muted
          底色，不抢正文（正文是 foreground） */}
      <span
        className={cn(
          'shrink-0 font-medium',
          streaming ? 'reasoning-thinking' : 'text-muted-foreground'
        )}
      >
        {streaming ? '思考中...' : thinkingDurationText(durationSec)}
      </span>
      {/* 单行预览只在「流式中且未展开」时出现：展开后内容已经在下面了。
          `h-[1.4em]` + `leading-[1.4]` 让视口**正好一行高**（em 取本元素 text-xs 的 12px），
          配合 `whitespace-pre-wrap` 保留换行 —— 新行进来把旧行顶上去。
          不用 truncate：省略号正好把最新吐出来的那段吃掉。
          `trimEnd()`：模型常在段间吐 `\n\n`，视口只有一行高，不去掉尾部空白就会显示成空行。 */}
      {!open && streaming && (
        <span
          ref={lineScrollRef}
          className="block h-[1.4em] min-w-0 overflow-hidden whitespace-pre-wrap break-words font-mono text-xs leading-[1.4] text-muted-foreground/70"
        >
          {/* contentRef 必须落在**内容盒子**上：库靠它的高度变化判断「该往下滑多少」 */}
          <span ref={lineContentRef} className="block">
            {text.trimEnd()}
          </span>
        </span>
      )}
    </CollapsibleRow>
  )
}
