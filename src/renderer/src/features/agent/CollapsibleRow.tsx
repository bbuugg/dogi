import { cn } from 'cn'
import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 扁平行外壳（参考 ainav/sdk 的 CollapsibleRow，样式全部用 Tailwind 重写）。
 *
 * 一行：[图标] [内容（标签/状态/流式预览，由调用方传入）] [›箭头]，整行可点击展开，
 * 展开体走 grid-template-rows 0fr → 1fr 的过渡动画。**没有卡片边框/底色** ——
 * 思考过程与工具调用都是「一条横条」，不是一个个方块，视觉上贴着对话流。
 *
 * open 支持受控（传 open + onOpenChange）或非受控（内部自持）。
 * stickToBottom：展开体内容更新时自动吸底（流式输出场景）。
 */
export interface CollapsibleRowProps {
  /** 行首图标（调用方给尺寸与配色，如 size-3.5） */
  icon: ReactNode
  /** 图标与箭头之间的行内容 */
  children: ReactNode
  /** 展开体；undefined 时不可展开（行也不可点） */
  body?: ReactNode
  /** 展开体内层附加类（如 flex flex-col gap-2） */
  bodyClassName?: string
  /** 是否可点击展开，默认 = body 是否存在 */
  expandable?: boolean
  /** 是否显示右侧箭头，默认跟随 expandable（流式期间可传 false） */
  showChevron?: boolean
  /** 受控展开态；不传则内部自持 */
  open?: boolean
  /** 非受控时的初始展开态 */
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** 展开体内容更新时自动吸底（用户上滚则暂停跟随） */
  stickToBottom?: boolean
  className?: string
}

export function CollapsibleRow({
  icon,
  children,
  body,
  bodyClassName,
  expandable,
  showChevron,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  stickToBottom = false,
  className
}: CollapsibleRowProps) {
  const [openState, setOpenState] = useState(defaultOpen)
  const open = openProp ?? openState
  const canExpand = expandable ?? body !== undefined
  const showChevronResolved = showChevron ?? canExpand

  const bodyRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const onBodyScroll = () => {
    const el = bodyRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
  }

  // 展开体内容更新时吸底。body 每次渲染都是新引用，正好当作「内容已变化」的信号，
  // 重复执行只是幂等的 scrollTop 赋值。
  useEffect(() => {
    if (stickToBottom && open && bodyRef.current && stick.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [body, open, stickToBottom])

  const toggle = () => {
    if (openProp === undefined) setOpenState((v) => !v)
    onOpenChange?.(!open)
  }

  return (
    <div className={cn('group/row min-w-0 max-w-full', className)}>
      {/* 横条按内容宽度收（w-fit）而不是占满整宽，但 max-w-full 封顶：
          内容太长时由内部的 truncate 段落吃掉溢出，不会撑破消息区 */}
      <span
        onClick={canExpand ? toggle : undefined}
        className={cn(
          'flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded text-left text-sm',
          'text-muted-foreground transition-colors',
          canExpand ? 'cursor-pointer hover:text-foreground' : 'cursor-default'
        )}
      >
        {icon}
        {children}
        {canExpand && showChevronResolved && (
          <ChevronRight
            className={cn(
              'ml-auto size-4 shrink-0 opacity-40 transition-transform duration-200',
              open && 'rotate-90'
            )}
          />
        )}
      </span>
      {/* 折叠用 grid-template-rows 0fr/1fr；展开体（grid item）必须 min-h-0 +
          overflow 非 visible，否则它的 auto 最小尺寸会把 0fr 轨道顶开、收起时照样露出来 */}
      {canExpand && (
        <div
          className={cn(
            'grid transition-[grid-template-rows] duration-200 ease-out',
            open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          )}
        >
          <div
            ref={bodyRef}
            onScroll={stickToBottom ? onBodyScroll : undefined}
            className={cn('min-h-0', open ? 'max-h-64 overflow-y-auto' : 'overflow-hidden')}
          >
            <div
              className={cn(
                'my-1 ml-2.5 border-l border-border py-1 pl-2.5 pr-1',
                'text-[13px] leading-relaxed text-muted-foreground',
                bodyClassName
              )}
            >
              {body}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
