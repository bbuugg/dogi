import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref
} from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { ArrowDown } from 'lucide-react'
import { cn } from 'cn'

/**
 * 虚拟滚动的消息流（Agent 页与终端内嵌 AI 助手共用）。
 *
 * 用 react-virtuoso 只渲染视口内 + 视口附近的日消息 —— 长会话不再整列表
 * 渲染/重排（此前每个 token 都全量重渲染所有消息，是卡顿的根源）。同时接管原
 * `useMessageListScroll` 的全部职责：
 *
 * - **跟随底部**：`followRef` 表示「跟随意图」，true 时任何内容变化（流式 token、
 *   思考 / 工具横条展开折叠、发送新消息）都钉在底部；
 * - **发送强制回底**：用户新发消息时无论翻到哪里都滚回最底；
 * - **上翻暂停**：滚轮上滚 / 上方向键 / 触摸下拉立即解除跟随，不抢用户位置；
 * - **选区保护**：列表里有进行中的文本选择时一步都不滚；
 * - **「滚动到底部」按钮**：离底超过 `atBottomThreshold`（48px）才出现；
 * - **换会话重置**：`listKey`（会话 id）变化 → 整个重挂，直接落在最新一条；
 * - **extra 变化**（终端 AI 卡片从折叠态展开）：等高度过渡结束再落到底。
 *
 * ⚠️ **跟随意图 ≠ 当前是否贴底**。贴在底部时展开一个思考 / 工具横条，内容瞬间
 * 变高会立即超过底部阈值、让「是否贴底」变成 false；若据此停止跟随，下一个 token
 * 又会重新贴底 —— 一展一停再一跳，表现就是「会话进行中折叠/展开横条导致消息乱跳」。
 * 所以两者必须分开：只有**用户的主动上翻**才会解除跟随意图。
 */
function hasListSelection(el: HTMLElement | null): boolean {
  if (!el) return false
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
  for (let i = 0; i < sel.rangeCount; i++) {
    if (sel.getRangeAt(i).intersectsNode(el)) return true
  }
  return false
}

/** 滚动条外观沿用 agent-scroll；关掉 Chromium 滚动锚定（位置由 Virtuoso 自己管理） */
const Scroller = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function VirtualMessageScroller({ style, ...props }, ref) {
    return (
      <div
        ref={ref}
        {...props}
        style={{ ...style, overflowAnchor: 'none' } as CSSProperties}
        className={cn('agent-scroll select-text', props.className)}
      />
    )
  }
)

export interface VirtualMessageListHandle {
  /** 把指定 id 的消息滚到可视区顶部（消息目录跳转用） */
  scrollToMessage: (id: string) => void
}

interface VirtualMessageListProps<T> {
  /** 重挂 key（会话 id）：换会话整个重挂，初始落点就是最新一条 */
  listKey: string
  /** 消息列表（每 token 都会换新数组：这正是 followOutput 的触发信号） */
  messages: readonly T[]
  /** 渲染单条消息（含各自的居中 / 间距包装）；index 是它在列表中的下标 */
  renderItem: (item: T, index: number) => ReactNode
  /** 列表尾部的附加内容（错误条等），随内容一起滚动 */
  footer?: ReactNode
  /** 顶部留白 px（对齐原容器的 padding-top） */
  topGap?: number
  /** 变化时强制回落底部（如终端 AI 卡片从折叠态展开，高度才确定） */
  extra?: unknown
  /** 根容器尺寸类：Agent 页传 `min-h-0 flex-1`，终端助手传 `h-full` */
  className?: string
}

export function VirtualMessageList<T extends { id: string; role: string }>({
  ref,
  listKey,
  messages,
  renderItem,
  footer = null,
  topGap = 16,
  extra,
  className
}: VirtualMessageListProps<T> & { ref?: Ref<VirtualMessageListHandle> }) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const scrollerElRef = useRef<HTMLElement | null>(null)
  /**
   * 跟随意图（不是「当前是否贴底」）：true 时任何内容变化都贴底。
   * - 置 true：发送新消息 / 点「回到底部」/ 面板展开 / **到达底部**
   * - 置 false：用户主动上翻（滚轮上滚、上方向键、触摸下拉）
   * 展开横条导致的临时离开底部**不会**解除它 —— 否则就是「一展一停再一跳」。
   */
  const followRef = useRef(true)
  const prevCountRef = useRef(messages.length)
  const prevExtraRef = useRef(extra)
  const [showJump, setShowJump] = useState(false)
  /** 当前滚动元素（经 state 跟随重挂，事件监听的 effect 依赖它） */
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null)

  /** 列表尾部内容经 ref 透传：components 引用保持稳定，内容每渲染都是最新的 */
  const footerRef = useRef<ReactNode>(footer)
  footerRef.current = footer

  const components = useMemo(
    () => ({
      Scroller,
      Header: () => <div style={{ height: topGap }} />,
      Footer: () =>
        footerRef.current ? (
          <div className="pb-3">{footerRef.current}</div>
        ) : (
          <div style={{ height: topGap / 4 }} />
        )
    }),
    [topGap]
  )

  /** 立即贴底（不经过 Virtuoso 的数据变更回调，用于内容尺寸变化时纠偏） */
  const pinToBottom = useCallback(() => {
    const el = scrollerElRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  /** 稳定的 scroller ref 回调：内联箭头每渲染换新身份，React 会反复以 null/el 调用，
   *  Virtuoso 内部状态也跟着折腾 —— 稳定引用是消除滚动期异常的基本功 */
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const node = (el as HTMLElement | null) ?? null
    scrollerElRef.current = node
    setScrollerEl(node)
  }, [])

  // 用户的主动上翻 = 明确的「我要自己看」：解除跟随。只认无歧义的输入
  // （滚轮上滚 / 上方向键 / 触摸下拉），**不做滚动方向推断** —— Virtuoso 为保持
  // 视口稳定会自己调 scrollTop，方向推断会把它误判成用户上翻。
  useEffect(() => {
    if (!scrollerEl) return
    let touchStartY = 0
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) followRef.current = false
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') {
        followRef.current = false
      }
    }
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (e: TouchEvent) => {
      // 手指下滑 = 内容上滚
      if ((e.touches[0]?.clientY ?? 0) > touchStartY + 4) followRef.current = false
    }
    scrollerEl.addEventListener('wheel', onWheel, { passive: true })
    scrollerEl.addEventListener('keydown', onKeyDown)
    scrollerEl.addEventListener('touchstart', onTouchStart, { passive: true })
    scrollerEl.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      scrollerEl.removeEventListener('wheel', onWheel)
      scrollerEl.removeEventListener('keydown', onKeyDown)
      scrollerEl.removeEventListener('touchstart', onTouchStart)
      scrollerEl.removeEventListener('touchmove', onTouchMove)
    }
  }, [scrollerEl])

  // 跟随状态下内容高度变化（流式 token、思考 / 工具横条展开折叠）时**立即**贴底。
  // 只靠 followOutput 会晚一拍（要等下一个 token 的数据变更才纠偏）—— 那一拍就是
  // 「展开横条后消息猛地跳一下」的来源。ResizeObserver 盯住列表内容的总高度。
  useEffect(() => {
    if (!scrollerEl) return
    const content = (scrollerEl.firstElementChild as HTMLElement | null) ?? scrollerEl
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!followRef.current) return
      if (hasListSelection(scrollerElRef.current)) return
      pinToBottom()
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [scrollerEl, pinToBottom])

  // 用户新发消息：无论之前翻到哪里，一律滚回最底 —— 发出去的话必须立刻看见。
  // 只在「列表变长且新增的是用户消息」时触发，流式增量不进这里。
  //
  // 时序坑（两个都踩过）：
  // 1. **不能同步调 scrollToIndex** —— 同一次提交里 Virtuoso 还没处理完新增数据，
  //    命令式滚动会落在旧列表上被丢弃/钳位（表现为「发了消息但不滚」）；
  // 2. **不能在 useLayoutEffect 里置标记** —— layout effect 子先父后，Virtuoso 对
  //    followOutput 的决策可能先于父级 effect 执行，标记立起来就晚了。
  //    所以在 render 阶段就把标记立起来（render 期间置 ref 是幂等的，
  //    StrictMode 双渲染第二次会因计数相等而跳过，不会重复触发）。
  if (messages.length > prevCountRef.current) {
    // ⚠️ 不能只看最后一条：store 发消息时会在同一次 set 里追加「用户消息 + 空的助手
    // 占位消息」，最后一条是 assistant —— 只看它永远不会触发跟随（这就是「发了消息
    // 不滚」的真凶）。判据改成「本次新增的这批里**含有**用户消息」。
    const added = messages.slice(prevCountRef.current)
    prevCountRef.current = messages.length
    if (added.some((m) => m.role === 'user')) followRef.current = true
  } else if (messages.length < prevCountRef.current) {
    // 删除消息 / 编辑重发（先删后增）：同步计数，避免把旧长度带到下一轮误判
    prevCountRef.current = messages.length
  }

  // extra 变化（终端 AI 卡片从折叠展开）：高度有 ~200ms 过渡，等它结束再落点，
  // 否则按高度 0 算出来的位置是错的。
  useEffect(() => {
    if (prevExtraRef.current === extra) return
    prevExtraRef.current = extra
    if (extra === undefined) return
    const t = setTimeout(() => {
      followRef.current = true
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
    }, 260)
    return () => clearTimeout(t)
  }, [extra])

  // 贴底跟随：每个 token 都会触发，必须便宜 —— 只查 ref 与选区，不碰布局。
  const followOutput = useCallback((isAtBottom: boolean) => {
    if (hasListSelection(scrollerElRef.current)) return false
    // 跟随意图优先：展开横条会临时离开底部阈值，但意图仍在，必须继续跟随
    if (followRef.current || isAtBottom) return 'auto' as const
    return false
  }, [])

  const handleAtBottomChange = useCallback((bottom: boolean) => {
    // 真正到达底部 → 恢复跟随（用户滚回来之后继续跟）
    if (bottom) followRef.current = true
    setShowJump(!bottom && !followRef.current)
  }, [])

  const scrollToMessage = useCallback(
    (id: string) => {
      const index = messages.findIndex((m) => m.id === id)
      if (index < 0) return
      followRef.current = false
      virtuosoRef.current?.scrollToIndex({ index, align: 'start', behavior: 'smooth' })
    },
    [messages]
  )

  useImperativeHandle(ref, () => ({ scrollToMessage }), [scrollToMessage])

  const jumpToBottom = useCallback(() => {
    followRef.current = true
    setShowJump(false)
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
  }, [])

  return (
    <>
      <Virtuoso
        key={listKey}
        ref={virtuosoRef}
        data={messages}
        className={cn('min-h-0', className)}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        followOutput={followOutput}
        atBottomStateChange={handleAtBottomChange}
        atBottomThreshold={48}
        computeItemKey={(_index, item) => item.id}
        defaultItemHeight={120}
        increaseViewportBy={{ top: 1200, bottom: 800 }}
        scrollerRef={handleScrollerRef}
        components={components}
        itemContent={(index, item) => renderItem(item, index)}
      />
      {/* 不在底部时才出现：一键回到最新内容（往上翻历史之后不用一路滚回去）。
          跟随意图仍生效期间不显示：马上就会自动贴底，按钮闪一下反而像故障 */}
      {showJump && !followRef.current && (
        <button
          type="button"
          onClick={jumpToBottom}
          title="滚动到底部"
          aria-label="滚动到底部"
          className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </>
  )
}
