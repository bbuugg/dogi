import { Brain, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from 'cn'
import { CollapsibleRow } from '@/features/agent/CollapsibleRow'

/**
 * 思考过程横条（参考 ainav/sdk 的 ReasoningPanel，样式全部 Tailwind 重写）。
 *
 * 收起时就一行：[图标] [思考中 / 思考过程] [单行实时预览] [›]
 * - **思考中默认展开**（展开体实时滚动跟随最新内容），思考结束自动折叠；
 * - 流式（用户手动收起后）：spinner + 「思考中」柔和流光（见 index.css 的 .reasoning-thinking）
 *   + 单行预览**纵向**跟随最新一行
 *   （平时瞬时吸底，刚出现换行时平滑向上滚一行），不显示箭头；
 * - 完成：脑图标 + 「思考过程」，右侧箭头可展开完整内容；
 * - 展开体流式期间自动吸底（用户上滚则暂停跟随）。
 *
 * 是「一条横条」而不是卡片 —— 无边框、无底色，只有 hover 时的淡底。
 * Agent 页（工作区助手）与终端 AI 助手共用同一份实现。
 */
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

  const lineRef = useRef<HTMLDivElement>(null)
  /** 上一帧预览的可见行数（-1 = 尚未统计过），用来识别「刚出现换行」 */
  const prevLinesRef = useRef(-1)
  /** 平滑滚动动画的截止时刻：窗口期内不许瞬时吸底打断动画 */
  const smoothUntilRef = useRef(0)

  // 流式时预览**纵向**跟随最新一行：容器只有一行高，新的一行进来就把旧行顶上去。
  // 原来用 nowrap + scrollLeft 横向滚 —— 换行符会被折叠成空格，整段思考挤成一条横线。
  // - 平时增字：瞬时吸底 —— 正在打字那行的尾巴始终可见；
  // - 刚出现换行（可见行数 +1）：平滑向上滚一行，就是「换行时向上滚动一下」的效果。
  //   关键在动画窗口期（~400ms）内**不做瞬时吸底**：token 间隔远小于动画时长，
  //   下一个 token 的 scrollTop 赋值会把 smooth 动画当场打断，永远看不到滚动。
  //   `el.scrollTop > 0` 兜住刚挂载/重新折叠的场景：元素还停在顶部时直接跳到底，不做动画。
  useEffect(() => {
    const el = lineRef.current
    const lines = text.trimEnd().split('\n').length
    const grew = prevLinesRef.current >= 0 && lines > prevLinesRef.current
    prevLinesRef.current = lines
    if (!streaming || !el) return
    if (grew && el.scrollTop > 0) {
      smoothUntilRef.current = Date.now() + 400
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      return
    }
    if (Date.now() >= smoothUntilRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [text, streaming])

  return (
    <CollapsibleRow
      open={open}
      onOpenChange={setOpen}
      stickToBottom
      showChevron={!streaming}
      icon={
        streaming ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
        ) : (
          <Brain className="size-4 shrink-0 text-muted-foreground/70" />
        )
      }
      body={
        // 思考内容整体比正文浅一档（text-muted-foreground，与 CollapsibleRow 的默认一致，
        // 这里显式写出来是为了别被外层样式改动带跑）：它是过程，不是正文
        <div className="whitespace-pre-wrap text-muted-foreground">{text}</div>
      }
    >
      {/* 「思考中」带柔和流光（见 index.css 的 .reasoning-thinking）：思考结束换成静止的
          「思考了一会儿」，动画只服务于「还在进行中」这件事；两种状态都用 muted 底色，
          不抢正文（正文是 foreground） */}
      <span
        className={cn(
          'shrink-0 font-medium',
          streaming ? 'reasoning-thinking' : 'text-muted-foreground'
        )}
      >
        {streaming ? '思考中...' : '思考了一会儿'}
      </span>
      {/* 单行预览只在「流式中且未展开」时出现：展开后内容已经在下面了。
          `h-[1.4em]` + `leading-[1.4]` 让视口**正好一行高**（em 取本元素 text-xs 的 12px），
          配合 `whitespace-pre-wrap` 保留换行 —— 新行进来把旧行顶上去。
          不用 truncate：省略号正好把最新吐出来的那段吃掉。
          `trimEnd()`：模型常在段间吐 `\n\n`，视口只有一行高，不去掉尾部空白就会显示成空行。 */}
      {!open && streaming && (
        <span
          ref={lineRef}
          className="block h-[1.4em] min-w-0 overflow-hidden whitespace-pre-wrap break-words font-mono text-xs leading-[1.4] text-muted-foreground/70"
        >
          {text.trimEnd()}
        </span>
      )}
    </CollapsibleRow>
  )
}
