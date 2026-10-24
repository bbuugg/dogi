/**
 * 消息目录：把整段会话画成一条「拉线」—— 消息区右侧的一条竖线 + 线上的一串点
 * （宽屏落在右侧空白带里，窄屏贴面板右缘，见文末「几个刻意的选择」）。
 * 一条用户消息 = 线上的一个点，点位置按**真实时间轴**排布：
 *
 *   frac = (createdAt - t0) / (t1 - t0)     // t0 / t1 = 首 / 末条用户消息的时间戳
 *
 * 于是「问得密的地方点就挤在一起、隔得久的地方拉得开」。整段会话时间戳全一样
 * （span === 0，几乎只可能出现在测试数据里）时退化成按序号均匀分布。
 *
 * ## 聚簇：一段时间里的连问
 *
 * 真实时间轴有个副作用：赶进度时连着问五句，这五个点会叠成一小坨，谁也点不准。
 * 所以按**像素距离**（不是比例 —— 同样的比例在不同高度的窗口里差很远）把挨得太近
 * 的点并成一个「簇点」：点更大，而且**大小本身就是这段时间里的提问条数**（面积正比、
 * 有上下限，见 `clusterDotSize`），簇内顺序仍然是消息顺序。
 *
 * 指向簇点时预览气泡变成一份**清单**：列出这段时间里的每一条提问，点哪一条就滚到
 * 那一条（`onJump`），并把它高亮 —— 所以「刚才那一串问的是啥」不用往回翻。
 * 单条提问的簇点行为与从前完全一致（点一下直接跳过去）。
 *
 * 气泡里每条提问都带**发送时间**（今天只写时分，跨天补日期）：点是按真实时间轴排的，
 * 「这一簇挤在一起」是 5 分钟里连问还是隔了一整天，全靠这个时间才分得出来。
 *
 * ## 交互（桌面与手机同一套）
 *
 * 指针在线上移动即生效 —— 桌面悬停（无需按住）、手机按住拖动都一样：
 * 指针 Y 处始终跟着一颗**大点**（大小 = 命中点的放大态），桌面悬停就出现、手机按下出现、
 * 触屏抬起即消失（鼠标 / 笔抬起后仍悬在线上则保留，移出线才收）；
 * **拉柄与激活解耦**：悬停在拉的任意位置拉柄都在，只有指针落进某个点的
 * `HIT_RADIUS` 内才把它「激活」——
 * 点放大、左侧弹出带箭头的预览气泡、同时平滑滚到那条消息。指针移开 / 抬起即清除激活。
 * 因为触屏没有 hover，这里**不用 Tooltip**（Radix 的气泡在触屏上弹不出来），
 * 预览气泡是一张自己定位的浮层，随激活点走，尾巴始终指向激活点。
 *
 * ## 手机上按 popover 来：松手不关
 *
 * 触屏抬起后气泡曾经只剩 `CLEAR_DELAY`（180ms）的宽限 —— 手机上根本来不及点清单里的
 * 某一条，等于多提问的气泡在手机上不可用。所以抬起时**指腹落在某个点上**，气泡就**钉住**
 * （`pinned`）：不再跟着指针自动收起，变成一张真正的 popover —— 点它自己 / 线以外的任何
 * 地方、或按 ESC 才关，右上角另有一个 ✕ 兜底（手机上「点外面」没有可见的把手）。
 * 落在线段空白处抬手（压根没选中任何点）仍旧按原样收掉，不留一张空卡片。
 *
 * 钉住只对**触屏**生效，桌面仍是「悬停出、移走收」，手感和从前一模一样。三个细节：
 *
 * - **`scheduleClear` 必须读 `pinnedRef` 而不是 state**：它是个稳定引用（useCallback 只依赖
 *   `cancelScheduledClear`），而触屏抬起后浏览器**还会补一个 pointerleave**（手指离开元素）——
 *   按 state 读会拿到旧值，钉住当场就被收掉，等于没做；
 * - **点外面认的是「点一下」不是「按下去」**：手指落在外面之后拖动（滚消息列表）不算点。
 *   气泡是钉在拉线上的、不随消息滚，一滚动就收等于逼着用户每读一段重新点开；
 * - 卡片仍然**留在拉线的 DOM 子树里**（不 Portal），拖动时事件路径不变，尾巴/夹取逻辑照旧。
 *
 * ## 滚动跟随（scroll-spy）
 *
 * 消息列表滚到哪，线上对应的点就放大（与悬停激活同一套视觉）：
 * 以滚动容器**底缘**为读线，最后一条「起始位置已过线」的用户提问就是当前读到的；
 * 停在底部时点亮最后一个点、往上翻早期消息时逐个前移 —— 语义是「你现在读到的
 * 是第几轮提问之后的回答」。指针悬在线上时滚动高亮**让位**（同一视觉通道，
 * 一次只亮一颗大点），移出线即恢复。
 *
 * ## 几个刻意的选择
 *
 * - **只收用户消息**（assistant 一条轮次里会拆成思考 / 工具 / 正文好几段，全列出来是噪音）；
 * - **`touch-none` 是必须的**：手机在线上纵向拖动时，若不接管 `touch-action`，
 *   手势会去滚消息列表，拉线就「拖不动」；
 * - **点仍渲染成 `<button>`**：指针交互由外层列统一接管，按钮留着是为了键盘 / 读屏
 *   （Tab 移动 + Enter 跳转），不然这套视觉一变就没有无障碍入口了；
 * - **簇点不写条数**：以前会在点旁边挂一个数字兼标，但线的左侧就是预览气泡的位置，
 *   两样东西抢一处、且数字只对「多点」存在（单点没数字看着像缺了）。改成**大小即条数**
 *   （`clusterDotSize`，面积正比 + 上下限），条数只在气泡清单、`aria-label` 里给全。
 * - **定位在消息列右侧的空白带里**：壳铺满面板、只用一个算出来的 `padding-right` 把竖线推到
 *   「消息列右缘 → 面板右缘」这条空白带的中线上（见 `RAIL_PADDING_RIGHT`），宽屏上竖线离
 *   正文有一大段空隙，不再贴在消息边上；
 * - **窄面板贴边**：那条空白带的宽度是 `(面板宽 − 消息列宽) / 2`，面板一窄（手机整屏、
 *   桌面上的窄分栏）它就没了 —— `max()` 的下限接管：**手机贴到面板右缘 4px**（窄屏横向
 *   每一像素都值钱），**有真滚动条时让开 12px**（否则线会画在那条 10px 滚动条上）。窄屏
 *   靠它自然退化，不靠断点硬切；两个取值由 `styles.css` 的 `--rail-inset` 一处给；
 * - **预览气泡仍开在线的左侧**：线虽然在空白带里，但面板右缘之外没有空间了；
 * - **滚动用 `scrollIntoView` + `scroll-mt-*`**（`onJump` 由 `ChatPanel` 提供），
 *   不自己算偏移 —— 消息高度是流式的，算不准。
 */
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { textOf } from '@fizz/agent-kit/shared/lib/parts'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 点区上下各留的内缩（px）：首末点不贴边、不被裁 */
const INSET = 24
/**
 * 竖线列的 `padding-right`：把它落到「消息列右缘 → 面板右缘」这条空白带的中线上。
 *
 * 记面板宽为 `W`（壳是铺满面板的绝对定位层，`100%` 就是它），消息列宽上限 `48rem`
 * （= `max-w-3xl`，与 `ChatSurface` 的 `ConversationContent` 同值）：两侧空白各
 * `(W − 48rem) / 2`，所以带中线到面板右缘的距离 = `(W − 48rem) / 4`。
 * 壳 `justify-end` 把 24px 的竖线列顶在自身内容盒的右缘，而 `padding-right: P` 让它到面板
 * 右缘的距离 = `P + 12px`（半个列宽），于是 `P = (W − 48rem) / 4 − 12px`。
 *
 * `max(var(--rail-inset), …)` 是**下限**而不是兜底：面板一窄（手机整屏、桌面上的窄分栏）
 * 空白带就没了，这里退化成 `--rail-inset` —— 竖线落在「面板右起 inset+1 ~ inset+23」这条带上。
 * `--rail-inset` 定义在 `styles.css`：**手机 / 无滚动条 4px（贴边）、有真滚动条 12px（让开它）**。
 * 手机横向每一像素都值钱，而竖线只是 1px 的线 + 几个小点，贴边才是它该在的位置；桌面那条
 * 10px 滚动条则必须让开，否则线画在滚动条上。
 *
 * ⚠️ 窄面板时这条带跟消息内容是**重叠**的（用户消息右对齐、操作行也靠右缘），所以窄面板下
 * `ChatSurface` 会给内容补一段右内边距当通道（`@max-[820px]:pr-[var(--rail-channel)]`）。
 * **两个值同源**：`--rail-channel = --rail-inset + 28px`（24px 列宽 + 4px 缝），都由
 * `styles.css` 里那一个 `--rail-inset` 推导 —— 别在这里或那边再写死第二个数（早先就是
 * 「0.75rem / 24px / 44px」三个魔数靠注释互指，改漏一个就压到「删除」按钮上）。
 * ⚠️ `48rem` 必须与 `ChatSurface` 的 `max-w-3xl` 保持一致，改一边要同步另一边。
 */
const RAIL_PADDING_RIGHT = 'max(var(--rail-inset, 12px), calc((100% - 48rem) / 4 - 12px))'
/** 激活判定半径（px）：指针离某个点多近才算「拖到了点上」 */
const HIT_RADIUS = 18
/** 箭头中心离气泡上 / 下边缘的最小间距（px）：再近就会戳进 `rounded-2xl` 的圆角里 */
const TAIL_INSET = 20
/**
 * 跟随指针的大点比它盖住的那个点大出多少（px）。
 *
 * 必须**严格大于**命中点的直径，否则大点会被点整个盖住 —— 簇点最大能到 `DOT_MAX`，
 * 尺寸写死的话，拖过一颗大簇点时看着像「没反应」。
 */
const CURSOR_DOT_GROW = 4
/** 滚动跟随的读线内缩（px）：提问起始位置越过「容器底缘 - 这个值」就算读到了 */
const SPY_LINE_INSET = 8
/**
 * 聚簇阈值（px）：一条时间轴上相邻提问的间距小于它就并进同一个簇点。
 * 用像素而不是比例：同一个 frac 差在 600px 高的窗口里已经隔了 9px（该并），在 200px
 * 的小窗口里只隔 3px（更该并），按比例判会两头不讨好。真的就这一个判据，不叠比例
 * 下限 —— 点区越高 14px 本来就越稀疏，再叠个下限会把正常间隔的提问也粘成一坨。
 */
const CLUSTER_GAP_PX = 14
/** 量不到点区高度（首帧）时的聚簇阈值兜底（比例）：量到后立刻按像素重算 */
const CLUSTER_GAP_FRAC = 0.03
/** 常态点直径（px）：单条提问的簇（拉线上绝大多数点都是它），同时也是簇点直径的下限 */
const DOT_SIZE = 5
/** 簇点直径上限（px）：再多的提问也涨到这儿就停 —— 理由见 `clusterDotSize` */
const DOT_MAX = 14
/** 移出拉线后的宽限（ms）：留给指针移进左侧气泡去点里面的提问 */
const CLEAR_DELAY = 180
/** 「点一下」的位移上限（px）：手指落在卡片外之后拖动（滚消息列表）不算点，不该顺手关掉卡片 */
const TAP_SLOP = 10

/** 线上的一个点：一条用户提问 */
interface OutlineItem {
  id: string
  index: number
  text: string
  /** 提问的发送时间（epoch ms）：详情里显示「几点几分」，也让点的间距可被读懂 */
  createdAt: number
  /** 真实时间轴上的位置（0~1） */
  frac: number
}

/** 线上的一簇点：一段时间里挨得太近的几条提问，渲染成一颗更大的簇点 */
interface OutlineCluster {
  /** 簇内第一条提问的 id —— 唯一（提问 id 本就唯一），当簇的 key / 激活标识用 */
  key: string
  items: OutlineItem[]
  /** 簇点位置 = 成员 frac 的均值 */
  frac: number
}

/**
 * 簇点直径（px）：**面积正比于条数**，夹在 `[DOT_SIZE, DOT_MAX]` 之间。
 *
 * 为什么按面积而不是直径：直径也正比的话，5 条的点会有 2 条的两倍宽，读起来像
 * 「多了一倍的提问」；面积正比才是「多了一倍的提问」。
 * 为什么封顶：拉线是 1px 宽，聚簇阈值也只有 `CLUSTER_GAP_PX`（14px），也就是说相邻两簇的
 * 中心最近也就隔 14px —— 点一旦超过这个直径就会跟邻居糊成一块，「哪段挤在一起」反而看不清。
 * 再往上加的信息量本来就趋零（8 条和 40 条一眼看过去没有区别），真要数条数，点开气泡里
 * 有清单、读屏有 `aria-label`。
 */
function clusterDotSize(count: number): number {
  const raw = DOT_SIZE * Math.sqrt(Math.max(1, count))
  return Math.min(DOT_MAX, Math.max(DOT_SIZE, raw))
}

/**
 * 提问时间：今天只写时分，同日之外补日期、跨年再补年份。
 *
 * 点是按**真实时间轴**排的，所以详情里不写时间的话，「这一段挤在一起」到底是连着问了
 * 5 分钟还是跨了 5 天根本分不出来 —— 时间是这张图的图例。日期只在必要时出现：
 * 长会话跨天时，「昨天 23:50」和「今天 00:10」光看时分会被当成同一时刻。
 */
function timeLabel(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return hm
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()} ${hm}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${hm}`
}

/** 一段提问的时间跨度：同一天就是「14:32–14:35」，跨天各自带日期（由 timeLabel 决定） */
function timeRangeLabel(items: OutlineItem[]): string {
  const first = timeLabel(items[0].createdAt)
  const last = timeLabel(items[items.length - 1].createdAt)
  return first === last ? first : `${first}–${last}`
}

/**
 * 按「间距小于 gapFrac」把提问并成簇。
 *
 * 判据是**与簇首**的距离而不是与上一个点的距离：一串连问里第 3 句和第 2 句可能刚好
 * 差 15px，但整串仍然是「同一段时间」，用簇首比才不会在长连问里反复裂成小簇；
 * 而「攒了一阵子、隔了一会儿又问一句」会老老实实分成两簇。
 *
 * 簇点取成员均值 —— 均值落在簇内成员的区间里，而相邻两簇的成员区间之间本来就隔着
 * ≥ gap，所以簇与簇之间不会被拉近到阈值以下（这是拿均值不用首点的原因）。
 */
function clusterByDensity(items: OutlineItem[], gapFrac: number): OutlineCluster[] {
  const toCluster = (members: OutlineItem[]): OutlineCluster => ({
    key: members[0].id,
    items: members,
    frac: members.reduce((sum, item) => sum + item.frac, 0) / members.length
  })
  if (items.length < 2 || gapFrac <= 0) return items.map((item) => toCluster([item]))
  const clusters: OutlineCluster[] = []
  let current: OutlineItem[] = [items[0]]
  for (let i = 1; i < items.length; i++) {
    if (items[i].frac - current[0].frac <= gapFrac) current.push(items[i])
    else {
      clusters.push(toCluster(current))
      current = [items[i]]
    }
  }
  clusters.push(toCluster(current))
  return clusters
}

/** 滚动跟随用的滚动容器：从消息元素向上找第一个可滚动的祖先（Conversation 的视口）。
    刻意从消息元素出发而不是从拉线出发 —— 拉线是滚动容器的**兄弟**，向上走够不到它。 */
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
  /** 点某个点：把那条消息滚到可视区顶部（由 ChatPanel 实现，见那边注释） */
  onJump: (messageId: string) => void
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 跟随指针的大点在点区内的像素 top；null = 不显示（桌面移出线 / 手机抬起） */
  const [cursorTop, setCursorTop] = useState<number | null>(null)
  /**
   * 大点的直径基准（px）：它盖住的那个点有多大，它就跟着多大 —— 簇点最大能到 `DOT_MAX`，
   * 尺寸写死的话，一颗大簇点会把这个「大点」整个吞掉，拖过去时看着像没反应。
   */
  const [cursorSize, setCursorSize] = useState(DOT_SIZE)
  /**
   * 「松手不关」（手机）：触屏抬起时指腹落在某个点上，气泡就钉住，不再跟着指针自动收起 ——
   * 此时它是一张真正的 popover（点外面 / ESC / ✕ 才关）。只对触屏生效，见文件头那节。
   *
   * ⚠️ 为什么另配一个 ref：scheduleClear 是稳定引用，读不到最新 state；而触屏抬起后浏览器
   * **还会补一个 pointerleave**，它若照旧收卡片，钉住当场就被清掉（这坑踩过一次）。
   */
  const [pinned, setPinned] = useState(false)
  const pinnedRef = useRef(false)
  const setPinnedState = useCallback((next: boolean): void => {
    pinnedRef.current = next
    setPinned(next)
  }, [])
  /** 激活点在点区内的像素 top：气泡与箭头都锚在它身上 */
  const [dotPx, setDotPx] = useState(0)
  /** 预览气泡中心在点区内的像素 top（按气泡实测高度 clamp，见下方 useLayoutEffect） */
  const [cardTop, setCardTop] = useState(0)
  /** 箭头中心相对气泡顶边的像素 top：激活点投到气泡上的位置，贴边时沿气泡边缘滑动 */
  const [tailTop, setTailTop] = useState(0)
  /** 点区（上下各内缩 INSET 的那块）：量高度、把指针 Y 换算成比例 */
  const areaRef = useRef<HTMLDivElement>(null)
  /** 预览气泡本体：量实际高度，箭头要按它定位 */
  const cardRef = useRef<HTMLDivElement>(null)
  /** 交互列（w-6 那条）：钉住后判断「点在卡片 / 线之外」要用 */
  const railRef = useRef<HTMLDivElement>(null)
  /** 最近一次命中到的簇 key：抬起时据此判断「指腹落在点上没有」，不依赖 state 的新鲜度 */
  const hitKeyRef = useRef<string | null>(null)
  /** 上一次触发跳转的点：同一个点持续激活时不重复 onJump（否则每帧都在滚） */
  const lastJumpRef = useRef<string | null>(null)
  /** 点区实测高度：聚簇阈值与命中判定都用像素，得先知道有多高（首帧量不到） */
  const [areaHeight, setAreaHeight] = useState(0)

  /*
    气泡与箭头的纵向定位：气泡要贴着激活点、箭头要正指着它，而气泡高度随内容浮动
    （line-clamp-6），只能在挂载后量实测高度 —— 布局阶段同步改 state，用户看不到跳动。
    气泡中心 clamp 在点区之内（贴边时不顶出面板）；激活点相对气泡的投影就是箭头位置，
    被 clamp 挤开时箭头沿气泡边缘滑动，仍然朝着点的那一侧。
    （hooks 必须在 `items.length < 2` 的提前返回之前调用，气泡不存在时下面自会短路。）
  */
  useLayoutEffect(() => {
    if (!activeId) return
    const area = areaRef.current
    const card = cardRef.current
    if (!area || !card) return
    const areaHeight = area.getBoundingClientRect().height
    if (areaHeight <= 0) return
    const cardHeight = card.offsetHeight
    const half = Math.min(cardHeight / 2, areaHeight / 2)
    const top = Math.min(Math.max(dotPx, half), areaHeight - half)
    setCardTop(top)
    // 箭头中心要正落在点的 Y 上：箭头的 tailTop 语义是「中心相对卡片顶边的偏移」
    // （样式里的 -translate-y-1/2 负责这个语义），而卡片顶边在点区里的 y =
    // top - cardHeight / 2，所以 tailTop = dotPx - (top - cardHeight / 2)。
    // ⚠️ 别丢 cardHeight / 2 这一项 —— 丢了箭头整体高半个气泡：中段固定偏上、
    // 越靠下偏得越多，只有贴顶时两项误差碰巧抵消（历史 bug 就在这）。
    // clamp 只在气泡比点区还高的极端情况下，把箭头挡在圆角安全区里。
    setTailTop(Math.min(Math.max(dotPx - top + cardHeight / 2, TAIL_INSET), cardHeight - TAIL_INSET))
  }, [activeId, dotPx])

  const items = useMemo<OutlineItem[]>(() => {
    const users = messages.filter((message) => message.role === 'user')
    const t0 = users[0]?.createdAt ?? 0
    const t1 = users[users.length - 1]?.createdAt ?? 0
    const span = t1 - t0
    return users.map((message, index) => ({
      id: message.id,
      index,
      // 空正文（只发了图之类）也给一个点，不然「目录」和实际轮次对不上
      text: textOf(message) || '（这条消息没有文字）',
      createdAt: message.createdAt,
      // 真实时间轴；时间戳全一样时按序号均匀铺开，别让所有点叠在顶端
      frac: users.length < 2 ? 0 : span > 0 ? (message.createdAt - t0) / span : index / (users.length - 1)
    }))
  }, [messages])

  /*
    点区高度实测（ResizeObserver）：聚簇阈值要按像素判。依赖 items.length —— 点数
    不足 2 时整条不渲染、点区还不存在，挂了也白挂，等真的有点了再量。
  */
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const measure = (height: number): void => {
      // 阈值差异小于 0.5px 时不 setState：窗口拖动时每帧都会回调，别把重渲染打满
      setAreaHeight((prev) => (Math.abs(prev - height) > 0.5 ? height : prev))
    }
    measure(area.getBoundingClientRect().height)
    const observer = new ResizeObserver((entries) => {
      measure(entries[0]?.contentRect.height ?? 0)
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [items.length])

  /** 渲染与命中判定用的簇：阈值 = 聚簇像素 / 点区高度（量不到高度时先用比例兜底） */
  const clusters = useMemo(() => {
    const gapFrac = areaHeight > 0 ? CLUSTER_GAP_PX / areaHeight : CLUSTER_GAP_FRAC
    return clusterByDensity(items, gapFrac)
  }, [items, areaHeight])

  /*
    指针移出拉线不立刻收：多提问的气泡要能点，指针会从拉线挪到左侧气泡上。若立刻
    clearActivation，气泡当场被卸载，那一下 click 根本发不出来。改成延后 CLEAR_DELAY，
    期间指针回到拉线或气泡上就取消。
    （这几个 hook 必须在「点数不足 2 就整条不返回」的提前返回之前，hook 顺序不能变。）
  */
  /**
   * 指针是否处于「按住」状态（鼠标左键 / 手指 / 笔）。
   * 只有按住时才允许滚动消息列表：桌面端鼠标扫过竖线不再乱跳，手机端按住线任意位置
   * 拖到哪个点就跳到哪个点（这条拖动体验是竖线的主要用法，别退化）。
   */
  const pressedRef = useRef(false)
  const clearTimerRef = useRef<number | null>(null)
  const cancelScheduledClear = useCallback((): void => {
    if (clearTimerRef.current === null) return
    window.clearTimeout(clearTimerRef.current)
    clearTimerRef.current = null
  }, [])
  const scheduleClear = useCallback((): void => {
    // 钉住期间一律不收：触屏抬起后补的 pointerleave、以及指针进出气泡都会走到这里
    if (pinnedRef.current) return
    cancelScheduledClear()
    clearTimerRef.current = window.setTimeout(() => {
      clearTimerRef.current = null
      setActiveId(null)
      lastJumpRef.current = null
      hitKeyRef.current = null
      setCursorTop(null)
    }, CLEAR_DELAY)
  }, [cancelScheduledClear])
  useEffect(() => cancelScheduledClear, [cancelScheduledClear])

  /** 只收激活（点放大 + 预览卡片 + 去重标记）；拉柄跟随指针，不归它管 */
  const clearActivation = useCallback((): void => {
    setActiveId(null)
    hitKeyRef.current = null
    lastJumpRef.current = null
  }, [])

  /** 全收：离开线 / 触屏抬起 / 点外面 —— 连拉柄和「钉住」一起退 */
  const clear = useCallback((): void => {
    clearActivation()
    setCursorTop(null)
    setPinnedState(false)
  }, [clearActivation, setPinnedState])

  /** target 是否落在预览气泡里（清单点选、✕）：落进去就别按位置改激活态，也别解除钉住 */
  const inCard = useCallback((target: EventTarget | null): boolean => {
    const card = cardRef.current
    return !!card && target instanceof Node && card.contains(target)
  }, [])

  /*
    钉住期间的关闭途径（popover 语义）：点气泡 / 线以外的地方，或按 ESC。
    挂在 `pinned` 上而不是常驻：没钉住时文档上多一层 pointer 监听纯属浪费，
    而且会把桌面「悬停出气泡」的手感搅乱。

    只认「点一下」：落在外面之后拖动（滚消息列表）不算点，理由见文件头那节。
    用 capture 抓在文档上，先于目标自己的 handler 收卡片。
  */
  useEffect(() => {
    if (!pinned) return
    let down: { x: number; y: number } | null = null
    const onPointerDown = (event: PointerEvent): void => {
      down = { x: event.clientX, y: event.clientY }
    }
    const onPointerUp = (event: PointerEvent): void => {
      const from = down
      down = null
      if (!from) return
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP) return
      const target = event.target
      if (target instanceof Node) {
        if (railRef.current?.contains(target) || cardRef.current?.contains(target)) return
      }
      clear()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') clear()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [pinned, clear])

  // ---------- 滚动跟随（scroll-spy）：滚到哪条提问，线上那个点就放大 ----------

  /** 当前「读到」的提问：最后一条起始位置越过读线（容器底缘）的用户消息 */
  const [scrolledId, setScrolledId] = useState<string | null>(null)
  /** computeSpy 经 ref 读最新 items：滚动监听只挂一次，不随消息数组重建。
      （ref 不能在渲染期写 —— 在布局 effect 里同步，它先于下面的被动 effect 执行） */
  const itemsRef = useRef(items)
  useLayoutEffect(() => {
    itemsRef.current = items
  }, [items])
  /** 壳元素：parentElement 就是 chat-surface 的 panelRef div（relative 根），消息元素
      与滚动容器都在它里面 —— 这层结构约定与 chat-surface 的「对齐壳」注释同一处 */
  const shellRef = useRef<HTMLDivElement>(null)
  /** 滚动 → 计算的 rAF 合帧：滚动再密，一帧最多算一次 */
  const spyRafRef = useRef<number | null>(null)

  const computeSpy = useCallback((): void => {
    const panel = shellRef.current?.parentElement
    if (!panel) return
    // 读线 = 容器底缘：最后一条起始位置已过线的提问 = 当前读到的。
    // 停在底部点亮最后一个点；往上翻时提问逐个「沉」出底缘，高亮跟着前移。
    const readingLine =
      (findScroller(panel) ?? panel).getBoundingClientRect().bottom - SPY_LINE_INSET
    let current: string | null = null
    for (const item of itemsRef.current) {
      const el = panel.querySelector(`[data-message-id="${CSS.escape(item.id)}"]`)
      if (!el) continue
      // DOM 顺序 = 时间顺序：第一条落在线下的，后面必然都在线下，直接收
      if (el.getBoundingClientRect().top > readingLine) break
      current = item.id
    }
    setScrolledId(current)
  }, [])

  // 滚动容器上挂监听（rAF 合帧）。消息还没渲染（装载骨架）时找不到容器，挂不上 ——
  // 等下一条 effect 在消息到达后补算，length 变化时也会重挂。
  useEffect(() => {
    const panel = shellRef.current?.parentElement
    if (!panel) return
    const scroller = findScroller(panel)
    if (!scroller) return
    const onScroll = (): void => {
      if (spyRafRef.current !== null) return
      spyRafRef.current = requestAnimationFrame(() => {
        spyRafRef.current = null
        computeSpy()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (spyRafRef.current !== null) {
        cancelAnimationFrame(spyRafRef.current)
        spyRafRef.current = null
      }
    }
  }, [computeSpy, messages.length])

  // 消息数组任何变化（装载 / 切会话 / 流式增量）都重算一次 —— 布局变了，但未必有滚动事件
  useEffect(() => {
    computeSpy()
  }, [computeSpy, messages])

  // 只有一个点时没什么可跳的，整条不出现
  if (items.length < 2) return null

  /*
    激活中的簇：activeId 既可能是簇的 key（指着簇点），也可能是簇内某一条提问的 id
    （在清单里点了某一条）—— 后者照样能按「成员包含」找回同一个簇，清单因此不会收起。
  */
  const active =
    clusters.find((cluster) => cluster.key === activeId) ??
    clusters.find((cluster) => cluster.items.some((item) => item.id === activeId)) ??
    null

  // 簇点的 aria-label：读屏用户靠它知道这个点跳到哪条提问（时间也要念出来 ——
  // 点位是按真实时间轴排的，缺了时间「间隔」这个信息就丢了）
  const labelOf = (cluster: OutlineCluster): string =>
    cluster.items.length === 1
      ? `跳到第 ${cluster.items[0].index + 1} 条提问（${timeLabel(cluster.items[0].createdAt)}）：${cluster.items[0].text.slice(0, 60)}`
      : `这段时间里的 ${cluster.items.length} 条提问（第 ${cluster.items[0].index + 1} 到 ${cluster.items[cluster.items.length - 1].index + 1} 条，${timeRangeLabel(cluster.items)}），展开查看`

  const handlePointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // 指针在预览气泡里（清单里点某条提问）：别再拿它的位置去命中判定 ——
    // 气泡在拉线左侧，按位置判定会把激活态判没了，清单跟着一起消失
    if (inCard(event.target)) return
    const area = areaRef.current
    if (!area) return
    const rect = area.getBoundingClientRect()
    if (rect.height <= 0) return

    cancelScheduledClear()
    const y = event.clientY - rect.top
    // 跟随指针的大点：桌面悬停就有、手机按下即出现（同一入口），位置 clamp 回拉线段内 ——
    // 交互列是整高、线却上下各内缩 INSET，指针压在两端时会滑到线头。
    setCursorTop(Math.min(Math.max(y, 0), rect.height))
    // 取最近的簇：命中半径按簇点大小放宽 —— 簇点本来就大，边界该跟着大
    let hit: { cluster: OutlineCluster; px: number } | null = null
    let best = Number.POSITIVE_INFINITY
    for (const cluster of clusters) {
      const px = cluster.frac * rect.height
      // +7 是点边缘外的手感余量（指腹比点大）；DOT_MAX/2 + 7 仍小于 HIT_RADIUS，
      // 所以半径实际由 HIT_RADIUS 兜底 —— 簇点变大不会顺手把邻居的点抢过来
      const radius = Math.max(HIT_RADIUS, clusterDotSize(cluster.items.length) / 2 + 7)
      const distance = Math.abs(px - y)
      if (distance <= radius && distance < best) {
        best = distance
        hit = { cluster, px }
      }
    }

    if (!hit) {
      // 指针在线上但附近没有点：拉柄照样跟着走，只收预览卡片 ——
      // 拉柄是「悬停在线上就出现」的，不该跟「是否激活到点」绑在一起
      clearActivation()
      hitKeyRef.current = null
      setCursorSize(DOT_SIZE)
      return
    }

    // 只在「真的按下去」时才跳，悬停/路过一律不跳 ——
    // 这条竖线就在消息区旁边，鼠标扫过去就滚消息列表是很打扰的（曾经就是这样）。
    // 悬停只负责高亮 + 出预览卡片，点/按住拖到别的点才滚动。
    // 点变了才跳，避免同一激活点上每帧重复滚动；跳到簇里的第一条
    const first = hit.cluster.items[0].id
    if (pressedRef.current && hit.cluster.key !== lastJumpRef.current) {
      lastJumpRef.current = hit.cluster.key
      onJump(first)
    }
    setActiveId(hit.cluster.key)
    setDotPx(hit.px)
    setCursorSize(clusterDotSize(hit.cluster.items.length))
    hitKeyRef.current = hit.cluster.key
  }

  return (
    /*
      壳铺满整个面板（不再与消息列同宽同居中）—— 竖线的水平落点由 `padding-right` 算出来：
      宽屏落在消息列右侧那条空白带的中线上，窄屏（手机 / 窄分栏）退化成原来的贴边位置，
      见 `RAIL_PADDING_RIGHT`。
      `items-stretch` 让列撑满整高，时间轴才能贯穿消息区（不再是之前的居中短条）。
    */
    <div
      ref={shellRef}
      className="pointer-events-none absolute inset-y-0 left-0 right-0 z-10 flex items-stretch justify-end"
      style={{ paddingRight: RAIL_PADDING_RIGHT }}
      data-outline="rail"
    >
      {/* 交互列：指针事件 + 滚动接管都挂在这 —— 宽 24px、整高，`touch-none` 防连带滚消息 */}
      <div
        ref={railRef}
        className="pointer-events-auto relative w-6 touch-none select-none"
        onPointerMove={handlePointer}
        onPointerDown={(event) => {
          pressedRef.current = true
          // 按下时清一次去重标记，同一个点连按两下也会重新滚一次
          lastJumpRef.current = null
          // 在气泡里按（清单点选 / ✕）不动钉住态；按线上则回到「拖动选点」模式
          if (!inCard(event.target)) setPinnedState(false)
          handlePointer(event)
        }}
        onPointerLeave={scheduleClear}
        onPointerUp={(event) => {
          pressedRef.current = false
          // 鼠标 / 笔抬起后仍悬在线上，拉柄留着，移出线（pointerLeave）再收 ——
          // 否则点一下，拉柄就凭空消失。
          if (event.pointerType !== 'touch') return
          // 触屏没有悬停态：抬起即收拉柄；指腹落在点上就把气泡钉住（popover 语义，
          // 见文件头那节），落在线段空白处（压根没选中点）就照原样收掉，不留空卡片
          setCursorTop(null)
          if (inCard(event.target)) return
          if (hitKeyRef.current) setPinnedState(true)
          else scheduleClear()
        }}
        onPointerCancel={() => {
          pressedRef.current = false
          clear()
        }}
      >
        {/* 拉线本体：贯穿整高、上下各内缩 INSET */}
        <div
          className="absolute left-1/2 w-px -translate-x-1/2 bg-border"
          style={{ top: INSET, bottom: INSET }}
        />

        {/* 点区：拉线同一段高度，点的 top 用百分比映射到 0~100% */}
        <div ref={areaRef} className="absolute inset-x-0" style={{ top: INSET, bottom: INSET }}>
          {/* 跟随指针的大点：桌面悬停 / 手机按住时出现（抬起、移出线即消失），沿线滑动。
              尺寸与命中点的放大态一致，命中时它正好被那个点盖住 → 视觉上就是「点被放大了」。
              pointer-events-none 不抢指针；排在点之前 → 点永远画在上层。 */}
          {cursorTop !== null ? (
            <span
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-foreground/20"
              style={{
                top: cursorTop,
                width: cursorSize + CURSOR_DOT_GROW,
                height: cursorSize + CURSOR_DOT_GROW
              }}
            />
          ) : null}

          {clusters.map((cluster) => {
            const count = cluster.items.length
            // 簇被激活有两种 activeId：簇 key，或清单里点了某一条（那一条的 id）——
            // 后者用 active（已按成员包含找回同一簇）判即可，不用在这里再比一遍
            const isActive = active?.key === cluster.key
            // 滚动跟随的高亮：指针悬在线上时让位 —— 同一视觉通道，一次只亮一颗大点
            const isCurrent =
              !isActive && cursorTop === null && cluster.items.some((item) => item.id === scrolledId)
            const size = clusterDotSize(count)
            return (
              <button
                key={cluster.key}
                type="button"
                aria-label={labelOf(cluster)}
                aria-current={isActive || isCurrent ? 'true' : undefined}
                // 多条簇点：跳到簇里第一条，同时把清单亮出来；单条簇：与从前一致
                onClick={() => {
                  const first = cluster.items[0].id
                  lastJumpRef.current = cluster.key
                  setActiveId(cluster.key)
                  onJump(first)
                }}
                // p-1.5 把可点区域撑到 ~23px；-translate-y-1/2 让点中心正落在 frac 处。
                // `touch-none` 不能只挂外层列：touch-action 不继承，手势起点落在按钮上时
                // 得由按钮自己声明，否则手机点到点上再拖会去滚消息列表。
                className="group/dot absolute left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer touch-none rounded-full p-1.5"
                style={{ top: `${cluster.frac * 100}%` }}
              >
                <span
                  style={{ width: size, height: size }}
                  className={cn(
                    'block rounded-full transition-all duration-150',
                    // 常态深浅按条数分两档（旧有）：单点淡一点、多点浓一点
                    isActive || isCurrent
                      ? 'bg-primary ring-2 ring-foreground/20'
                      : count > 1
                        ? 'bg-primary/45 group-hover/dot:bg-primary/70'
                        : 'bg-primary/35 group-hover/dot:bg-primary/60'
                  )}
                />
              </button>
            )
          })}

          {/* 预览气泡：贴着激活点左侧，尾巴正指激活点。多条提问时它是一份可点的清单，
              平时不拖住钉住状态（松手就收）；手机上手指落在点上就钉住，变成真正的
              popover，清单这时才真的点得动 —— 下面的 pointer-events 看 pinned。 */}
          {active ? (
            <div
              ref={cardRef}
              onPointerEnter={cancelScheduledClear}
              onPointerLeave={scheduleClear}
              className={cn(
                'absolute right-full mr-2 -translate-y-1/2 rounded-2xl border bg-popover px-3 py-2 text-popover-foreground shadow-md',
                // 多条提问 = 一份可点的清单；单条提问只读，平时不抢指针（让指针继续沿拉线滑动）。
                // 钉住之后单条也接管：否则点在这张只读卡片上会「穿透」到后方的消息正文上，
                // 手机上点空白会选中正文，观感像是没点着
                active.items.length > 1 || pinned
                  ? 'pointer-events-auto touch-pan-y overscroll-contain'
                  : 'pointer-events-none',
                active.items.length > 1 ? 'w-72' : 'w-64 max-w-[calc(100vw-5rem)]'
              )}
              style={{ top: cardTop }}
            >
              {/* 气泡尾巴：一枚转 45° 的小方块，中心骑在气泡右缘上 —— 带框的两条边
                  （border-t / border-r 转完朝右拼成箭头）bg-popover 正好盖住身后那段
                  气泡边框，接缝才看不出来。-translate-y-1/2 让 top 语义 = 箭头中心的 y，
                  上面的定位公式按这个语义算的，别删。 */}
              <span
                className="absolute -right-1.5 size-3 -translate-y-1/2 rotate-45 border-r border-t border-border bg-popover"
                style={{ top: tailTop }}
              />
              {active.items.length === 1 ? (
                <>
                  <div
                    className={cn(
                      'flex items-baseline justify-between gap-3 text-xs opacity-60',
                    )}
                  >
                    <span>第 {active.items[0].index + 1} 条提问</span>
                    <span className="shrink-0 tabular-nums">{timeLabel(active.items[0].createdAt)}</span>
                  </div>
                  <div className="mt-0.5 line-clamp-6 text-sm leading-5 whitespace-pre-wrap break-words">
                    {active.items[0].text}
                  </div>
                </>
              ) : (
                <>
                  <div
                    className={cn(
                      'flex items-baseline justify-between gap-3 text-xs opacity-60',
                    )}
                  >
                    <span>
                      这段时间里的 {active.items.length} 条提问（第 {active.items[0].index + 1}–
                      {active.items[active.items.length - 1].index + 1} 条）
                    </span>
                    <span className="shrink-0 tabular-nums">{timeRangeLabel(active.items)}</span>
                  </div>
                  {/* 清单：点哪一条就滚到那一条，并把它高亮（activeId 变成这条的 id，
                      上面的 active 仍能按「成员包含」找回这个簇，气泡因此不会收起） */}
                  <div className="mt-1 max-h-56 overflow-y-auto overscroll-contain">
                    {active.items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          lastJumpRef.current = active.key
                          setActiveId(item.id)
                          onJump(item.id)
                        }}
                        className={cn(
                          'block w-full cursor-pointer rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent',
                          item.id === activeId && 'bg-accent'
                        )}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[0.625rem] opacity-50">第 {item.index + 1} 条</span>
                          <span className="shrink-0 text-[0.625rem] tabular-nums opacity-50">
                            {timeLabel(item.createdAt)}
                          </span>
                        </div>
                        <span className="block line-clamp-2 text-sm leading-5 whitespace-pre-wrap break-words">
                          {item.text}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
