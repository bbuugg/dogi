import { cn } from 'cn'
import { ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'

/**
 * 扁平行外壳（参考 ainav/sdk 的 CollapsibleRow，样式全部用 Tailwind 重写）。
 *
 * 一行：[图标] [内容（标签/状态/流式预览，由调用方传入）] [›箭头]，整行可点击展开，
 * 展开体走 grid-template-rows 0fr → 1fr 的过渡动画。**没有卡片边框/底色** ——
 * 思考过程与工具调用都是「一条横条」，不是一个个方块，视觉上贴着对话流。
 *
 * open 支持受控（传 open + onOpenChange）或非受控（内部自持）。
 * stickToBottom：展开体内容更新时自动吸底（流式输出场景），用 `use-stick-to-bottom`
 * 的 spring 动画跟随（与消息区 Conversation 同一套，见下方实现）。
 */
export interface CollapsibleRowProps {
  /** 行首图标（调用方给尺寸与配色，按对齐契约一律 `size-4`） */
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

  /**
   * 展开体的「贴底跟随」与消息区（Conversation）用**同一个** `use-stick-to-bottom`：
   * 库内部用 spring 动画平滑跟随内容增长，这就是「内容向上流动」顺滑观感的来源。
   *
   * ⚠️ 别改回 `bodyRef.current.scrollTop = scrollHeight` 那种瞬时赋值：流式每来一个 token
   * 就跳一帧，展开的思考过程看着是一格一格地蹦。库还顺带接管了「用户上滚就暂停跟随、
   * 滚回底部自动恢复」，不用自己算 scrollHeight 差值。
   *
   * 只在 `stickToBottom` 时挂 ref：工具行这类「展开后内容不再变」的块不需要自动吸底，
   * 挂了反而会在打开时平白把用户拽到底部。
   */
  const { scrollRef, contentRef } = useStickToBottom({ initial: 'instant' })
  const setScrollRef = stickToBottom ? scrollRef : undefined
  const setContentRef = stickToBottom ? contentRef : undefined

  const toggle = () => {
    if (openProp === undefined) setOpenState((v) => !v)
    onOpenChange?.(!open)
  }

  return (
    <div className={cn('group/row min-w-0 max-w-full', className)}>
      {/* 横条按内容宽度收（w-fit）而不是占满整宽，但 max-w-full 封顶：
          内容太长时由内部的 truncate 段落吃掉溢出，不会撑破消息区。

          ⚠️ 对齐契约：行内所有项（首图标 / 文字 / 状态图标 / 展开箭头）都靠这里的
          `items-center` **上下居中**，且图标一律 `size-4`（lucide 描边粗细 = 2 × 尺寸/24，
          尺寸不齐就会看着一个粗一个细、不在一个视觉尺寸上 —— 状态图标曾是 size-3.5，
          与两边的 size-4 摆一行时明显不在一个视觉尺寸上）。改样式时别把某个图标改小，
          也别加 `self-start` / 魔法 `translate-y` 去补：**先量**（各项
          `getBoundingClientRect().y + height / 2` 必须完全相等，见
          `scripts/verify-agent-queue.mjs` 的对齐断言）再决定要不要动。

          `ml-auto` 在 `w-fit` 下是空操作（没有富余空间），留着只为将来横条改成占满整宽时
          箭头能被推到最右端；别当成「箭头本来就贴右边」的依据去删。 */}
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
          {/*
            open 时是滚动容器：`scrollbar-gutter: stable` 预留滚动条槽位。
            不预留的话，展开的长内容一旦超过 max-h-64，滚动条出现 → 内容盒宽度少 8px →
            整段文字重新折行、看着像「往左跳了一下」（长思考 / 长工具输出都踩得到）。
          */}
          <div
            ref={setScrollRef}
            className={cn(
              'min-h-0',
              open ? 'max-h-64 overflow-y-auto [scrollbar-gutter:stable] mt-4' : 'overflow-hidden'
            )}
            // 与消息区同一个理由：关掉 Chromium 的滚动锚定，滚动位置由库显式管理
            style={stickToBottom ? { overflowAnchor: 'none' } : undefined}
          >
            <div
              ref={setContentRef}
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
