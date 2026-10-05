import { cn } from 'cn'
import { ChevronRight } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useConversationOptional } from './Conversation'

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

/**
 * 展开体内容外层的统一样式（左边一条竖线 + 小字）。
 * 吸底版与不吸底版共用一份 —— 两版只有滚动行为不同，别让样式各写一遍。
 */
const BODY_INNER_CLASS = cn(
  'my-1 ml-2.5 border-l border-border py-1 pl-2.5 pr-1',
  'text-[13px] leading-relaxed text-muted-foreground'
)

/**
 * 「贴底跟随」版展开体（`stickToBottom` 为真**且行已展开**时才挂，见 `CollapsibleRow` 的分支）。
 *
 * 与消息区（Conversation）用**同一个** `use-stick-to-bottom`：库内部用 spring 动画
 * 平滑跟随内容增长，这就是「内容向上流动」顺滑观感的来源；它还顺带接管了
 * 「用户上滚就暂停跟随、滚回底部自动恢复」，不用自己算 scrollHeight 差值。
 *
 * ⚠️ 别改回 `scrollTop = scrollHeight` 那种瞬时赋值：流式每来一个 token 就跳一帧，
 * 展开的思考过程看着是一格一格地蹦。
 *
 * ⚠️ **必须在 `open` 为真时才挂载**（父组件按 `stickToBottom && open` 二选一渲染，
 * 别改回「吸底就一直挂」）。这不是省性能，是**正确性**：收起态下 grid 轨道是 `0fr`，
 * 滚动容器的 `clientHeight` 为 0。挂载那一刻若先落底，`scrollTop` 会被设成
 * `scrollHeight - 1 - 0`（0 高度容器上的极大值）；紧接着展开过渡让 `clientHeight`
 * 从 0 涨到实际高度，浏览器把 `scrollTop` 夹回合法范围并发出一次 scroll 事件。
 *
 * 库**只观察 `contentRef`（内容盒），不观察 `scrollRef`（滚动容器）**，所以容器高度
 * 变化对它不可见 —— 那次夹紧在它看来就是「用户往上滚了」：
 * `handleScroll` 判定 `isScrollingUp` → `escapedFromLock = true` + `isAtBottom = false`
 * （`useStickToBottom.js:271`）。而 `isAtBottom` 一旦为假，后续每次内容变长触发的
 * `scrollToBottom` 都会在 `next()` 第一行 `if (!state.isAtBottom) return false` 直接返回
 * （`:153`），吸底彻底停摆 —— 表现就是「自动滚动要用户先手动拖到底部才恢复」。
 *
 * 只在展开时挂载就没有这个窗口：新挂载的 grid 元素直接以 `1fr` 起步，CSS 过渡
 * 不在首次样式计算时运行，容器一上来就有真实高度，落底即正确。
 * 附带好处：收起中的行不再持有 ResizeObserver 与 scroll / wheel 监听器。
 */
function StickyBody({ bodyClassName, children }: { bodyClassName?: string; children: ReactNode }) {
  const { scrollRef, contentRef, scrollToBottom } = useStickToBottom({ initial: false })
  useEffect(() => {
    void scrollToBottom({ animation: 'instant' })
  }, [scrollToBottom])
  return (
    <div className="grid grid-rows-[1fr]">
      {/*
        滚动容器：`scrollbar-gutter: stable` 预留滚动条槽位。
        不预留的话，展开的长内容一旦超过 max-h-64，滚动条出现 → 内容盒宽度少 8px →
        整段文字重新折行、看着像「往左跳了一下」（长思考 / 长工具输出都踩得到）。
      */}
      <div
        ref={scrollRef}
        className="min-h-0 max-h-64 overflow-y-auto [scrollbar-gutter:stable] mt-4 no-scrollbar"
        // 与消息区同一个理由：关掉 Chromium 的滚动锚定，滚动位置由库显式管理
        style={{ overflowAnchor: 'none' }}
      >
        <div ref={contentRef} className={cn(BODY_INNER_CLASS, bodyClassName)}>
          {children}
        </div>
      </div>
    </div>
  )
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
   * 用户手动开合：先让消息区**退出自动贴底**（`holdScroll`），内容才会在原地下方长出来。
   * 不退出的话，展开这一下让消息区内容变高、贴底逻辑把视图拽到底部 ——
   * 用户点的那张卡被顶上去，看起来像「点展开、页面往上滚」。
   * （fishwork 的 `PartView` 里每个折叠块都这么做，见 `useConversationOptional` 的注释。）
   */
  const conversation = useConversationOptional()

  const toggle = () => {
    conversation?.holdScroll()
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
      {/*
        折叠用 grid-template-rows 0fr/1fr；展开体（grid item）必须 min-h-0 +
        overflow 非 visible，否则它的 auto 最小尺寸会把 0fr 轨道顶开、收起时照样露出来。

        三种展开体分支：
        - **吸底且已展开** → `StickyBody`（带 hook，跟随内容增长）；
        - **其余**（不吸底 / 吸底但收着）→ 下面那两个纯 DOM 分支。

        ⚠️ 吸底版刻意带 `&& open`：收起态挂载会让滚动容器以 0 高度存在，展开过渡
        夹紧 `scrollTop` 造成的 scroll 事件被库当成「用户上滚」，吸底会永久停摆
        （详见 `StickyBody` 的注释）。代价只是收起期间没有跟着滚 —— 那时用户也看不见。

        之所以拆成多个分支而不是给同一个组件传 `stickToBottom ? ref : undefined`：
        hook 不能条件调用，而每条会话里几十个工具 / 思考横条各自建一个
        use-stick-to-bottom 实例，等于几十个 ResizeObserver + 一整套 scroll / wheel
        监听器（每次滚动都读 scrollHeight）。用分支把「不需要吸底的行」彻底排除在
        这份开销之外。
      */}
      {canExpand &&
        (stickToBottom && open ? (
          <StickyBody bodyClassName={bodyClassName}>{body}</StickyBody>
        ) : (
          <div
            className={cn(
              'grid transition-[grid-template-rows] duration-200 ease-out',
              open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            )}
          >
            <div
              className={cn(
                'min-h-0',
                open
                  ? 'max-h-64 overflow-y-auto [scrollbar-gutter:stable] mt-4'
                  : 'overflow-hidden'
              )}
              // 与消息区同一个理由：关掉 Chromium 的滚动锚定
              style={{ overflowAnchor: 'none' }}
            >
              <div className={BODY_INNER_CLASS}>{body}</div>
            </div>
          </div>
        ))}
    </div>
  )
}
