/**
 * 消息区滚动容器：基于 `use-stick-to-bottom`（v1.1.6）实现「贴住底部」。
 *
 * 库内部用 spring 动画平滑跟随内容增长（就是「消息向上流动」顺滑观感的来源）；
 * 仅当「已经贴底」时才会自动跟随，用户上滚即停止、滚回底部自动恢复。
 *
 * 照搬自 fishwork 的 `components/ai-elements/conversation.tsx`，只做本仓适配：
 * - 无 shadcn：回底按钮用原生 `button`（Tailwind）；
 * - 滚动条槽位用 `[scrollbar-gutter:stable]`（本仓没有 fishwork 的 `pointer-fine:` 变体）；
 * - 消息间距 / 宽度交给调用方的 `ConversationContent` className（保持两处现有视觉不变）。
 *
 * 这里做三件事：
 * 1. 切换会话 / 消息装载完成 / **自己发出新消息**（resetKey 变化）：`useLayoutEffect` 里
 *    瞬时落底，压掉从顶部平滑接管下来的动画（库默认 resize 是 spring）；
 * 2. 用户手动开合折叠块（`holdScroll`）：转调库的 `stopScroll()` 退出跟随，
 *    刚展开的内容向下长出来、视图不动，点的那张卡不会被拽到底部；
 * 3. 对外提供 `isAtBottom` / `scrollToBottom` / `holdScroll`。
 */
import { ArrowDown } from 'lucide-react'
import { useStickToBottom } from 'use-stick-to-bottom'
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  type ComponentProps,
  type ReactNode
} from 'react'
import { cn } from 'cn'

type ConversationContextValue = {
  isAtBottom: boolean
  scrollToBottom: () => void
  /** 用户手动开合折叠块时调用：退出自动贴底，别把刚展开的内容拽到底部 */
  holdScroll: () => void
}

const ConversationContext = createContext<ConversationContextValue | null>(null)

/** 取消息区的滚动状态与动作（必须在 <Conversation> 内使用） */
export function useConversation(): ConversationContextValue {
  const context = useConversationOptional()
  if (!context) {
    throw new Error('useConversation must be used within a <Conversation>')
  }
  return context
}

/**
 * 同 `useConversation`，但在 `<Conversation>` 之外调用时**返回 null 而不是抛错**。
 * 给「既可能在消息流里、也可能单独渲染」的片段用（如工具卡 / 思考条）。
 */
export function useConversationOptional(): ConversationContextValue | null {
  return useContext(ConversationContext)
}

export type ConversationProps = ComponentProps<'div'> & {
  /**
   * 变化时立刻（瞬时）落底。切换会话 / 消息装载完成 / **自己发出新消息**时由调用方递增 ——
   * 用 useLayoutEffect 在本帧 paint 之前写 scrollTop，杜绝任何中间态。
   */
  resetKey?: string
}

export const Conversation = ({
  className,
  resetKey,
  children,
  style,
  ...props
}: ConversationProps) => {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll } = useStickToBottom({
    // 首屏 / 初次挂载直接落底（不要从顶部动画下来）
    initial: 'instant'
  })

  /** 用户手动开合折叠块：退出跟随，让内容向下长、视图留在原地（见文件头注释）。 */
  const holdScroll = useCallback(() => {
    stopScroll()
  }, [stopScroll])

  // 切换会话 / 消息装载完成 / 自己发消息：本帧 paint 之前瞬时落底（不要平滑动画）
  useLayoutEffect(() => {
    scrollToBottom({ animation: 'instant' })
  }, [resetKey, scrollToBottom])

  return (
    <ConversationContext.Provider value={{ isAtBottom, scrollToBottom, holdScroll }}>
      <div
        ref={scrollRef}
        className={cn(
          // select-text：AiPanel 的卡片外壳是 select-none，消息区要恢复可选中复制
          'relative min-h-0 flex-1 select-text overflow-y-auto [scrollbar-gutter:stable]',
          className
        )}
        /*
         * overflow-anchor: none —— 关掉 Chromium 的滚动锚定。流式内容增长 / markdown 重排时
         * 它会「帮忙」修正滚动位置，造成偶发跳顶。滚动位置由 use-stick-to-bottom 显式管理。
         */
        style={{ overflowAnchor: 'none', ...style }}
        {...props}
      >
        <div ref={contentRef}>{children}</div>
      </div>
    </ConversationContext.Provider>
  )
}

export type ConversationContentProps = ComponentProps<'div'>

/** 消息列容器：只负责纵向排列，宽窄 / 间距由调用方 className 决定 */
export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <div className={cn('flex flex-col', className)} {...props} />
)

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string
  description?: string
  icon?: ReactNode
}

export const ConversationEmptyState = ({
  className,
  title = '还没有消息',
  description = '发起对话后会在这里看到消息',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
)

export type ConversationScrollButtonProps = ComponentProps<'button'>

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useConversation()

  if (isAtBottom) return null

  return (
    // sticky（而不是 absolute）：按钮在滚动容器**里面**，用 sticky 才能一直贴在可视区底部
    <div className="pointer-events-none sticky bottom-4 z-10 -mt-12 flex justify-center">
      <button
        type="button"
        onClick={scrollToBottom}
        title="滚动到底部"
        aria-label="滚动到底部"
        className={cn(
          'pointer-events-auto flex size-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-secondary hover:text-foreground',
          className
        )}
        {...props}
      >
        <ArrowDown className="size-4" />
      </button>
    </div>
  )
}
