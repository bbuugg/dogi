/**
 * 引用消息的两块 UI：
 * - `MessageQuoteLayer`：在消息里划选一段文字 → 浮出「引用 / 复制」两颗按钮；
 * - `QuotePreviewRow`：输入框卡片 header 里的引用片（摘录 + 来源 + 移除）。
 *
 * 引用状态与发送拼装归调用方（`ChatPanel`），这里只收 state + 回调 ——
 * 与 `attachments.tsx` 的分工一致。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Quote, X } from 'lucide-react'
import { nextQuoteId, type MessageQuote } from '@fizz/agent-kit/shared/lib/quotes'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 浮层与选区之间的间距（px）：按钮底边停在选区顶边上方这么远 */
const TOOLBAR_GAP = 8

/**
 * 浮层自身的高度估算（px）。
 *
 * 用来判断「选区上方还剩多少空间」——空间不够就把浮层翻到选区**下方**，
 * 而不是让它飘到消息区之外（那会压到标签条 / 面板 chrome 上，见下面的说明）。
 * 按 `py-1 + text-xs` 的实测高度给，宁可略大：差几像素只是判定保守一点。
 */
const TOOLBAR_HEIGHT = 30

/**
 * 选区所在的**滚动容器**（消息列表），浮层的可见边界就是它。
 *
 * 为什么不用 `window.innerHeight`：消息区在面板里，它的上缘下面是标签条、下缘上面是
 * 输入卡 —— 拿视口当边界，浮层就会飘进这些 chrome 里。而 chrome 是 `z-10`（标签条）、
 * 浮层是 body 上 `fixed z-50`，**浮层一定画在 chrome 之上**（跨了层叠上下文，比 z 值
 * 没意义）。所以边界必须取容器自己的 rect。
 *
 * 优先认 `[data-message-scroll]`（`Conversation` 显式标的锚点）；找不到才退回按
 * `overflow-y` 往上找祖先 —— 正文里的代码块也是 `overflow-auto`，那种通用找法会误判。
 */
function scrollParentOf(el: Element): Element | null {
  const explicit = el.closest('[data-message-scroll]')
  if (explicit) return explicit
  let cur = el.parentElement
  while (cur) {
    const overflowY = getComputedStyle(cur).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return cur
    cur = cur.parentElement
  }
  return null
}

/**
 * 「已复制」的回执时长（ms）。
 *
 * 与消息行尾那颗复制按钮同一个节奏（`message-parts.tsx` 的 1200ms）——同一件事在两处
 * 给不同时长的反馈，用户会以为其中一处没生效。
 */
const COPIED_MS = 1200

/**
 * 浮层里一颗按钮的排版。
 *
 * ⚠️ hover 必须用**实心**令牌 `bg-accent`（`hover:bg-foreground/10` 那种半透明是
 * 「把底色替换成 10% 的墨」——对本来没有底色的图标钮没问题，但这里底是实心
 * `bg-popover`，一 hover 就变半透明、能透出底下的正文，看着像按钮消失了）。
 *
 * ⚠️ `whitespace-nowrap` 不能省。浮层是 `fixed` + `left: 选区中心`，**没有固定宽度**
 * —— 它的可用宽度就是「left 到视口右缘」。选区靠右时那个空间小到装不下两颗按钮，
 * shrink-to-fit 于是把「引用 / 复制」压成两行。禁掉换行后它会按内容宽度排版，
 * 溢出由下面的水平夹取负责收回来（见 `left` 的计算）。
 */
const TOOLBAR_BUTTON =
  'flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground'

/**
 * 消息区划选 → 浮出「引用 / 复制」两颗按钮。
 *
 * 只**读**选区，不改选中策略：消息正文本来就可选（`.sd-md` / `pre` 在 `styles.css`
 * 的白名单里），缺的只是这两个入口。浮层挂 `body` + `position: fixed` —— 消息区是
 * 滚动容器，挂在它里面会被祖先裁剪、还会跟着滚。
 *
 * 一条选区「可用」要同时满足：
 * - 非空、非折叠（点一下产生的折叠选区不算）；
 * - 起点落在 `[data-message-id]` 里（消息之外 —— 侧栏 / 通知 / chrome —— 的选区不参与）；
 * - 不在输入框 / contenteditable 里（那是用户在自己写东西）；
 * - 有几何（`getBoundingClientRect` 全零 = 选区不可见，例如折叠起来的区域）。
 */
export function MessageQuoteLayer({ onQuote }: { onQuote: (quote: MessageQuote) => void }) {
  /** 浮层落点（选区边缘中点的视口坐标）+ 在选区上方还是下方；null = 不显示 */
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null)
  /** 「复制」按下的回执：图标就地换成勾（宽度不变，浮层不会因此横移） */
  const [copied, setCopied] = useState(false)
  /** 本次选区的正文 + 来源；与 `at` 同生共死（点按钮时读它） */
  const pendingRef = useRef<{ text: string; role: MessageQuote['role'] } | null>(null)
  /**
   * 「已复制」的回执定时器（到点才收浮层 + 清选区）。
   *
   * ⚠️ 复制**不能立刻**清选区：`removeAllRanges()` 会触发 `selectionchange`，而那个监听
   * 的第一件事就是把浮层收掉 —— 勾还没画出来就没了。所以先让勾亮 1.2 秒。
   */
  const ackTimerRef = useRef(0)
  /**
   * 浮层元素本身（量宽度用）+ 量到的宽度。
   *
   * 水平夹取要知道浮层有多宽（见 `left` 的计算）。宽度由内容决定、只在首次量到后
   * 缓存 —— 两颗按钮的文字固定（「复制」的回执只换图标、不换文字，就是为了不让它变宽），
   * 所以量一次就够，不必每帧量（每帧量会强制同步布局）。
   */
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [toolbarWidth, setToolbarWidth] = useState(0)
  /**
   * 最近一次算出的**消息区水平边界**（由 `sync` 写入，渲染时用来夹取浮层位置）。
   * 存 ref 而不是 state：它只在 `sync` 里随选区一起变，不必单独触发一次渲染。
   */
  /**
   * 本次选区是否已经量过宽度。
   *
   * ⚠️ 用「每次选区量一次」而不是「每帧量」：`at` 在滚动 / 流式输出时每帧都在变，
   * 若把测量挂在它上面，每帧都会读一次 `offsetWidth` —— 那是**强制同步布局**，
   * 长会话里就是滚动卡顿的来源。宽度只由那两颗按钮的文字决定（「复制」的回执
   * 刻意只换图标不换文字，正是为了不让它变宽），量一次足够。
   */
  const measuredRef = useRef(false)
  const boundsRef = useRef<{ left: number; right: number } | null>(null)

  useLayoutEffect(() => {
    if (!at || measuredRef.current) return
    const width = layerRef.current?.offsetWidth ?? 0
    if (width > 0) {
      measuredRef.current = true
      setToolbarWidth(width)
    }
  }, [at])

  useEffect(() => {
    const hide = (): void => {
      window.clearTimeout(ackTimerRef.current)
      ackTimerRef.current = 0
      setCopied(false)
      pendingRef.current = null
      // 下一次选区要重新量宽度（按钮文字理论上不变，但别把「量过」当成永久事实）
      measuredRef.current = false
      setAt(null)
    }
    const sync = (): void => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hide()
      const text = sel.toString().trim()
      if (!text) return hide()
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
      if (!el || el.closest('input, textarea, [contenteditable="true"]')) return hide()
      const messageEl = el.closest('[data-message-id]')
      if (!messageEl) return hide()
      const rect = range.getBoundingClientRect()
      if (!rect.width && !rect.height) return hide()
      // 选区已经被滚出视口：收掉（位置重算得再准也没意义）
      if (rect.bottom < 0 || rect.top > window.innerHeight) return hide()
      pendingRef.current = {
        text,
        role: messageEl.getAttribute('data-role') === 'user' ? 'user' : 'assistant'
      }
      /**
       * 浮层必须待在**消息区**里（见 `scrollParentOf`）：上方放不下就翻到选区下面。
       * 不这么判的话，选区滚到顶部时浮层会飘进标签条 —— 而它是 body 上的 `fixed`
       * 浮层，一定画在 chrome 之上，看起来就是「浮层压住了标签页」。
       */
      const container = scrollParentOf(messageEl)
      const bounds = container?.getBoundingClientRect()
      boundsRef.current = bounds ? { left: bounds.left, right: bounds.right } : null
      const topLimit = bounds ? bounds.top : 0
      const bottomLimit = bounds ? bounds.bottom : window.innerHeight
      const above = rect.top - TOOLBAR_GAP - TOOLBAR_HEIGHT >= topLimit
      // 上面放不下、下面也放不下（选区几乎占满可视区）：这时没有合法位置，收掉
      if (!above && rect.bottom + TOOLBAR_GAP + TOOLBAR_HEIGHT > bottomLimit) return hide()
      const next = {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(above ? rect.top - TOOLBAR_GAP : rect.bottom + TOOLBAR_GAP),
        below: !above
      }
      // 位置没变就不 setState：流式输出时每帧都会重算一次，白重渲染没有意义
      setAt((prev) =>
        prev && prev.x === next.x && prev.y === next.y && prev.below === next.below ? prev : next
      )
    }
    /**
     * `selectionchange` 在拖选过程中会连发多次，每次都量几何就是布局抖动 ——
     * 一帧合并一次（同一帧里调度多次只跑最后一次）。
     */
    let queued = 0
    const schedule = (): void => {
      if (queued) return
      queued = requestAnimationFrame(() => {
        queued = 0
        sync()
      })
    }
    /**
     * 点「任何地方」都能取消选中 —— 包括消息区之外（侧栏、标签条、输入框、空白处）。
     *
     * 浏览器的默认行为只在**可选中的文字**上清选区：点在 `user-select: none` 的界面元素
     * （外壳、按钮、标签条）上时选区会保留，于是浮层一直挂着，用户只能回到消息里点一下
     * 才能收掉。
     *
     * 判据只有两条：
     * - 点在浮层自己身上 → 交给按钮的 onClick（它们的 `pointerdown` 已 preventDefault）；
     * - 其余**任何位置**（消息正文、侧栏、标签条、输入框、空白处）→ 清选区并收掉浮层。
     *
     * 消息正文**不排除**：清掉旧选区正是浏览器的默认行为（重新拖选会立刻建一个新的），
     * 而消息里那些 `user-select: none` 的按钮 / 卡片头不会清 —— 那正是「点了没收掉」的来源。
     * 唯一让路的是 `shift + 点`（扩选），那是浏览器的活。
     *
     * 用 `mousedown` 而不是 `pointerdown`：移动端滚动列表时 `pointerdown` 先到，
     * 边滚边清会把「选一段正在输出的内容再滚着看」这条路堵死；`mousedown` 只在
     * 真正的按下（点击）时来，滚动不会触发。
     */
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0 || event.shiftKey) return
      const target = event.target as Element | null
      if (target?.closest('[data-quote-layer]')) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) return
      sel.removeAllRanges()
      hide()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('selectionchange', schedule)
    /**
     * 滚动 / 改窗口大小：**重算位置，而不是藏起来**。流式输出期间消息区一直在自动滚，
     * 一滚就藏的话「引用正在输出的那一段」根本点不着 —— 选区内容没变，变的只是位置。
     * （真滚出视口了，`sync` 里那道视口判断会收掉。）
     */
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      if (queued) cancelAnimationFrame(queued)
      window.clearTimeout(ackTimerRef.current)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('selectionchange', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [])

  /** 收浮层 + 清选区（两颗按钮的收尾动作只有这一份） */
  const dismiss = (): void => {
    window.getSelection()?.removeAllRanges()
    pendingRef.current = null
    measuredRef.current = false
    setAt(null)
  }

  const quote = (): void => {
    const pending = pendingRef.current
    // 先收浮层、清选区（内容已经拿到手，高亮留着只碍眼），再交给调用方
    dismiss()
    if (pending) onQuote({ id: nextQuoteId(), ...pending })
  }

  const copy = (): void => {
    const pending = pendingRef.current
    if (!pending) return
    void navigator.clipboard.writeText(pending.text).then(() => {
      setCopied(true)
      ackTimerRef.current = window.setTimeout(() => {
        ackTimerRef.current = 0
        // 回执期间用户可能已经划到别处了：那就别动他现在的选区，只收掉勾
        setCopied(false)
        if (pendingRef.current?.text === pending.text) dismiss()
      }, COPIED_MS)
    })
  }

  if (!at) return null
  /**
   * 水平位置：选区中点居中，再**夹进消息区**。
   *
   * 不夹的话，选区靠右时浮层会有一半探出容器（它是 `-translate-x-1/2` 居中的），
   * 探出去那截要么压到右侧面板、要么被视口裁掉。夹取用「容器左右边界 ± 半宽」，
   * 容器比浮层还窄（极窄的面板）时退化成居中 —— 那时没有合法位置，居中最好看。
   */
  const bounds = boundsRef.current
  const half = toolbarWidth / 2
  let left = at.x
  if (bounds && toolbarWidth > 0) {
    left =
      bounds.left + half > bounds.right - half
        ? Math.round((bounds.left + bounds.right) / 2)
        : Math.round(Math.min(Math.max(at.x, bounds.left + half), bounds.right - half))
  }
  return createPortal(
    <div
      ref={layerRef}
      data-quote-layer
      // `-translate-y-full` 只在浮层位于选区**上方**时用（下方时它本来就该往下长）
      className={cn(
        'fixed z-50 -translate-x-1/2',
        at.below ? 'translate-y-0' : '-translate-y-full'
      )}
      style={{ left, top: at.y }}
    >
      {/*
        两颗按钮共用一层外壳（描边 + 实心底 + 阴影），中间一条发丝线隔开 ——
        两个独立的胶囊并排会显得是两个浮层，而且中间那道缝里会漏出底下的正文。
      */}
      <div className="flex items-stretch overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
        <button
          type="button"
          /**
           * ⚠️ `pointerdown` 必须 `preventDefault`：不拦的话浏览器会先把选区清掉，
           * 等 onClick 里再读 `getSelection()` 就是空的 —— 引用内容当场丢掉。
           * 「复制」那颗同理（它读的是同一个 `pendingRef`）。
           */
          onPointerDown={(e) => e.preventDefault()}
          onClick={quote}
          className={TOOLBAR_BUTTON}
        >
          <Quote className="size-3.5" />
          引用
        </button>
        <span className="w-px shrink-0 bg-border" />
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={copy}
          // ⚠️ 文案**不换**（只换图标）：换了文字浮层会变宽，而它是 `-translate-x-1/2`
          // 居中的，一宽就整体横移几像素 —— 一个飘在选区上方的小浮层原地跳一下很显眼
          title={copied ? '已复制' : '复制选中的文字'}
          aria-label={copied ? '已复制' : '复制选中的文字'}
          className={TOOLBAR_BUTTON}
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-500" />
          ) : (
            <Copy className="size-3.5" />
          )}
          复制
        </button>
      </div>
    </div>,
    document.body
  )
}

/**
 * 待发送引用片：与**附件预览行**同一套 chip 排布（`flex flex-wrap gap-2` + 细边小卡），
 * 渲染在输入卡片 header 槽里、附件行之上。
 *
 * 早先是「整条 `bg-muted/40` + 左侧图标 + 小标题 + 两行正文」的状态条（与
 * `EditMessageBar` / `SteerEditBar` 同款）。用户要求改成**像附件那样的小片**：
 * 引用是「随消息一起发出去的内容」，不是「正在改哪条历史」那种模式提示 ——
 * 一条横幅压在卡片顶上，既占高度又容易被当成输入框之外的另一个控件。
 * 小片一行摘录、多个引用横向换行排开，与附件缩略图在同一个视觉层级上。
 *
 * 摘录只截一行（全文在 `title` 里；**发送的是完整原文**，与这里的截断无关），
 * 所以「引用你的消息 / 引用助手消息」这个区分也挪进 `title`，不再占一行字。
 */
export function QuotePreviewRow({
  quotes,
  onRemove
}: {
  quotes: MessageQuote[]
  onRemove: (id: string) => void
}) {
  if (quotes.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-3 py-2">
      {quotes.map((q) => (
        <div
          key={q.id}
          className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-lg border border-border bg-muted/40 py-1 pl-2 pr-1"
        >
          <Quote className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={`${q.role === 'user' ? '引用你的消息' : '引用助手消息'}：${q.text}`}
          >
            {q.text}
          </span>
          <button
            type="button"
            aria-label="移除引用"
            title="移除引用"
            onClick={() => onRemove(q.id)}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
