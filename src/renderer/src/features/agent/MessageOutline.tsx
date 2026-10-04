/**
 * 消息目录：把整段会话画成一条「拉线」—— 贴消息区右缘的一条竖线 + 线上的一串点。
 * 一条用户消息 = 线上的一个点，点位置按**真实时间轴**排布：
 *
 *   frac = (createdAt - t0) / (t1 - t0)     // t0 / t1 = 首 / 末条用户消息的时间戳
 *
 * 于是「问得密的地方点就挤在一起、隔得久的地方拉得开」。时间戳不可用时
 * （ACP 回放不带时间戳 / 旧数据缺字段 / 全段同值）退化成按序号均匀分布。
 *
 * 移植自 FishWork（`components/MessageOutline.tsx`）。行为与交互逐条对齐，
 * 只做本仓适配，三处：
 * 1. 消息类型换成 dogi 的 `AgentChatMessage`（`@shared/types`），`cn` 走 `'cn'`，
 *    `textOf` 内联（过滤 text 段后拼接）；预览气泡仍用 antd `Card`（见 3.4 UI 一律 antd）。
 * 2. **时间轴的容错更严**：fishwork 直接取数组首尾做 t0/t1，本仓的
 *    `items` 保留更保守的算法（有效数字的 min/max + 坏值单独按序号补位 + 钳回 [0,1]），
 *    见下方 `items` 的注释 —— 会话消息未必按时间排序，一条坏时间戳不该把整条打成等距。
 * 3. **壳的几何跟着本仓的消息列**：消息列内边距是 `px-5`（fishwork 是 `px-3`），
 *    所以交互列保留 `-mr-3` 把竖线推到消息列右缘；滚动跟随也改由本组件自己监听
 *    （原 `highlightId` 入参已删，见下）。
 *
 * ## 聚簇：一段时间里的连问
 *
 * 真实时间轴有个副作用：赶进度时连着问五句，这五个点会叠成一小坨，谁也点不准。
 * 所以按**像素距离**（不是比例 —— 同样的比例在不同高度的窗口里差很远）把挨得太近
 * 的点并成一个「簇点」：点更大、旁边带一个提问条数，簇内顺序仍然是消息顺序。
 *
 * 指向簇点时预览气泡变成一份**清单**：列出这段时间里的每一条提问，点哪一条就滚到
 * 那一条（`onJump`），并把它高亮 —— 所以「刚才那一串问的是啥」不用往回翻。
 * 单条提问的簇点行为与从前完全一致（点一下直接跳过去）。
 *
 * ## 交互（桌面与手机同一套）
 *
 * 指针在线上移动即生效 —— 桌面悬停（无需按住）、手机按住拖动都一样：
 * 指针 Y 处始终跟着一颗**大点**（大小 = 命中点的放大态），桌面悬停就出现、手机按下出现、
 * 触屏抬起即消失（鼠标 / 笔抬起后仍悬在线上则保留，移出线才收）；
 * **拉柄与激活解耦**：悬停在拉的任意位置拉柄都在，只有指针落进某个点的
 * `HIT_RADIUS` 内才把它「激活」——
 * 点放大、左侧弹出带箭头的预览气泡。**跳转只在点击时发生**（桌面点按钮、触屏点按都走它）——
 * 鼠标悬停只是「放大 + 看预览」，绝不抢滚动：指针只是划过线、消息列表就被猛拽到那条，
 * 正是「hover 就滚动太灵敏」的元凶，所以 hover 阶段不调用 `onJump`，真正跳转交给 click。
 * 指针移开 / 抬起即清除激活。
 * 因为触屏没有 hover，这里**不用 Tooltip**（antd 的气泡在触屏上弹不出来），
 * 预览气泡是一张自己定位的浮层，随激活点走，尾巴始终指向激活点。
 *
 * 指针移出拉线**不立刻收**（`CLEAR_DELAY`）：多提问的气泡要能点，指针会从拉线挪到
 * 左侧气泡上，立刻清激活会让那一下 click 根本发不出来。延后收，期间指针回到
 * 拉线或气泡上就取消。
 *
 * ## 滚动跟随（scroll-spy）
 *
 * 消息列表滚到哪，线上对应的点就放大（与悬停激活同一套视觉）：
 * 以滚动容器**底缘**为读线，最后一条「起始位置已过线」的用户提问就是当前读到的；
 * 停在底部时点亮最后一个点、往上翻早期消息时逐个前移 —— 语义是「你现在读到的
 * 是第几轮提问之后的回答」。指针悬在线上时滚动高亮**让位**（同一视觉通道，
 * 一次只亮一颗大点），移出线即恢复。
 *
 * ⚠️ 跟随由本组件**自己**做（监听找到的滚动容器 + rAF 合帧），不再由 AgentPage
 * 传 `highlightId` 进来：滚动容器要从消息元素往上找（拉线是它的兄弟，走不到），
 * 而读线又必须用容器的位置，两件事都只在这里拿得到。原 AgentPage 里的
 * `handleScroll` / `scrollMessageId` 一并删掉。
 *
 * ## 几个刻意的选择
 *
 * - **只收用户消息**（assistant 一条轮次里会拆成思考 / 工具 / 正文好几段，全列出来是噪音）；
 * - **`touch-none` 是必须的**：手机在线上纵向拖动时，若不接管 `touch-action`，
 *   手势会去滚消息列表，拉线就「拖不动」；
 * - **点仍渲染成 `<button>`**：指针交互由外层列统一接管，按钮留着是为了键盘 / 读屏
 *   （Tab 移动 + Enter 跳转），不然这套视觉一变就没有无障碍入口了；
 * - **定位在消息列内部、贴右缘**：壳与消息列（同 `max-w-3xl`）对齐，竖线 `justify-end`
 *   靠右内边缘。消息右侧天然空出一条缝（`max-w-[85%]`），
 *   24px 的列正好落在这个空档里，不压正文；
 * - **预览气泡开在线的左侧**：线已贴消息列右缘，再往右会顶出面板；
 * - **滚动用 `scrollIntoView` + `scroll-mt-*`**（`onJump` 由 `AgentPage` 提供），
 *   不自己算偏移 —— 消息高度是流式的，算不准。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { Card, Typography } from 'antd'
import { cn } from 'cn'
import type { AgentChatMessage } from '@shared/types'

/** 点区上下各留的内缩（px）：首末点不贴边、不被裁 */
const INSET = 24
/** 激活判定半径（px）：指针离某个点多近才算「拖到了点上」 */
const HIT_RADIUS = 18
/** 箭头中心离气泡上 / 下边缘的最小间距（px）：再近就会戳进 `rounded-2xl` 的圆角里 */
const TAIL_INSET = 20
/** 跟随指针的大点直径（px）：与命中点的放大态（11px + ring-2）完全一致 */
const CURSOR_DOT = 11
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
/** 簇点直径随条数增长：单点仍是常态的 5px，每多一条 +2px，到 11px 封顶（与放大态一致） */
const CLUSTER_DOT_BASE = 6
const CLUSTER_DOT_MAX = 11
/** 常态点直径（单点簇） */
const DOT_SIZE = 5
/** 移出拉线后的宽限（ms）：留给指针移进左侧气泡去点里面的提问 */
const CLEAR_DELAY = 180

/** 线上的一个点：一条用户提问 */
interface OutlineItem {
  id: string
  index: number
  text: string
  /** 真实时间轴上的位置（0~1） */
  frac: number
}

/** 线上的一个簇点：一段时间里挨得太近的几条提问 */
interface OutlineCluster {
  /** 簇内第一条提问的 id —— 唯一（提问 id 本就唯一），当簇的 key / 激活标识用 */
  key: string
  items: OutlineItem[]
  /** 簇点位置 = 成员 frac 的均值 */
  frac: number
}

/** 取用户消息里的纯文本（空正文也保留一个点，保证目录与实际轮次对应） */
function textOfMessage(message: AgentChatMessage): string {
  return (
    message.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
      .trim() || '（这条消息没有文字）'
  )
}

/* ------------------------------------------------------------------ *
 * 只收用户消息（带结构共享）
 *
 * 目录只画**用户提问**，而流式输出期间变化的只有 assistant 消息 ——
 * 用户消息对象是引用稳定的。于是逐个按**引用**比对就能复用上次的数组，
 * 让下面 items / clusters 的 memo 不被每个 token 打掉。
 *
 * ⚠️ 之前 `items` 的依赖是整个 `messages` 数组，而它每个 token 都换 ——
 * 于是每来一个 token 就重算一遍「过滤全部消息 + 抽每条用户消息的纯文本」，
 * 外加一次 O(用户消息数) 的 DOM 查询与 `getBoundingClientRect`（强制同步布局）。
 * 两者都随会话变长而线性变差，正是「消息一多就卡」的形状。
 * ------------------------------------------------------------------ */
let userMessagesCache: {
  src: AgentChatMessage[]
  out: AgentChatMessage[]
} | null = null

export function selectUserMessages(messages: AgentChatMessage[]): AgentChatMessage[] {
  const cached = userMessagesCache
  if (cached && cached.src === messages) return cached.out
  const prev = cached?.out
  let allReused = prev !== undefined
  const out: AgentChatMessage[] = []
  let cursor = 0
  for (const m of messages) {
    if (m.role !== 'user') continue
    // 按顺序复用上一份里字段相同的那条（引用相同即可 —— 流式不改用户消息）
    const old = prev?.[cursor]
    if (old && old === m) {
      out.push(old)
    } else {
      allReused = false
      out.push(m)
    }
    cursor++
  }
  // 上一份比这次多（用户消息被删）时也算「没能整体复用」
  if (allReused && prev && prev.length === out.length) {
    userMessagesCache = { src: messages, out: prev }
    return prev
  }
  userMessagesCache = { src: messages, out }
  return out
}

/** 簇点直径（px） */
function clusterDotSize(count: number): number {
  if (count <= 1) return DOT_SIZE
  return Math.min(CLUSTER_DOT_MAX, CLUSTER_DOT_BASE + (count - 1) * 2)
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
  /** 点某个点：把那条消息滚到可视区顶部（由 AgentPage 实现跳转） */
  onJump: (messageId: string) => void
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 跟随指针的大点在点区内的像素 top；null = 不显示（桌面移出线 / 手机抬起） */
  const [cursorTop, setCursorTop] = useState<number | null>(null)
  /** 激活点在点区内的像素 top：气泡与箭头都锚在它身上 */
  const [dotPx, setDotPx] = useState(0)
  /** 预览气泡中心在点区内的像素 top（按气泡实测高度 clamp，见下方 useLayoutEffect） */
  const [cardTop, setCardTop] = useState(0)
  /** 箭头中心相对气泡顶边的像素 top：激活点投到气泡上的位置，贴边时沿气泡边缘滑动 */
  const [tailTop, setTailTop] = useState(0)
  /** 点区（上下各内缩 INSET 的那块）：量高度、把指针 Y 换算成比例 */
  const areaRef = useRef<HTMLDivElement>(null)
  /** 预览气泡本体（外层定位 div）：量实际高度，箭头要按它定位 */
  const cardRef = useRef<HTMLDivElement>(null)
  /** 上一次触发跳转的簇：同一个簇持续激活时不重复 onJump（否则每帧都在滚） */
  const lastJumpRef = useRef<string | null>(null)
  /** 点区实测高度：聚簇阈值与命中判定都用像素，得先知道有多高（首帧量不到） */
  const [areaHeight, setAreaHeight] = useState(0)

  /*
    气泡与箭头的纵向定位：气泡要贴着激活点、箭头要正指着它，而气泡高度随内容浮动
    （line-clamp-6 / 多条时的清单），只能在挂载后量实测高度 —— 布局阶段同步改 state，
    用户看不到跳动。气泡中心 clamp 在点区之内（贴边时不顶出面板）；激活点相对气泡的
    投影就是箭头位置，被 clamp 挤开时箭头沿气泡边缘滑动，仍然朝着点的那一侧。
    （hooks 必须在 `items.length < 2` 的提前返回之前调用，气泡不存在时下面自会短路。）
  */
  useLayoutEffect(() => {
    if (!activeId) return
    const area = areaRef.current
    const card = cardRef.current
    if (!area || !card) return
    const areaHeight = area.getBoundingClientRect().height
    if (areaHeight <= 0) return
    const cardH = card.offsetHeight
    const half = Math.min(cardH / 2, areaHeight / 2)
    const top = Math.min(Math.max(dotPx, half), areaHeight - half)
    setCardTop(top)
    // 箭头中心要正落在点的 Y 上：箭头的 tailTop 语义是「中心相对气泡顶边的偏移」
    // （样式里的 -translate-y-1/2 负责这个语义），而气泡顶边在点区里的 y =
    // top - cardH / 2，所以 tailTop = dotPx - (top - cardH / 2)。
    // ⚠️ 别丢 cardH / 2 这一项 —— 丢了箭头整体高半个气泡：中段固定偏上、
    // 越靠下偏得越多，只有贴顶时两项误差碰巧抵消（历史 bug 就在这）。
    // clamp 只在气泡比点区还高的极端情况下，把箭头挡在圆角安全区里。
    setTailTop(Math.min(Math.max(dotPx - top + cardH / 2, TAIL_INSET), cardH - TAIL_INSET))
  }, [activeId, dotPx])

  /**
   * 只收用户提问（结构共享，见 selectUserMessages 的注释）。
   * 依赖是 `users` 而不是 `messages` —— 流式期间 `users` 引用不变，
   * 于是下面整条 `items` / `clusters` 链不会被每个 token 重算。
   */
  const users = useMemo(() => selectUserMessages(messages), [messages])

  const items = useMemo(() => {
    const n = users.length
    // 时间戳：缺省 / 非数字 / 非有限 一律视为「坏值」（后续这条按序号补位，不再拖垮整条）
    const stamps = users.map((m) =>
      typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : null
    )
    // 可用时间轴 = 至少两个「有效数字」时间戳，且首尾不相等。
    // 用全部有效数字里的 min / max 当端点（不是数组首尾）：消息数组未必按时间排序
    // （编辑重发 / 乱序载入），用首尾会让部分 frac 算出负或 >1，把那个点推到轨外消失。
    const valid = stamps.filter((s): s is number => s !== null)
    const t0 = valid.length > 0 ? valid.reduce((a, b) => Math.min(a, b), Infinity) : 0
    const t1 = valid.length > 0 ? valid.reduce((a, b) => Math.max(a, b), -Infinity) : 0
    const span = t1 - t0
    const timeOk = valid.length >= 2 && span > 0
    return users.map((message, index) => {
      const stamp = stamps[index]
      let frac: number
      if (timeOk && stamp !== null) {
        // 真实时间轴：问得密的地方点挤在一起、隔得久的地方拉得开
        frac = (stamp - t0) / span
      } else {
        // 没有可用时间轴（ACP 回放协议不带时间戳 / 旧数据缺 createdAt / 时间戳全相同）：
        // 这条消息按序号均匀分布 —— 这是没有时间信息时的诚实做法，且只影响坏值本身，
        // 不会像之前那样因一条坏数据把整条打成等距。
        frac = n < 2 ? 0 : index / (n - 1)
      }
      // 越界（坏时间戳算出的负/超大值）钳回 [0,1]，保证点始终落在轨内、不被推到轨外消失
      if (!Number.isFinite(frac)) frac = index / Math.max(1, n - 1)
      frac = Math.min(1, Math.max(0, frac))
      return {
        id: message.id,
        index,
        // 空正文（只发了图之类）也给一个点，不然「目录」和实际轮次对不上
        text: textOfMessage(message),
        frac
      }
    })
  }, [users])

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
    清除激活，气泡当场被卸载，那一下 click 根本发不出来。改成延后 CLEAR_DELAY，
    期间指针回到拉线或气泡上就取消。
    （这几个 hook 必须在「点数不足 2 就整条不返回」的提前返回之前，hook 顺序不能变。）
  */
  const clearTimerRef = useRef<number | null>(null)
  const cancelScheduledClear = useCallback((): void => {
    if (clearTimerRef.current === null) return
    window.clearTimeout(clearTimerRef.current)
    clearTimerRef.current = null
  }, [])
  const scheduleClear = useCallback((): void => {
    cancelScheduledClear()
    clearTimerRef.current = window.setTimeout(() => {
      clearTimerRef.current = null
      setActiveId(null)
      lastJumpRef.current = null
      setCursorTop(null)
    }, CLEAR_DELAY)
  }, [cancelScheduledClear])
  useEffect(() => cancelScheduledClear, [cancelScheduledClear])

  // ---------- 滚动跟随（scroll-spy）：滚到哪条提问，线上那个点就放大 ----------

  /** 当前「读到」的提问：最后一条起始位置越过读线（容器底缘）的用户消息 */
  const [scrolledId, setScrolledId] = useState<string | null>(null)
  /** 消息元素缓存：id → DOM 元素。滚动每帧都要量消息位置，querySelector 每帧重查是主要开销 */
  const elCacheRef = useRef<Map<string, HTMLElement>>(new Map())
  /** elCache 对应的是哪一批 items（引用比较即可 —— 见 selectUserMessages） */
  const itemsCacheRef = useRef<OutlineItem[]>(items)
  /** 滚动容器缓存：向上找可滚动祖先要 getComputedStyle，逐帧找纯属浪费 */
  const scrollerRef = useRef<HTMLElement | null>(null)
  /** 壳元素：parentElement 就是 AgentPage 里包着对话流的那层 `relative` 根，
      消息元素与滚动容器都在它里面 */
  const shellRef = useRef<HTMLDivElement>(null)
  /** 滚动 → 计算的 rAF 合帧：滚动再密，一帧最多算一次 */
  const spyRafRef = useRef<number | null>(null)
  /** computeSpy 经 ref 读最新 items：滚动监听只挂一次，不随消息数组重建。
      （ref 不能在渲染期写 —— 在布局 effect 里同步，它先于下面的被动 effect 执行） */
  const itemsRef = useRef(items)
  useLayoutEffect(() => {
    itemsRef.current = items
    // 点数变了（发新提问 / 切会话 / 回放）→ 缓存的消息元素作废，重建
    elCacheRef.current.clear()
    itemsCacheRef.current = items
  }, [items])

  /** 取消息元素：命中缓存就直接用（DOM 顺序 = items 顺序，元素不会凭空换人） */
  const messageEl = (panel: HTMLElement, id: string): HTMLElement | null => {
    const cache = elCacheRef.current
    if (itemsCacheRef.current !== itemsRef.current) {
      // items 换了一批而布局 effect 还没跑（同一帧内先算了 spy）：宁可不命中
      return null
    }
    const hit = cache.get(id)
    if (hit && hit.isConnected) return hit
    const found = panel.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    if (found) cache.set(id, found)
    return found
  }

  const computeSpy = useCallback((): void => {
    const panel = shellRef.current?.parentElement
    if (!panel) return
    // 读线 = 容器底缘：最后一条起始位置已过线的提问 = 当前读到的。
    // 停在底部点亮最后一个点；往上翻时提问逐个「沉」出底缘，高亮跟着前移。
    let scroller = scrollerRef.current
    if (!scroller || !scroller.isConnected) {
      scroller = findScroller(panel)
      scrollerRef.current = scroller
    }
    const readingLine = (scroller ?? panel).getBoundingClientRect().bottom - SPY_LINE_INSET
    const list = itemsRef.current

    /**
     * 找「最后一条 top 已过读线」的提问。
     *
     * ⚠️ 用**二分**而不是从前往后扫：扫是 O(条数) 次 `getBoundingClientRect`，
     * 每帧都做的话，滚动在长会话里就是实打实的掉帧（读 rect 会触发强制同步布局）。
     * 二分成立的前提是「DOM 顺序 = 时间顺序、rect.top 单调」，这正是下面的注释所述。
     * 命中不了元素（切会话途中 / 消息还没渲染）时退回线性扫 —— 扫的是缓存，
     * 没有 querySelector 的开销，可以接受。
     */
    const topAt = (index: number): number | null => {
      const el = messageEl(panel, list[index].id)
      return el ? el.getBoundingClientRect().top : null
    }
    let current: string | null = null
    let lo = 0
    let hi = list.length - 1
    let bail = false
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const top = topAt(mid)
      if (top === null) {
        bail = true
        break
      }
      if (top <= readingLine) {
        current = list[mid].id
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (bail) {
      current = null
      for (let i = 0; i < list.length; i++) {
        const top = topAt(i)
        if (top === null) continue
        if (top > readingLine) break
        current = list[i].id
      }
    }
    // 同值不 set：每个 token / 每帧都会算一次，别把重渲染打满
    setScrolledId((prev) => (prev === current ? prev : current))
  }, [])

  // 滚动容器上挂监听（rAF 合帧）。消息还没渲染（装载骨架）时找不到容器，挂不上 ——
  // 等下一条 effect 在消息到达后补算，length 变化时也会重挂。
  useEffect(() => {
    const panel = shellRef.current?.parentElement
    if (!panel) return
    const scroller = findScroller(panel)
    if (!scroller) return
    scrollerRef.current = scroller
    const onScroll = (): void => {
      if (spyRafRef.current !== null) return
      spyRafRef.current = requestAnimationFrame(() => {
        spyRafRef.current = null
        computeSpy()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    // 窗口尺寸变了（分屏拖拽、窗口缩放）读线位置也变：补算一次
    window.addEventListener('resize', onScroll)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (spyRafRef.current !== null) {
        cancelAnimationFrame(spyRafRef.current)
        spyRafRef.current = null
      }
    }
  }, [computeSpy, items.length])

  /*
    提问集合变化（装载 / 切会话 / 回放 / 用户新发一条）后重算一次 ——
    布局变了，但未必有滚动事件。

    ⚠️ **依赖是 `items.length` 而不是 `messages`**：assistant 正文在流式增长时，
    所有用户提问的位置**纹丝不动**（新内容只长在它们下面），所以没必要每个 token
    算一次；而这项计算会读消息元素的 rect（强制同步布局），每个 token 一次就是长会话里
    实打实的掉帧。用户提问增减由 `items.length` 覆盖，滚动中的位置变化由上面的
    scroll 监听覆盖，两条合起来就够了。
  */
  useEffect(() => {
    computeSpy()
  }, [computeSpy, items.length, users])

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

  // 簇点的 aria-label：读屏用户靠它知道这个点跳到哪条提问
  const labelOf = (cluster: OutlineCluster): string =>
    cluster.items.length === 1
      ? `跳到第 ${cluster.items[0].index + 1} 条提问：${cluster.items[0].text.slice(0, 60)}`
      : `这段时间里的 ${cluster.items.length} 条提问（第 ${cluster.items[0].index + 1} 到 ${cluster.items[cluster.items.length - 1].index + 1} 条），展开查看`

  /** 只收激活（点放大 + 预览卡片 + 去重标记）；拉柄跟随指针，不归它管 */
  const clearActivation = (): void => {
    setActiveId(null)
    lastJumpRef.current = null
  }

  /** 指针离开线 / 触屏抬起：连拉柄一起收（**延后**收，见上方 CLEAR_DELAY 说明） */
  const clear = (): void => {
    scheduleClear()
  }

  const handlePointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // 指针在预览气泡里（清单里点某条提问）：别再拿它的位置去命中判定 ——
    // 气泡在拉线左侧，按位置判定会把激活态判没了，清单跟着一起消失
    const card = cardRef.current
    if (card && event.target instanceof Node && card.contains(event.target)) return
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
      return
    }

    // 鼠标**悬停**只放大 + 弹预览，不抢滚动：用户只是把指针移过去看一眼，
    // 列表就猛跳到那条消息，正是「hover 就滚动太灵敏」的元凶。真正的跳转交给
    // 点击（按钮的 onClick，桌面 / 触屏都走它）；触屏没有 hover，按下（pointerdown）
    // 即视为一次明确的跳转意图，仍照跳。
    const first = hit.cluster.items[0].id
    const isHover = event.pointerType === 'mouse' && event.type === 'pointermove'
    if (!isHover && hit.cluster.key !== lastJumpRef.current) {
      lastJumpRef.current = hit.cluster.key
      onJump(first)
    }
    setActiveId(hit.cluster.key)
    setDotPx(hit.px)
  }

  return (
    /*
      壳与消息列（mx-auto max-w-3xl px-5）**逐项对齐**，
      列 justify-end 贴右内边缘 → 竖线落在消息列内部的右缘，而不是列外侧的空白区。
      `items-stretch` 让列撑满整高，时间轴才能贯穿消息区（不再是之前的居中短条）。
    */
    <div
      ref={shellRef}
      className="pointer-events-none absolute inset-y-0 left-1/2 z-10 flex w-full max-w-3xl -translate-x-1/2 items-stretch justify-end px-3"
      data-outline="rail"
    >
      {/* 交互列：指针事件 + 滚动接管都挂在这 —— 宽 24px、整高，`touch-none` 防连带滚消息。
          `-mr-3` 把整列往右推到消息列右缘再略出一点，远离消息正文（见壳的 `px-3`） */}
      <div
        className="pointer-events-auto relative -mr-3 w-6 touch-none select-none"
        onPointerMove={handlePointer}
        onPointerDown={handlePointer}
        onPointerLeave={scheduleClear}
        onPointerUp={(event) => {
          // 触屏没有悬停态，抬起即收；鼠标 / 笔抬起来还悬在线上，拉柄留着，
          // 移出线（pointerLeave）再收 —— 否则点一下，拉柄就凭空消失。
          // 触屏也走延时：清单里的按钮要吃到抬起后的那一次 click
          if (event.pointerType === 'touch') scheduleClear()
        }}
        onPointerCancel={clear}
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
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-foreground/20"
              style={{ top: cursorTop, width: CURSOR_DOT, height: CURSOR_DOT }}
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
                    isActive || isCurrent
                      ? 'bg-foreground ring-2 ring-foreground/20'
                      : count > 1
                        ? 'bg-foreground/45 group-hover/dot:bg-foreground/70'
                        : 'bg-foreground/35 group-hover/dot:bg-foreground/60'
                  )}
                />
              </button>
            )
          })}

          {/* 条数徽标：簇点有多大光看大小不直观，旁边直接写「这几条」的条数。
              激活时气泡正好盖住这一块，不重复出现。 */}
          {clusters.map((cluster) =>
            cluster.items.length > 1 && active?.key !== cluster.key ? (
              <span
                key={`n-${cluster.key}`}
                aria-hidden
                className="pointer-events-none absolute -translate-y-1/2 text-[9px] leading-none tabular-nums text-foreground/45"
                style={{ top: `${cluster.frac * 100}%`, right: 'calc(100% + 2px)' }}
              >
                {cluster.items.length}
              </span>
            ) : null
          )}

          {/* 预览气泡：贴着激活点左侧，尾巴正指激活点。单条提问只读（pointer-events-none，
              不抢指针）；多条提问时它是一份可点的清单，才需要接管指针 —— 见下面注释。 */}
          {active ? (
            <div
              ref={cardRef}
              onPointerEnter={cancelScheduledClear}
              onPointerLeave={scheduleClear}
              className={cn(
                'absolute right-full mr-2 -translate-y-1/2',
                active.items.length > 1
                  ? // 清单要能点：接管指针 + touch-pan-y（列表本身可滚，外层列是 touch-none，
                    // 不覆盖的话手机在清单上滑不动）
                    'pointer-events-auto w-72 touch-pan-y'
                  : 'pointer-events-none w-64 max-w-[calc(100vw-5rem)]'
              )}
              style={{ top: cardTop }}
            >
              <Card
                size="small"
                bordered={false}
                className="rounded-2xl border border-border bg-popover text-popover-foreground shadow-md"
                styles={{ body: { padding: '8px 12px' } }}
              >
                {/* 气泡尾巴：一枚转 45° 的小方块，中心骑在气泡右缘上 —— 带框的两条边
                    （border-r / border-t 转完朝右拼成箭头）bg-popover 正好盖住身后那段
                    气泡边框，接缝才看不出来。-translate-y-1/2 让 top 语义 = 箭头中心的 y，
                    上面的定位公式按这个语义算的，别删。 */}
                <span
                  className="absolute -right-1.5 size-3 -translate-y-1/2 rotate-45 border-r border-t border-border bg-popover"
                  style={{ top: tailTop }}
                />
                {active.items.length === 1 ? (
                  <>
                    <Typography.Text className="block text-xs opacity-60">
                      第 {active.items[0].index + 1} 条提问
                    </Typography.Text>
                    <Typography.Paragraph
                      className="mb-0 mt-0.5 whitespace-pre-wrap break-words text-sm leading-5"
                      ellipsis={{ rows: 6, tooltip: false }}
                    >
                      {active.items[0].text}
                    </Typography.Paragraph>
                  </>
                ) : (
                  <>
                    <Typography.Text className="block text-xs opacity-60">
                      这段时间里的 {active.items.length} 条提问（第 {active.items[0].index + 1}–
                      {active.items[active.items.length - 1].index + 1} 条）
                    </Typography.Text>
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
                          <span className="text-[10px] opacity-50">第 {item.index + 1} 条</span>
                          <span className="block line-clamp-2 text-sm leading-5 whitespace-pre-wrap break-words">
                            {item.text}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </Card>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
