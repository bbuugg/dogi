/**
 * 消息目录：消息区右缘**一列短横杠**（一条用户消息一根），展开后是一张
 * 「摘要 + 横杠」的清单，点一条滚到那一条。
 *
 * ## 为什么从「拉线时间轴」退回到一列横杠
 *
 * 上一版是整条拉线：点按**真实时间轴**排布、挨得太近的自动聚簇、簇点大小表示条数、
 * 悬停弹预览气泡、触屏长按钉住、指针沿线拖动时跟着一颗大点… 那些是这一套交互自己的
 * 产品，不是这个应用必须的东西。一条会话几十轮下来，时间轴会把点挤在中间一坨，
 * 于是又要聚簇、又要气泡、又要拖动，才点得准 —— 成本全花在「怎么把点画出来」上，
 * 而用户真正要的只有两件事：**知道这轮会话有多长**、**点一下跳过去**。
 *
 * 现在：横杠等距排、看一眼就知道有几轮；平时只占右侧一条 20px 的窄带，展开后是
 * 带摘要的卡片。位置由 CSS 决定，没有时间轴 / 聚簇 / 气泡那些计算。
 *
 * ## 展开的开关（`open`）：为什么是 JS 而不是 CSS `hover:`
 *
 * 触屏**没有 hover**，`:hover` 交给 CSS 的结果是小屏上永远只有一列横杠、摘要看不见。
 * 所以开关收进一个 state，三处输入都只改它：
 *
 * - 鼠标：`pointerenter` / `pointerleave` 展开 / 收起（判 `pointerType === 'mouse'`；
 *   触屏也会补发 enter，不判就会「一碰就开、抬手就关」）；
 * - 手指：**第一下点横杠是展开**（不是跳转），展开后再点某一条才跳过去 —— 手机上
 *   要能先看见摘要再决定点哪条；跳转后收起，别让卡片挡着正文；
 * - 键盘 / 读屏：焦点进入展开（收起态的文字是 `opacity-0`，展开才算真的被读到）。
 *
 * 另外手指展开后没有「移开」这个动作，所以点卡片外面任意位置要能收起（`pointerdown`
 * 落在卡片外）。**不再有长按钉住 / 沿线拖动**那些隐藏手势。
 *
 * ## 几个刻意的选择
 *
 * - **只在 ≥2 条用户消息时出现**：只有一轮的会话，目录没有意义，右下角留白更干净；
 * - **横杠等距，不排时间轴**：时间是隐形的。等距排列点得最准，也不会出现「挤成一坨」；
 * - **文字只在展开时露面**（透明 + 渐显，不是 `hidden`）：常驻文字会把右侧那条空白带
 *   变成一列噪音；用透明度过渡，展开动画里文字是「渐出来」的，不是突然蹦出来；
 *   ⚠️ 也**不能**用 `hidden` —— 那会让宽度动画里文字瞬间占位，卡片先跳宽再动，很难看；
 * - **展开是绝对定位的浮层**：挂在滚动容器之外，展开 / 收起不会让消息列重新排版
 *   （所以上面那些 `--rail-channel` 的让位只服务未展开时那条 20px 窄带）；
 * - **当前读到的那一轮是主色**（scroll-spy）：与消息列表滚动位置同步，不看文字也知道
 *   「我现在在第几轮」；判据与旧版一致 —— 以滚动容器**底缘**为读线，最后一条
 *   「起始位置已过线」的用户消息就是当前读到的；
 * - **仍是 `<button>`**：保留键盘 Tab + Enter，视觉简化了，无障碍入口不能跟着没。
 */
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { textOf } from '@fizz/agent-kit/shared/lib/parts'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 滚动跟随的读线内缩（px）：提问起始位置越过「容器底缘 - 这个值」就算读到了 */
const SPY_LINE_INSET = 8

/**
 * 滚动跟随用的滚动容器：从消息元素向上找第一个可滚动的祖先（`Conversation` 的视口）。
 *
 * 刻意从消息元素出发而不是从目录自己出发 —— 目录是滚动容器的**兄弟**，向上走够不到它。
 */
function findScroller(panel: HTMLElement): HTMLElement | null {
  const firstMessage = panel.querySelector('[data-message-id]')
  let node = firstMessage?.parentElement ?? null
  while (node && node !== panel) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

export function MessageOutline({
  messages,
  onJump
}: {
  messages: AgentChatMessage[]
  /** 点某一条：把那条消息滚到可视区顶部（由 ChatPanel 实现） */
  onJump: (messageId: string) => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  /** 当前读到的那一轮（scroll-spy）；没量到时为 null，此时没有任何一条高亮 */
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 卡片是否展开：鼠标移上来 / 手指第一下点横杠 / 焦点进入，都会置 true */
  const [open, setOpen] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  /**
   * 最近一次按下的指针类型。
   *
   * 只为一件事：点完某一条之后要不要收起卡片。**触屏要收**（不收就挡着刚跳过去的正文，
   * 且手指没有「移开」能关它），**鼠标不要收**（鼠标还停在横杠上，收起来会莫名其妙地
   * 缩回去，等它移开时 pointerleave 自然会关）。
   */
  const pointerKind = useRef<string>('mouse')

  const tr = useT()
  const items = useMemo(
    () =>
      messages
        .filter((message) => message.role === 'user')
        .map((message) => ({
          id: message.id,
          /** 可能为空（只发了图 / 只点了回车）：渲染时兜底，别把译好的文案冻进 memo */
          text: textOf(message)
        })),
    [messages]
  )

  /**
   * 滚动跟随（scroll-spy）。
   *
   * 依赖的是**消息 id 串**而不是 `items` 数组：流式期间 `messages` 每来一帧就是一个新数组，
   * 按数组依赖会让这个 effect 每帧重挂一次 scroll 监听（旧版按 `items` 依赖也吃这个亏）。
   * 只有「轮次增删 / 顺序变了」才需要重挂。
   */
  const idsKey = items.map((item) => item.id).join('|')
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const scroller = findScroller(panel)
    if (!scroller) return
    let raf = 0
    const update = (): void => {
      raf = 0
      const line = scroller.getBoundingClientRect().bottom - SPY_LINE_INSET
      let current: string | null = null
      // DOM 顺序 = 消息顺序：第一条越过读线的，后面必然也都越过了，直接收到最后
      for (const el of scroller.querySelectorAll<HTMLElement>('[data-message-id]')) {
        if (el.getBoundingClientRect().top > line) break
        current = el.dataset.messageId ?? current
      }
      setActiveId(current)
    }
    const onScroll = (): void => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    // 窗口 / 面板改尺寸时消息高度跟着变，读线位置也就变了 —— 不重算会高亮错一条
    const ro = new ResizeObserver(onScroll)
    ro.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [idsKey])

  /**
   * 「点别处收起」——**只服务手指**：鼠标有 pointerleave，触屏展开后没有任何「移开」动作，
   * 不点一下就永远是那张卡片挡在右边。
   *
   * 用 `pointerdown` 而不是 `click`：按下就先收，不等抬起。这里**只收卡片、不拦事件**
   * （没有 `stopPropagation` / `preventDefault`），所以那一下该点的东西照旧生效 ——
   * 用户想点的本来就是卡片下面的内容，不该被目录吃掉。
   */
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      if (!cardRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  // 只有一轮提问时不出目录：一根孤零零的横杠既不是导航也不好看
  if (items.length < 2) return null

  return (
    <div
      className="pointer-events-none absolute inset-y-0 left-0 right-0 z-10 flex items-center justify-end"
      /*
       * 右缘距离用**内联 style** 而不是任意值类（`pr-[max(...)]`）：那个值里有嵌套的逗号，
       * 交给 Tailwind 扫描生成不如直接写进 style 稳；`--rail-inset` 与滚动条那条 media
       * 查询同源（见 `tokens.css`），这里只补一个兜底。
       */
      style={{ paddingRight: 'max(var(--rail-inset, 8px), 8px)' }}
      role="navigation"
      aria-label={tr('消息目录')}
      data-outline="bars"
    >
      {/*
        展开动画：**宽度**从 20px 长到 288px，背景 / 阴影 / 内边距一起过渡。
        `max-h-full` + `overflow-y-auto`：几十轮的长会话里卡片不能顶出消息区，
        超出就让卡片自己滚（滚条照例藏掉，见 `.no-scrollbar`）。

        ⚠️ `w-5`（20px）时**不能有 padding**：内宽就 20px，padding 一进来横杠会被挤窄，
        于是「未展开」和「展开」的横杠右缘对不上，视觉上会横跳一下。
        这点跳动是**有意的取舍**：展开态要留出 `p-2` 的呼吸感，横杠贴着卡片边框反而难看。

        ⚠️ 展开**不靠 `hover:`**（触屏没有 hover）：宽度 / 背景都跟着 `open` 走，
        鼠标只是为了把 `open` 置 true 才在这里挂 enter/leave。
      */}
      <div
        ref={cardRef}
        className={cn(
          // `touch-manipulation`：去掉移动端点击的 300ms 双击缩放等待，且不拦卡片内滑动滚动
          // `gap-1.5` 服务的是**展开态**那张列表（一条摘要挨一条，太密读不动）；
          // 收起态那列横杠的松紧由行高管（见按钮上的 `h-3.5`），这里不需要为它再调
          'pointer-events-auto flex max-h-full max-w-[calc(100%-1.5rem)] touch-manipulation flex-col items-stretch gap-1.5 overflow-y-auto no-scrollbar rounded-2xl',
          'transition-[width,background-color,box-shadow,padding] duration-200 ease-out',
          open ? 'w-72 bg-popover p-2 shadow-lg ring-1 ring-border' : 'w-5'
        )}
        onPointerEnter={(event) => {
          // 触屏在按下时也会补发 enter/leave（`pointerType === 'touch'`）：不判类型就会
          // 「一碰就开、抬手就关」，手指永远看不清摘要
          if (event.pointerType === 'mouse') setOpen(true)
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') setOpen(false)
        }}
        onClick={() => {
          // 点到条与条之间那 6px 的缝也算「想展开」：20px 窄带里手指本来就不够准，
          // 点空一次还得再点一次太烦。按钮自己的 click 会冒泡到这里，此时 `open` 已是
          // 同一次渲染的旧值（false），重复置 true 是幂等的，不会把刚跳转的卡片又打开。
          if (!open) setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          // 只在焦点真的离开整块卡片时收起：条与条之间移动时 relatedTarget 还在卡片内
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
        }}
      >
        {items.map((item) => {
          const isActive = item.id === activeId
          return (
            <button
              key={item.id}
              type="button"
              onPointerDown={(event) => {
                pointerKind.current = event.pointerType
              }}
              onClick={() => {
                // 手指第一下只展开：得先看清摘要才知道要点哪条
                if (!open) {
                  setOpen(true)
                  return
                }
                onJump(item.id)
                // 触屏跳完收起，别挡着刚滚过去的那一轮；鼠标还停在横杠上，交给 pointerleave
                if (pointerKind.current === 'touch') setOpen(false)
              }}
              aria-label={item.text || tr('（这条消息没有文字）')}
              aria-current={isActive ? 'true' : undefined}
              className={cn(
                // `justify-end`：未展开时文字宽 0，横杠得靠右贴住容器右缘（否则会缩到左端）
                'flex w-full min-w-0 shrink-0 items-center justify-end rounded-md text-left',
                // 行高跟着 `open` 走（而不是两态都 `h-6`），高度也进过渡，跟宽度动画同步
                'transition-[height,color,background-color,border-color] duration-200 ease-out',
                // 展开态：24px 是给 12px 摘要文字 + 上下留白 + 点击热区留的，塞不下更矮；
                // 收起态：行内只有一根 2px 横杠，14px 就够。
                // 横杠的视觉间距 = 行高 + 容器 gap(6px) - 横杠高(2px)：
                // 两态都用 h-6 时是 28px（稀），收起收紧到 h-3.5 后是 18px。
                open ? 'h-6 px-1 hover:bg-accent' : 'h-3.5'
              )}
            >
              {/* 摘要：收起时透明（不是 `hidden`）—— 宽度动画里它得在场，靠透明度渐显 */}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-xs transition-opacity duration-150',
                  open ? 'opacity-100' : 'opacity-0',
                  isActive ? 'text-primary' : open ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {item.text || tr('（这条消息没有文字）')}
              </span>
              {/* 横杠本体：常驻，永远是这一列里唯一看得见的东西。`ml-3` 只在展开时给缝，
                  未展开时 20px 的槽位里就是这一根 16px 的横杠（贴右） */}
              <span
                className={cn(
                  'h-[2px] w-4 shrink-0 rounded-full transition-colors',
                  open && 'ml-3',
                  isActive ? 'bg-primary' : open ? 'bg-muted-foreground/60' : 'bg-muted-foreground/40'
                )}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
