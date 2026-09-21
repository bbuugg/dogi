import { ChevronDown } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { cn } from 'cn'
import { useAppStore } from '@/stores/app-store'

/**
 * 可折叠纵向分区（侧边栏内通用布局）。
 *
 * 把一列侧边栏纵向切成若干段，每段独立展开/收起。空间分配规则：
 * - **收起**的分区只剩标题栏（不参与弹性分配），它下方的分区自动上移补位；
 * - **展开**的分区按 `grow` 权重瓜分剩余空间，但永远不会小于 `minHeight` ——
 *   空间不够时先吃掉弹性部分，最小高度始终保留，任何分区都不会被挤出可视区；
 * - 分区声明了 `resizableAbove` 时，顶部会多出一条横向拖拽条，可自由拖动改高度；
 * - 极端情况下（窗口很矮、所有分区的最小高度之和超过侧边栏）由容器整体滚动兜底。
 *
 * 折叠状态存在 store（`ui.collapsedSections`），拖出来的高度存在 `ui.sectionHeights`
 * （key 见 section-ids.ts），因此切换功能区、组件重挂载都不会丢；
 * 同一分区 id 在多处引用时状态天然一致。
 *
 * 用法（每个分区三段式，顺序固定）：
 * ```tsx
 * <StackedSections>
 *   <SectionShell id={FOO_SECTION_ID} grow={2} minHeight={200}>
 *     <SectionHeader id={FOO_SECTION_ID} title="主机" count={n} extra={<Button …/>} />
 *     <SectionContent id={FOO_SECTION_ID}>…列表…</SectionContent>
 *   </SectionShell>
 *   <SectionShell id={BAR_SECTION_ID} resizableAbove={FOO_SECTION_ID}>…</SectionShell>
 * </StackedSections>
 * ```
 */
export function StackedSections({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-y-auto', className)}>{children}</div>
  )
}

/**
 * 分区外壳：负责弹性尺寸与最小高度约束。
 *
 * 注意「收起」时只设 `shrink-0`（高度由标题栏决定）而**不加** flex 简写，
 * 这样它才不会被同容器的展开项压缩。
 */
export function SectionShell({
  id,
  grow = 1,
  minHeight = 160,
  resizableAbove,
  className,
  children
}: {
  /** 分区 id（见 section-ids.ts），决定自己的折叠状态 */
  id: string
  /** 展开时参与瓜分剩余空间的权重（同一容器内相对值），默认 1 */
  grow?: number
  /** 展开时的最小高度（px），空间被挤压时也不会小于它，默认 160 */
  minHeight?: number
  /**
   * 上方相邻分区的 id：声明后，本分区顶部出现一条横向拖拽条，
   * 拖动即可自由调整本分区高度（高度存 ui.sectionHeights）。
   *
   * 拖拽条只在「本分区与上方分区都展开」时存在：上方收起时本分区会吃掉
   * 空出来的空间，此时高度由布局决定，拖动没有意义也没有视觉效果。
   */
  resizableAbove?: string
  className?: string
  children: ReactNode
}) {
  const collapsed = useAppStore((s) => Boolean(s.ui.collapsedSections[id]))
  const aboveCollapsed = useAppStore((s) =>
    resizableAbove ? Boolean(s.ui.collapsedSections[resizableAbove]) : true
  )
  /** 用户拖过的高度（无值 = 还没拖过，按 flex 权重自动分配） */
  const height = useAppStore((s) => s.ui.sectionHeights[id])
  const resizable = Boolean(resizableAbove) && !aboveCollapsed && !collapsed
  const fixed = resizable && height !== undefined

  return (
    <section
      className={cn(
        'relative flex min-h-0 flex-col border-b border-border/60 last:border-b-0',
        collapsed && 'shrink-0',
        className
      )}
      style={
        collapsed
          ? undefined
          : fixed
            ? // 拖过之后高度固定，剩余空间全部让给上方分区
              { flex: `0 0 ${height}px`, minHeight }
            : { flex: `${grow} 1 0`, minHeight }
      }
    >
      {resizable && <SectionResizer belowId={id} minHeight={minHeight} />}
      {children}
    </section>
  )
}

/**
 * 分区之间的横向拖拽条：向上拖本分区变高、向下拖变矮。
 *
 * 用绝对定位压在两个分区的边界线上（不占布局高度），所以它自身的高度
 * 不会参与 SectionShell 的 flex 计算 —— 拖出来的高度就是分区真实高度。
 */
function SectionResizer({ belowId, minHeight }: { belowId: string; minHeight: number }) {
  const setSectionHeight = useAppStore((s) => s.setSectionHeight)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const section = e.currentTarget.parentElement
    const above = section?.previousElementSibling as HTMLElement | null
    const container = section?.parentElement
    if (!section || !container) return

    const startY = e.clientY
    const startHeight = section.getBoundingClientRect().height
    /**
     * 上方分区至少要留住它自己的 minHeight —— 该值由 SectionShell 写成内联样式，
     * 直接读它比再往调用方要一次参数更省事，也保证与布局用的是同一份数字。
     */
    const aboveMinHeight = Number.parseFloat(above?.style.minHeight ?? '') || 0
    const maxHeight = container.clientHeight - aboveMinHeight

    const move = (ev: PointerEvent) => {
      // 向上拖（clientY 变小）= 本分区变高
      const next = startHeight + (startY - ev.clientY)
      setSectionHeight(belowId, Math.max(minHeight, Math.min(maxHeight, next)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      onPointerDown={onPointerDown}
      title="拖动调整高度"
      className="group/resize absolute inset-x-0 top-0 z-20 h-2 -translate-y-1/2 cursor-row-resize"
    >
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover/resize:bg-primary" />
    </div>
  )
}

/**
 * 分区标题栏：整条可点击折叠/展开，右侧 `extra` 放新建等操作按钮。
 * 折叠态用 Chevron 旋转 + 无障碍 `aria-expanded` 表达。
 */
export function SectionHeader({
  id,
  title,
  count,
  extra,
  className
}: {
  id: string
  title: string
  /** 标题后的数量（不传则不显示括号） */
  count?: number
  /** 标题栏右侧操作区（按钮等） */
  extra?: ReactNode
  className?: string
}) {
  const collapsed = useAppStore((s) => Boolean(s.ui.collapsedSections[id]))
  const setSectionCollapsed = useAppStore((s) => s.setSectionCollapsed)
  return (
    <div className={cn('mb-1 flex h-9 shrink-0 items-center gap-1 px-2', className)}>
      <button
        type="button"
        aria-expanded={!collapsed}
        title={collapsed ? `展开「${title}」` : `收起「${title}」`}
        onClick={() => setSectionCollapsed(id, !collapsed)}
        className="flex min-w-0 flex-1 items-center gap-1 rounded px-1.5 py-1 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            collapsed && '-rotate-90'
          )}
        />
        <span className="truncate">{title}</span>
        {count !== undefined && <span className="shrink-0 tabular-nums">({count})</span>}
      </button>
      {extra && <div className="flex shrink-0 items-center gap-0.5">{extra}</div>}
    </div>
  )
}

/**
 * 分区内容。
 *
 * 收起时只是 `display:none`（**不卸载**）：面板里的搜索词、分组展开等
 * 本地 state 在收起 / 展开之间要保持，卸载会导致下次展开被重置。
 * 内容自身负责滚动（`min-h-0 flex-1 overflow-y-auto`）。
 */
export function SectionContent({
  id,
  className,
  children
}: {
  id: string
  className?: string
  children: ReactNode
}) {
  const collapsed = useAppStore((s) => Boolean(s.ui.collapsedSections[id]))
  return (
    <div
      className={cn('min-h-0 flex-1 flex-col', collapsed ? 'hidden' : 'flex', className)}
      aria-hidden={collapsed}
    >
      {children}
    </div>
  )
}
