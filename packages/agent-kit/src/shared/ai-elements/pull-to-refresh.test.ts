/**
 * 消息区**上拉**刷新的纯逻辑。
 *
 * 监听那一层依赖真实 DOM 的 `scrollTop` / `scrollHeight` 与触摸序列，仓库没有 jsdom（见
 * AGENTS.md「测试」一节），所以这里只钉三处**改坏了也只会「手感变怪」、很难从现象反查**
 * 的地方：
 *
 * 1. 手指位移怎么换算成指示器距离（阻尼、封顶、反向归零）；
 * 2. 滚轮累计什么时候作废 —— 方向搞反了会变成「滚到一半就刷新」，而 `deltaY` 的正负
 *    是最容易在改动里被翻错的一处；
 * 3. 「松手才刷新」的几个时间常量：起手闸（防惯性）、停手判定（桌面没有 touchend）、
 *    以及触摸后把滚轮关在门外的那段冷却（防合成 wheel 的惯性尾巴自己触发刷新）；
 * 4. 指示器位移的正负号 —— 正位移是**向下溢出**，会计入 `scrollHeight`（见
 *    `pullIndicatorOffset` 的注释），搞反了表现为「一上拉消息列表自己滚一下」。
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_REFRESHING_MS,
  PULL_MAX_PX,
  PULL_RESISTANCE,
  PULL_THRESHOLD_PX,
  TOUCH_GUARD_MS,
  WHEEL_QUIET_MS,
  WHEEL_RELEASE_MS,
  WHEEL_THRESHOLD_PX,
  pullIndicatorOffset,
  resistPull,
  shouldAbandonPull,
  wheelPullStep
} from './pull-to-refresh'

describe('resistPull：手指上拉位移 → 指示器位移', () => {
  it('按阻尼系数缩小，拉起来才有「绷住」的手感', () => {
    expect(resistPull(40)).toBe(40 * PULL_RESISTANCE)
    expect(resistPull(40)).toBeLessThan(40)
  })

  it('封顶：超过 PULL_MAX_PX 就不再长（给用户「已经够了」的确定感）', () => {
    expect(resistPull(10_000)).toBe(PULL_MAX_PX)
    expect(resistPull(PULL_MAX_PX / PULL_RESISTANCE + 1)).toBe(PULL_MAX_PX)
  })

  it('往回推（手指往下）归零 —— 那是正常滚动，也是「反悔」的唯一方式', () => {
    expect(resistPull(-1)).toBe(0)
    expect(resistPull(-500)).toBe(0)
  })

  it('0 / NaN 都归零，脏值不会渗到指示器位移里', () => {
    expect(resistPull(0)).toBe(0)
    expect(resistPull(Number.NaN)).toBe(0)
  })
})

describe('wheelPullStep：桌面在底部继续下滚的累计', () => {
  it('在底部且 deltaY > 0（已经到底了还想往后看 = 上拉）→ 累加', () => {
    expect(wheelPullStep(0, 60, true)).toBe(60)
    expect(wheelPullStep(60, 90, true)).toBe(150)
  })

  it('deltaY <= 0（往上滚 = 回看历史）→ 清零', () => {
    expect(wheelPullStep(80, -40, true)).toBe(0)
    // 到底时浏览器会给 deltaY = 0，同样算「没在拉」
    expect(wheelPullStep(80, 0, true)).toBe(0)
  })

  it('不在底部一律清零：手势必须从底部起手，中途滚到底不算', () => {
    expect(wheelPullStep(80, 60, false)).toBe(0)
  })
})

describe('常量关系', () => {
  it('封顶必须大于阈值，否则指示器永远够不到触发线', () => {
    expect(PULL_MAX_PX).toBeGreaterThan(PULL_THRESHOLD_PX)
  })

  it('滚轮阈值明显大于手指阈值：鼠标一格滚轮（≈100px）不该直接触发刷新', () => {
    expect(WHEEL_THRESHOLD_PX).toBeGreaterThan(100)
    expect(WHEEL_THRESHOLD_PX).toBeGreaterThan(PULL_THRESHOLD_PX)
  })

  it('起手闸要大于一帧（16ms）—— 惯性尾巴是逐帧连续的，必须卡在它之外', () => {
    expect(WHEEL_QUIET_MS).toBeGreaterThan(16 * 4)
  })

  it('停手判定不能比起手闸还灵敏：刚过阈值就松手，也要真的刷新', () => {
    expect(WHEEL_RELEASE_MS).toBeGreaterThan(WHEEL_QUIET_MS)
    // 但也不能拖太久 —— 用户会觉得「怎么停手了还不刷新」
    expect(WHEEL_RELEASE_MS).toBeLessThan(600)
  })

  it('「正在刷新」有最短可见时长：否则本机接口几十毫秒回来就是闪一下', () => {
    // 低于 400ms 人眼基本只看到一个闪动，等于没提示
    expect(MIN_REFRESHING_MS).toBeGreaterThanOrEqual(400)
    // 高于 1s 就开始「拖时间」了 —— 刷得快的时候用户会盯着没必要的转圈
    expect(MIN_REFRESHING_MS).toBeLessThan(1000)
  })

  it('触摸后的滚轮冷却必须盖住「惯性尾巴 + 停顿判定」，否则按住不动也会自己刷', () => {
    /*
     * 合成 wheel 的尾巴是「松手后还要连着来几十到几百毫秒」，而滚轮那条路只要安静
     * `WHEEL_RELEASE_MS` 就结算 —— 冷却期必须比这两段加起来长，尾巴才能整段被挡掉。
     */
    expect(TOUCH_GUARD_MS).toBeGreaterThan(WHEEL_RELEASE_MS * 2)
    // 但也不能长到让「摸完屏幕改用鼠标滚轮」的人以为滚轮坏了
    expect(TOUCH_GUARD_MS).toBeLessThanOrEqual(2000)
  })

  it('指示器位移必须恒 ≤ 0：正位移是向下溢出，会撑高 scrollHeight 让列表自己上滚', () => {
    /*
     * 那个空壳是 `sticky bottom-0 h-0`，pill 从底边溢出。**向上**溢出属于 ink overflow、
     * 不进滚动几何；**向下**溢出进 —— 12px 的向下溢出就是 12px 的 `scrollHeight`。
     * 一上拉位移转负、这 12px 消失，浏览器维持贴底就会把 `scrollTop` 减 12。
     * 真机实测（CDP 逐帧读 scrollTop）差值正是这 12px。
     */
    for (const distance of [0, 1, 20, PULL_THRESHOLD_PX, PULL_MAX_PX]) {
      expect(pullIndicatorOffset('idle', distance)).toBeLessThanOrEqual(0)
      expect(pullIndicatorOffset('pulling', distance)).toBeLessThanOrEqual(0)
      expect(pullIndicatorOffset('armed', distance)).toBeLessThanOrEqual(0)
    }
    expect(pullIndicatorOffset('refreshing', 0)).toBeLessThanOrEqual(0)
    // 收起时要真的收在底边上方，否则 pill 会露出半截
    expect(pullIndicatorOffset('idle', 0)).toBeLessThanOrEqual(-12)
  })
})

describe('shouldAbandonPull：中途「离开底部」要不要清零', () => {
  it('起手就往回滚历史：还没位移，作废', () => {
    expect(shouldAbandonPull(false, false)).toBe(true)
  })

  it('已经拉到 armed 之后 atBottom() 抖动：不能作废，否则松手不刷', () => {
    /*
     * 真机上手指按住不动，`atBottom()` 也会因为 overscroll 回弹 / 亚像素滚动翻成 false。
     * 这里要是返回 true，touchmove 就把 distance 清 0 —— 用户眼睛看到「松开刷新」，
     * 松手时读到的却是 0，判成没过阈值 → 直接 reset，什么也不发生。
     */
    expect(shouldAbandonPull(true, false)).toBe(false)
  })

  it('还在底部：怎么都不作废', () => {
    expect(shouldAbandonPull(false, true)).toBe(false)
    expect(shouldAbandonPull(true, true)).toBe(false)
  })
})
