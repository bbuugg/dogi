/**
 * 消息区的「上拉刷新」：滚到**底部**继续上拉 → **松手**重拉这条会话。
 *
 * ## 为什么是「拉」而不是一颗按钮
 *
 * 一轮失败时错误是以文本 part 落进历史的，它后面原本挂着一颗「重新加载」。那颗按钮有三个
 * 毛病：占着正文下方一行、只在**错误**时才存在（而「一条消息都没有」往往是**没加载成功**，
 * 那种状态下根本没有按钮可点）、以及窄屏上容易被输入框顶走。手势没有这些问题 ——
 * 空态 / 错误态 / 正常态都是同一套动作（见 `usePullToRefresh` 的 `enabled`）。
 *
 * ## 为什么在底部、为什么是上拉
 *
 * 聊天流里「底部」才是新的方向（历史在上、最新在下），所以刷新动作跟着放在底部：滚到头了
 * 还继续往上推，说明用户要的不是更旧的内容，而是「这一屏是不是过时了」。指示器也贴在
 * 底边（见 `PullToRefreshIndicator`），手指在哪儿、反馈就在哪儿，不用回头看顶部。
 *
 * ## 手机上为什么不会触发浏览器的「整页下拉刷新」
 *
 * 容器在启用本功能时会带 `overscroll-y-contain`（见 `conversation.tsx` 里 `onRefresh`
 * 那段）：滚到头继续拉不再向祖先/页面链式传递。⚠️ 别去掉那个类 —— 少了它，手机上拉一下
 * 会**整页重载**，比点按钮糟得多。
 *
 * 但那个类管不到**容器自己的** overscroll（iOS 橡皮筋 / Android 拉伸）：手指到底后继续
 * 上推，内容仍会被带着位移、松手回弹，看着就像「指示器一出现消息就自己上滚一小段」。
 * 所以 `touchmove` 注册成 **non-passive**，确认是刷新手势后 `preventDefault()`。
 *
 * ## 「松手才刷新」在两套输入上怎么落地
 *
 * - **触摸**：位移跟手，过阈值转成「松开刷新」，`touchend` 才真正触发。拉过头又反悔？
 *   手指往回推，位移归零、松手什么都不会发生。
 * - **滚轮 / 触控板**：没有 `touchend`，用**滚动停下来**代替松手 —— 到阈值后停稳
 *   `WHEEL_RELEASE_MS` 才触发；期间继续滚就重新计时，往回滚（回看历史）立刻作废。
 *
 * 起手闸 `WHEEL_QUIET_MS` 是另一件事：快速上滑到底时，滚动到尾之后残余的惯性位移仍会
 * 派发 `deltaY`，若照单全收，用户只是「滑到底」就会被刷新。惯性尾巴是每帧连续的
 * （~16ms 一个），永远过不了这道闸；等它停下、用户再主动补一下，才算数。
 *
 * ## 「没松手它自己刷了」「松手了却不刷」——同一处病根
 *
 * 1. **合成 wheel**：有的环境在手指滑动时会同时派发 `wheel`（Windows 触屏、精度触摸板、
 *    部分安卓 WebView），**松手之后还有惯性尾巴**。滚轮那条路的「松手」只是个停顿定时器，
 *    安静 `WHEEL_RELEASE_MS` 就满足条件 → 手指明明没松（或刚松），它自己刷了。
 *    按**时间**挡（`TOUCH_GUARD_MS`），不按「手指是否按着」的布尔挡 —— 布尔在 `touchend`
 *    那一刻就翻了，挡不住尾巴。
 * 2. **手势状态不能住在闭包里**：`attach` 会因依赖换身份而重建，闭包里的 `let` 全部归零。
 *    起点一没，松手就判成「已作废」→ **不刷新**，而 `phase` 是 React state、仍挂着
 *    「松开刷新」。所以状态放 `gestureRef`（hook 级），松手结算只看**指示器当前是不是
 *    armed**，不再看起点还在不在。
 * 3. **`touchcancel`**：长按选中文字 / 弹上下文菜单 / 来电时浏览器会打断手势。它跟
 *    `touchend` 语义相反 —— 处理成「整段作废」，绝不能当成松手去 `run()`。
 *
 * ## 与 `use-stick-to-bottom` 的关系
 *
 * 那个库自己挂的 wheel / touch 监听在 `conversation.tsx` 里另有一套（上滚即退出跟随）。
 * 两套监听互不干扰：这里只读 `scrollHeight` / `scrollTop` 与位移，不改滚动位置。
 */
import { ArrowUp, Loader2 } from 'lucide-react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { useCallback, useEffect, useRef, useState } from 'react'

/** 触发刷新所需的上拉距离（手指位移，已含阻尼） */
export const PULL_THRESHOLD_PX = 64

/** 指示器最多能被拉到多远（超过阈值后不再长，给用户「已经够了」的确定感） */
export const PULL_MAX_PX = 96

/** 阻尼系数：手指走过的位移按这个比例变成指示器位移，拉起来有「绷住」的手感 */
export const PULL_RESISTANCE = 0.5

/** 桌面滚轮触发所需的累计位移：约两格鼠标滚轮，单格误触不会刷新 */
export const WHEEL_THRESHOLD_PX = 140

/**
 * 起手闸：滚轮静默这么久之后的第一个 `deltaY > 0` 才算「用户主动开始拉」。
 * 惯性尾巴是逐帧连续的（~16ms），过不了这道闸（见文件头）。
 */
export const WHEEL_QUIET_MS = 120

/**
 * 滚轮的「松手」：到阈值后静默这么久才真的刷新。
 *
 * 同一个窗口也用于**未到阈值**的手势收尾 —— 停手就归零，避免三次不相干的轻滚累加成一次刷新。
 */
export const WHEEL_RELEASE_MS = 260

/**
 * 碰过屏幕之后这么久之内，滚轮一律不记账。
 *
 * 触屏设备会为滑动**合成** `wheel`（Windows 触屏 / 精度触摸板 / 部分安卓 WebView），
 * 而且不止在手指按住期间 —— **松手之后还有一段惯性尾巴**。只用一个「手指是否按着」的
 * 布尔挡不住尾巴：松手那一刻它就翻了，尾巴继续进来记账，而滚轮的「松手」只是一个停顿
 * 定时器，安静 `WHEEL_RELEASE_MS` 就 `run()`。用户看到的是「上拉完松手没反应，保持几秒
 * 反而自己刷了」。所以按**时间**挡，不是按状态挡。
 */
export const TOUCH_GUARD_MS = 1200

/** 刷新完成后指示器收起前的停留（淡出时间） */
const SETTLE_MS = 220

/**
 * 指示器在 `refreshing` 状态下的**最短**可见时长。
 *
 * ⚠️ 不设这条就会「闪一下」。`reloadConversation` 打的是本机 server，常常几十毫秒就回来了，
 * 加上 `SETTLE_MS` 也就 270ms 左右 —— 手指刚抬起来、眼睛还没落到指示器上，它已经没了，
 * 用户会以为「我拉了一下，什么都不确定」。刷得快是好事，但**必须让人看见它发生了**，
 * 所以宁可按「转满 600ms 再收」处理，不做「完成即收」。
 *
 * 反过来也别加到 1s 以上：那时候接口真的很快，指示器反而在拖时间。
 */
export const MIN_REFRESHING_MS = 600

export type PullPhase = 'idle' | 'pulling' | 'armed' | 'refreshing'

/**
 * 手指上拉位移 → 指示器位移：带阻尼并封顶。
 *
 * 非正数（没在往上推）一律当 0 —— 那是正常的滚动，不是本手势。
 */
export function resistPull(dy: number): number {
  if (!(dy > 0)) return 0
  return Math.min(PULL_MAX_PX, dy * PULL_RESISTANCE)
}

/**
 * 滚轮累计位移的一步。
 *
 * - `deltaY <= 0`（往上滚 = 回看历史）→ 清零：用户放弃了这次上拉；
 * - 已经不在底部 → 清零：手势必须**从底部起手**（中途滚到底不算，那是正常滚动）；
 * - 其余情况累加 `deltaY`（`deltaY > 0` = 往下滚 = 已经到底了还想往后看 = 上拉）。
 */
export function wheelPullStep(accum: number, deltaY: number, atBottom: boolean): number {
  if (!atBottom || !(deltaY > 0)) return 0
  return accum + deltaY
}

/**
 * 触摸手势中途「离开底部」时，要不要把整段作废。
 *
 * 规则：**只有还没攒出位移才作废**。
 *
 * 已经拉到 `armed` 之后再清零，用户看到的就是「明明写着松开刷新、松手却不刷」——
 * 真机上手指按住不动时 `atBottom()` 也会自己翻成 false（iOS overscroll 回弹、安卓
 * 亚像素滚动、DPR 缩放都会让 `scrollHeight - clientHeight - scrollTop` 走出 1px 容差），
 * 一旦在 touchmove 里清零，`touchend` 读到 0 就判成「没过阈值」直接 `reset()`。
 */
export function shouldAbandonPull(hasDistance: boolean, atBottom: boolean): boolean {
  return !atBottom && !hasDistance
}

export interface UsePullToRefreshOptions {
  /** 关掉时**完全不挂监听**（容器工作台那种没有「重拉这条会话」语义的地方） */
  enabled: boolean
  /** 真的去重拉；返回的 Promise 决定指示器转多久 */
  onRefresh: () => Promise<unknown> | unknown
}

export interface PullToRefreshController {
  /**
   * 挂到滚动容器上；由 `conversation.tsx` 的 `attachScroll` 串在最后调用。
   * 返回摘监听函数（`enabled` 为假时不挂，返回 `undefined`）。
   */
  attach: (el: HTMLElement | null) => (() => void) | undefined
  phase: PullPhase
  distance: number
}

export function usePullToRefresh({
  enabled,
  onRefresh
}: UsePullToRefreshOptions): PullToRefreshController {
  const [phase, setPhase] = useState<PullPhase>('idle')
  const [distance, setDistance] = useState(0)
  /**
   * `touchend` 里要读最新位移，但它挂在 `attach` 里（依赖里放 `distance` 会让监听每帧重挂）
   * —— 用一个 ref 兜住。
   */
  const distanceRef = useRef(0)
  /**
   * 触摸手势的状态。
   *
   * ⚠️ **必须放 hook 级，不能写成 `attach` 闭包里的 `let`**。`attach` 的依赖链一路挂到
   * 宿主（`conversation.tsx` 的 `attachScroll` 依赖 `scrollRef` / `stopScroll` /
   * `scrollToBottom`），任何一个换了身份，React 就会 `ref(null)` + `ref(el)`，闭包连同
   * 里面所有 `let` 一起重来。那些 `let` 一归零：
   *   · 手势起点没了 → 松手时判定成「已作废」→ **不刷新**，而 `phase` 是 React state、
   *     仍停在 armed，指示器就一直挂着「松开刷新」；
   *   · 「手指按住」的标记没了 → 合成的 `wheel` 重新记账，手指不动，停顿定时器到点
   *     → **自己刷新**。
   * 这正是「显示松开刷新、松手没反应，按住几秒反而刷了」。状态要活得比闭包长。
   */
  const gestureRef = useRef({
    /** 本次手势的起点 clientY；`null` = 没有进行中的手势 / 本次已作废 */
    startY: null as number | null,
    /** 起手时是否就在底部：中途滚到底不算（那是正常滚动动作） */
    fromBottom: false,
    /** 本次手势已作废（被系统打断 / 起手时就不在底部）：松手不结算 */
    dead: false,
    /**
     * 本次手势已经结算过。`touchend` 与 `pointerup` 都会进来（后者是兜底，见
     * `onTouchEnd`），靠它保证只结算一次。
     */
    settled: false,
    /** 最后一次触摸事件的时刻，用来把滚轮挡在门外（`TOUCH_GUARD_MS`） */
    lastTouchAt: Number.NEGATIVE_INFINITY
  })
  /** 刷新中 / 收尾窗口：期间的任何手势都不记账（否则一圈没转完又起一圈） */
  const busyRef = useRef(false)
  /** 卸载 / 关掉时让在飞的刷新不要 setState */
  const aliveRef = useRef(true)
  /** `onRefresh` 存 ref：调用方多半是内联箭头函数，进依赖会让监听每帧重挂 */
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  /**
   * 被临时关掉（会话进行中）时把现场清干净：监听已摘，但 React state 还在 ——
   * 若用户正拉到 `armed` 或 `refreshing` 时被关掉，等重新启用会突然露出旧指示器。
   */
  useEffect(() => {
    if (enabled) return
    busyRef.current = false
    distanceRef.current = 0
    gestureRef.current.startY = null
    gestureRef.current.fromBottom = false
    gestureRef.current.dead = false
    gestureRef.current.settled = false
    setPhase('idle')
    setDistance(0)
  }, [enabled])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      /*
       * ⚠️ `busyRef` 必须一起清。它是 hook 级的 ref（不随 `attach` 重建），而收尾是挂在
       * 一个 `setTimeout` 里的 —— 恰好在刷新途中卸载（切会话 / 关标签），那个定时器里的
       * `aliveRef` 检查会提前 return，`busyRef` 就**永远停在 true**，此后这个挂载点上
       * 所有上拉都被当成「正在刷新」直接吞掉。表现为「刷过一次之后手势再也不响应」。
       */
      busyRef.current = false
    }
  }, [])

  const attach = useCallback(
    (el: HTMLElement | null) => {
      if (!el || !enabled) return

      /**
       * 到低了没。容差 **3px**：亚像素滚动 + DPR 缩放会让
       * `scrollHeight - clientHeight - scrollTop` 差出 1~2px，1px 容差在手机上会把
       * 「已经到底」判成没到底 —— 起手时判成没到底（`fromBottom = false`）就整段作废，
       * 表现为「手指刚碰上还没动，这一次上拉就已经废了」。
       */
      const atBottom = (): boolean =>
        el.scrollHeight - el.clientHeight - el.scrollTop <= 3

      // 滚轮的「松手」定时器与累计量都活在闭包里，所以 reset / run 要能清掉它们 —— 先声明
      let wheelTimer: number | undefined
      const clearWheelTimer = (): void => {
        if (wheelTimer === undefined) return
        window.clearTimeout(wheelTimer)
        wheelTimer = undefined
      }

      const reset = (): void => {
        if (busyRef.current) return
        // ref 一起归零：拉过阈值又往回推的情况下，`touchend` 读 ref 会误判成「已到阈值」
        distanceRef.current = 0
        setPhase('idle')
        setDistance(0)
      }

      const run = (): void => {
        if (busyRef.current) return
        clearWheelTimer()
        busyRef.current = true
        /**
         * 「转圈」从**这一刻**开始算，不是从 promise resolve 开始 —— 本机接口几十毫秒就回来，
         * 按下限差额补足，指示器才不会「闪一下就没」（见 `MIN_REFRESHING_MS`）。
         */
        const startedAt = performance.now()
        setPhase('refreshing')
        distanceRef.current = PULL_THRESHOLD_PX
        setDistance(PULL_THRESHOLD_PX)
        void Promise.resolve()
          .then(() => onRefreshRef.current())
          .catch(() => {
            // 失败由 `reloadConversation` 自己写进消息区 / toast，这里只负责收起指示器
          })
          .then(() => {
            if (!aliveRef.current) return
            const elapsed = performance.now() - startedAt
            // 下限差额（还没转满就补齐）+ 淡出停留
            const wait = Math.max(0, MIN_REFRESHING_MS - elapsed) + SETTLE_MS
            window.setTimeout(() => {
              if (!aliveRef.current) return
              busyRef.current = false
              distanceRef.current = 0
              setPhase('idle')
              setDistance(0)
            }, wait)
          })
      }

      // ---------------------------------------------------------------------
      // 两条路径互斥
      // ---------------------------------------------------------------------
      /** 滚轮累计量 / 最后一次滚动时刻（触摸起手会清，见下） */
      let wheelAccum = 0
      let lastWheelAt = 0
      /** 这一次连续滚动是否已经「起手」过（起手闸只放行一次，见文件头） */
      let wheelArmed = false

      /** 手势状态全在 `gestureRef`（hook 级，见那段 ⚠️）；这里只取引用 */
      const g = gestureRef.current
      /** 记一次触摸事件：滚轮据此判断「刚碰过屏幕」 */
      const markTouch = (): void => {
        g.lastTouchAt = performance.now()
      }

      // ---------------------------------------------------------------------
      // 触摸（手机 / 触屏本）：手指往上推
      // ---------------------------------------------------------------------
      const onTouchStart = (e: TouchEvent): void => {
        markTouch()
        // 合成出来的 wheel 不能和手指一起记账，起手就先作废一次
        wheelAccum = 0
        wheelArmed = false
        clearWheelTimer()
        if (busyRef.current) {
          // 上一圈还没转完：这次手势不接受，但也别让滚轮趁虚而入（时间戳已记）
          g.dead = true
          g.startY = null
          return
        }
        g.dead = false
        g.settled = false
        g.startY = e.touches[0]?.clientY ?? null
        g.fromBottom = atBottom()
      }

      const onTouchMove = (e: TouchEvent): void => {
        markTouch()
        if (busyRef.current || g.dead || g.startY === null) return
        const y = e.touches[0]?.clientY ?? null
        if (y === null) return
        // 起手就不在底部：这是正常的滚动，整段作废
        if (!g.fromBottom) {
          g.dead = true
          g.startY = null
          reset()
          return
        }
        /*
         * 中途离开了底部（内容被滚走了）。
         *
         * ⚠️ 判据是 `shouldAbandonPull(hasDistance, atBottom)` —— **只有「还没攒出位移」
         * 才作废**。已经拉到 `armed` 之后再因为几何抖动清零，就是「明明写着松开刷新、
         * 松手却不刷」：真机上（iOS overscroll 回弹、安卓亚像素滚动、DPR 缩放）手指按住
         * 不动时 `atBottom()` 也会自己翻成 false，清零到 0 后松手读到 0 → 判成没过阈值
         * → `reset()`，而用户眼睛看到的是上一帧的「松开刷新」。
         *
         * 已经有位移时继续按原起点算：位置回到真底部了自然会继续长，没回去也不会被
         * 中途的几何抖动打断。作废只在「起手就在往上滚历史」时发生，那是上面那段。
         */
        if (shouldAbandonPull(distanceRef.current > 0, atBottom())) {
          g.startY = y
          reset()
          return
        }
        // 手指上移（y 变小）= 往上推 = 正值；`resistPull` 把往回推当 0，
        // 于是「拉过阈值又推回去」会自然归零，松手不会误刷新
        const next = resistPull(g.startY - y)
        /*
         * 确认是刷新手势了，就把默认滚动拦下来。
         *
         * ⚠️ 容器上的 `overscroll-y-contain` 挡不住**容器自己**的 overscroll：它只切断
         * 「继续往祖先链上传递」。手指到底后还往上推，容器内的橡皮筋（iOS bounce /
         * Android 拉伸）照样把内容带着位移，松手再弹回来 —— 用户看到的就是「指示器一
         * 出现，消息列表自己上滚一小段」。指示器本身不背这个锅：外层是 `h-0`，pill 是
         * 向上溢出，向上溢出不计入 `scrollHeight`，撑不到滚动几何。
         *
         * 只在「起手在底部 + 现在仍在底部 + 方向往上推」时拦（上面的守卫已经保证前两条），
         * 其余滚动照旧交给浏览器。注意拦是**粘性**的：iOS 上拦过一次，这次手势的滚动
         * 就没了，反悔往回推也回不来，得松手重滑 —— 这是 pull-to-refresh 的常见代价。
         */
        if (next > 0 && e.cancelable) e.preventDefault()
        // 同步写 ref：`touchend` 可能赶在这一次 setState 的渲染之前到达，那时读 state 会拿到上一帧
        distanceRef.current = next
        setDistance(next)
        setPhase(
          next <= 0 ? 'idle' : next >= PULL_THRESHOLD_PX ? 'armed' : 'pulling'
        )
      }

      /**
       * 松手结算。
       *
       * 判据只有一条：**指示器此刻是不是「松开刷新」**（`distanceRef >= 阈值`）。
       *
       * 上一版还要求「手势起点还在」，于是闭包一重建（起点 `let` 归零）就变成「明明写着
       * 松开刷新，松手却什么也没发生」，指示器还挂在 armed 上不走。`distance` 才是用户
       * 眼睛看到的东西，就按它结算 —— 看到的和发生的一致。
       */
      const onTouchEnd = (): void => {
        markTouch()
        /*
         * 幂等：`touchend` 和 `pointerup` 都会走到这里（后者是兜底 —— 有的浏览器在
         * `touchmove` 被 `preventDefault` 之后不再派发 `touchend`，手势被滚动层接管，
         * 手指抬起只剩 `pointerup`）。谁先到谁结算。
         */
        if (g.settled) return
        // 没起手 / 已作废：不结算（`pointerup` 在纯鼠标操作时也会来）
        if (g.startY === null) return
        g.settled = true
        const armed = distanceRef.current >= PULL_THRESHOLD_PX
        g.startY = null
        g.fromBottom = false
        if (busyRef.current) return
        if (armed) run()
        else reset()
      }

      /**
       * 手势被系统打断：长按选中文字 / 弹出上下文菜单 / 来电 / 被浏览器接管。
       *
       * ⚠️ **绝不能当「松手」处理**。这里原来和 `touchend` 绑的同一个函数：手指拉到阈值后
       * 按住不动，一两秒后触发长按选择，浏览器发 `touchcancel`，位移还停在阈值上 → 直接
       * `run()`。用户看到的就是「我根本没松手，它自己刷了」。打断就是作废，不刷新。
       */
      const onTouchCancel = (): void => {
        markTouch()
        g.dead = true
        g.startY = null
        g.fromBottom = false
        reset()
      }

      // ---------------------------------------------------------------------
      // 滚轮 / 触控板（桌面）：在底部继续往下滚（= 上拉）
      // ---------------------------------------------------------------------
      /** 滚轮的「松手」：停稳 `WHEEL_RELEASE_MS` 后，够阈值就刷新，不够就归零 */
      const armWheelRelease = (): void => {
        clearWheelTimer()
        wheelTimer = window.setTimeout(() => {
          wheelTimer = undefined
          if (wheelAccum >= WHEEL_THRESHOLD_PX) {
            wheelAccum = 0
            wheelArmed = false
            run()
            return
          }
          wheelAccum = 0
          wheelArmed = false
          reset()
        }, WHEEL_RELEASE_MS)
      }

      const onWheel = (e: WheelEvent): void => {
        if (busyRef.current) return
        /*
         * **手指还按在屏幕上（手势进行中）：滚轮一律不算。**
         *
         * `TOUCH_GUARD_MS` 那条只是时间窗，按住超过它之后来的 wheel 就漏过去了 ——
         * 而触摸设备（安卓 WebView / 触屏本）在触摸滚动时确实会合成 wheel。漏过去的那一发
         * 会起「停顿即松手」的定时器：手指一动没动，260ms 后 `run()`，用户看到的就是
         * **「我根本没松手，它自己把状态走完了」**。
         *
         * 手势进行中的结算权只归 `touchend` / `pointerup`，滚轮不能抢。
         */
        if (g.startY !== null) return
        /*
         * 刚碰过屏幕（含松手后那段惯性尾巴）：这条 wheel 多半是触摸滚动合成出来的。
         * 一次也不记账并清掉定时器 —— 那个「停顿即松手」的闸才不会被误触，
         * 手指按住不动、或者刚松手，都不会自己刷（见 `TOUCH_GUARD_MS`）。
         */
        if (performance.now() - g.lastTouchAt < TOUCH_GUARD_MS) {
          wheelAccum = 0
          wheelArmed = false
          clearWheelTimer()
          return
        }
        const now = performance.now()
        const quiet = now - lastWheelAt >= WHEEL_QUIET_MS
        lastWheelAt = now

        if (!(e.deltaY > 0) || !atBottom()) {
          // 往上滚（回看历史）/ 不在底部：整段手势作废
          wheelAccum = 0
          wheelArmed = false
          clearWheelTimer()
          reset()
          return
        }

        // 静默之后的第一下 = 用户主动起手；惯性尾巴（连续帧）进不来
        if (quiet) wheelArmed = true
        if (!wheelArmed) return

        wheelAccum = wheelPullStep(wheelAccum, e.deltaY, true)
        const next = Math.min(
          PULL_MAX_PX,
          (wheelAccum / WHEEL_THRESHOLD_PX) * PULL_THRESHOLD_PX
        )
        distanceRef.current = next
        setDistance(next)
        setPhase(wheelAccum >= WHEEL_THRESHOLD_PX ? 'armed' : 'pulling')

        // 每次滚动都把「松手」往后推：到阈值后停手才刷新，没到阈值停手就归零
        armWheelRelease()
      }

      el.addEventListener('touchstart', onTouchStart, { passive: true })
      /*
       * `passive: false`（**不能省**）：要在确认是刷新手势时 `preventDefault()`，挡掉容器
       * 自己的 overscroll。声明成 passive 的话浏览器会忽略这次 `preventDefault`，而且
       * 控制台只丢一句警告 —— 表现为「改了却还是一样的抖」。
       */
      el.addEventListener('touchmove', onTouchMove, { passive: false })
      el.addEventListener('touchend', onTouchEnd, { passive: true })
      /*
       * `pointerup` 只是兜底（不是第二条路径）：有的浏览器在 `touchmove` 里
       * `preventDefault` 之后不再派发 `touchend`，手势被滚动层接管，手指抬起只剩它。
       * 幂等靠 `g.settled`，同一次抬起只会结算一次。纯鼠标操作时 `startY` 是空的，
       * 进来也直接返回。
       */
      el.addEventListener('pointerup', onTouchEnd, { passive: true })
      el.addEventListener('touchcancel', onTouchCancel, { passive: true })
      el.addEventListener('wheel', onWheel, { passive: true })

      return () => {
        el.removeEventListener('touchstart', onTouchStart)
        el.removeEventListener('touchmove', onTouchMove)
        el.removeEventListener('touchend', onTouchEnd)
        el.removeEventListener('pointerup', onTouchEnd)
        // 与上面注册的必须是**同一个函数引用**，否则摘不掉（旧闭包还挂着，会改回状态）
        el.removeEventListener('touchcancel', onTouchCancel)
        el.removeEventListener('wheel', onWheel)
        clearWheelTimer()
        /*
         * 手势状态**故意不动**：`attach` 可能只是因依赖换了身份而重建（节点还是同一个），
         * 用户的手指还按在屏幕上 —— 起点一清，这次手势就废了，松手又不刷新。
         * 真正的作废由 `touchcancel` 负责。
         */
      }
    },
    [enabled]
  )

  return { attach, phase, distance }
}

export interface PullToRefreshIndicatorProps {
  phase: PullPhase
  distance: number
  className?: string
}

/**
 * 消息区**底部**的上拉指示器。
 *
 * `sticky bottom-0` + 外层 `h-0` + `items-end`：不占布局高度（不能把消息流整体往上顶 ——
 * 那会让每次上拉都触发一次「内容变高」，与 `use-stick-to-bottom` 的跟底打架），但能钉在
 * 滚动区**底边**，子元素从底边往上溢出、随位移露出。
 *
 * 与「回到底部」那颗按钮同一个套路（那边是 `sticky bottom-4` + 负 margin）。
 *
 * ⚠️ `idle` 时**不卸载**，只把 `opacity` 收到 0。卸载是硬切：`distance` 从 30 掉回 0 的
 * 那一帧（拉过阈值又往回推、或刷新收尾）会留下一次「闪一下」，比慢慢淡出扎眼得多。
 * 常驻的代价是一个 `h-0` + `pointer-events-none` 的空壳，不占布局也不挡点击。
 */
export function pullIndicatorOffset(phase: PullPhase, distance: number): number {
  /*
   * 位移**只能向上**（≤ 0）：-18px（收在底边上方）→ -6px（整颗露出来）。
   *
   * ⚠️ 原来 idle 是 `+12px`（"藏到底边外的下方"），而在这个滚动容器里 `translateY`
   * 正方向就是**向下溢出** —— 向下溢出会计入 `scrollHeight`。于是这个 `h-0` 空壳给消息区
   * 凭空多出 12px 滚动高度：贴底位置被抬到「内容底部 + 12」；一上拉位移转负、向下溢出
   * 消失，`scrollHeight` 少 12px，浏览器为维持贴底把 `scrollTop` 同步减 12 —— 用户看到的
   * 就是「指示器一出现，消息列表自己往上滚一小段」。
   *
   * 收起时本来就靠 `opacity: 0` 看不见，向下那 12px 没有任何视觉收益，改成向上藏。
   * `pull-to-refresh.test.ts` 有一条断言把这个不变量钉住。
   */
  if (phase === 'refreshing') return -6
  const progress = Math.min(1, distance / PULL_THRESHOLD_PX)
  return -6 - 12 * (1 - progress)
}

export function PullToRefreshIndicator({
  phase,
  distance,
  className
}: PullToRefreshIndicatorProps) {
  const tr = useT()
  const refreshing = phase === 'refreshing'
  const armed = phase === 'armed'
  const offset = pullIndicatorOffset(phase, distance)
  const opacity = refreshing ? 1 : Math.min(1, distance / (PULL_THRESHOLD_PX * 0.6))
  return (
    <div
      className="pointer-events-none sticky bottom-0 z-20 flex h-0 items-end justify-center overflow-visible"
      // 收起时对读屏隐藏，否则「上拉刷新」这行字会一直被念到
      aria-hidden={phase === 'idle'}
    >
      <div
        style={{ transform: `translateY(${offset}px)`, opacity }}
        // 只留读屏能听到的一句（`aria-hidden` 在收起时已挡掉）
        role="status"
        aria-live="polite"
        className={cn(
          'flex items-center gap-1.5 rounded-full border bg-popover px-2.5 py-1 text-xs text-muted-foreground shadow-md',
          // 位移与透明度都走过渡：松手瞬间从「松开刷新」跳到「正在刷新」不会硬切
          'transition-[transform,opacity] duration-150 ease-out',
          armed && 'text-foreground',
          className
        )}
      >
        {refreshing ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <ArrowUp
            className="size-3.5 transition-transform"
            style={{ transform: `rotate(${armed ? 180 : 0}deg)` }}
          />
        )}
        {refreshing ? tr('正在刷新…') : armed ? tr('松开刷新') : tr('上拉刷新')}
      </div>
    </div>
  )
}
