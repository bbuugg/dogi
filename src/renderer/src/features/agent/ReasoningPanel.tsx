import { Brain, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from 'cn'
import { CollapsibleRow } from '@/features/agent/CollapsibleRow'

/**
 * 思考过程横条（参考 ainav/sdk 的 ReasoningPanel，样式全部 Tailwind 重写）。
 *
 * 收起时就一行：[图标] [思考中 / 思考过程] [单行实时预览] [›]
 * - 流式：spinner + 「思考中」高亮 + 单行预览**纵向**滚到最新一行（保留换行，新行把旧行顶上去），
 *   不显示箭头；
 * - 完成：脑图标 + 「思考过程」，右侧箭头可展开完整内容；
 * - 展开体流式期间自动吸底（用户上滚则暂停跟随）。
 *
 * 是「一条横条」而不是卡片 —— 无边框、无底色，只有 hover 时的淡底。
 * Agent 页（工作区助手）与终端 AI 助手共用同一份实现。
 */
export function ReasoningPanel({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const lineRef = useRef<HTMLDivElement>(null)

  // 流式时预览**纵向**滚到最新一行：容器只有一行高，新的一行进来就把旧行顶上去，
  // 看上去就是「一行一行往上滚」。原来用 nowrap + scrollLeft 横向滚 —— 换行符会被
  // 折叠成空格，整段思考挤成一条横线，永远看不到「行」的概念。
  useEffect(() => {
    if (streaming && lineRef.current) {
      lineRef.current.scrollTop = lineRef.current.scrollHeight
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
        <div className="whitespace-pre-wrap">{text}</div>
      }
    >
      <span className={cn('shrink-0 font-medium', streaming ? 'text-primary' : 'text-foreground/80')}>
        {streaming ? '思考中' : '思考过程'}
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
