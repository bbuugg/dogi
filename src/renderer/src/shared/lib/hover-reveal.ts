/**
 * 「行尾浮层一压上来，名字就被截断」的补偿：hover 整行时让名字自己滑到行尾。
 *
 * 侧栏本来就窄，会话 / 项目行尾那几个按钮（归档 / 重命名 / 删除 / 新建会话 …）是 hover
 * 才浮现的浮层，一浮上来就给名字让出 `pe-20` / `pe-14`（见 `SIDEBAR_ROW_NAME`），长名字
 * 于是变成「前半截…」。看得到多少不该取决于鼠标在不在上面 —— 所以 hover 时把名字滑到
 * 行尾（跑马灯），移开复位。（对齐 fishwork `agent-ui/src/lib/hover-reveal.ts`。）
 *
 * 几个刻意的选择：
 *
 * 1. **用滚动（`scrollLeft`）而不是 `transform`**：名字那个 `span` 本来就是 `truncate`
 *    （`overflow: hidden`），而 `overflow: hidden` 的盒子**依旧是滚动容器**，`scrollLeft`
 *    可以直接用，静止时的省略号也照旧（滑动期间怎么处理见第 5 条）。换成 `transform` 就得
 *    拆成「外层裁剪 + 内层位移」两层 DOM，内层一动，`text-overflow: ellipsis` 就没了
 *    （它只对行内内容生效）。
 *
 * 2. **滑到哪由文字真实右缘算**，不用 `scrollWidth - clientWidth`：后者对「末尾 padding
 *    算不算可滚动区域」的语义各浏览器不一致（Chromium 算、Firefox 不算），而这里要让文字
 *    尾巴正好停在**内容盒右缘** —— 也就是浮层让位出来的那一段之前，否则尾巴会被浮层自带的
 *    渐隐底色盖住。`Range` 量到的是布局几何，不受裁剪影响。
 *
 * 3. **自己用 rAF 做动画**，不用 `scrollTo({ behavior: 'smooth' })`：后者在
 *    `overflow: hidden` 的容器上是否动起来，取决于浏览器/合成器实现（不动就是「瞬间跳到位」，
 *    那就不是跑马灯了）。自己做还顺带拿到了「恒定速度」和打断控制。
 *
 * 4. **只在真的被截断时才动**，否则短名字 hover 会左右抽一下。
 *
 * 5. **滑动期间要把省略号摘掉**（`text-overflow: clip`，鼠标一离开就还回来）：`truncate` 的
 *    「…」不是 DOM 字符，而是浏览器**按行**画的 —— 只要这一行仍然溢出内容盒，它就一直在画，
 *    与盒子滚到哪儿无关。滚动只移动内容、不改变「溢出了」这个事实，所以「…」会跟着内容往左
 *    走：滑到行尾时挂在名字后面（看着像名字本身就以「…」结尾），滑到一半甚至落在可见文字的
 *    中间。滚动期间文字是全的，那个省略号纯属误导。静止（没 hover）时保留它 —— 那是「这名
 *    字被截断了」的唯一提示。
 *
 * 6. **只有去程是动画，复位是瞬间**：滑到行尾是为了补偿浮层占掉的那段宽度；鼠标一走、浮层
 *    消失，这一行就该立刻回到「行首 + …」，再花半秒到两秒滑回去，看起来就是「鼠标都走了，
 *    名字还赖在行尾」。复位是撤销，不是过渡。
 *
 * ⚠️ 测量必须等让位 padding 落地：`transition-[padding]` 有过渡，hover 当拍量到的还是旧宽度，
 * 所以延迟 `HOLD_MS` 再量（顺带滤掉「鼠标只是扫过一行」的情况）。
 *
 * ⚠️ 触摸端（`max-md`）按钮常显、名字**一直**被截，但那里没有 hover 态，这套不会触发 ——
 * 要覆盖触屏得另给一条「点按展开」的交互，本次不做。
 *
 * 用法（行元素 = 带 `group` 类的那个盒子）：
 * ```tsx
 * <div
 *   className="group relative ..."
 *   onMouseEnter={(e) => revealTruncatedName(e.currentTarget)}
 *   onMouseLeave={(e) => resetTruncatedName(e.currentTarget)}
 * >
 *   <span data-name-text className="min-w-0 flex-1 truncate ...">{title}</span>
 *   <SidebarRowActions>…</SidebarRowActions>
 * </div>
 * ```
 */

/** 名字元素上的标记：行里可能有多个子元素，靠它定位「要被滑动的那个」 */
const NAME_SELECTOR = '[data-name-text]'

/** hover 稳定这么久才开始滑：让位过渡走完才量得准，也避免鼠标扫过时白滑一下 */
const HOLD_MS = 180
/** 滑行速度（px/s）。恒速：距离多长就滑多久，不设时长上下限（钳了就不叫恒速了） */
const SPEED_PX_PER_S = 60
/** 溢出小于这个值当作「没截断」（亚像素误差 / 恰好一个省略号的宽度） */
const SLACK_PX = 2

/** 还没到点的那次「开始滑」 */
const pending = new WeakMap<HTMLElement, number>()
/** 正在跑的那次滑动：值是取消函数 */
const running = new WeakMap<HTMLElement, () => void>()

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function cancel(el: HTMLElement): void {
  const timer = pending.get(el)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    pending.delete(el)
  }
  running.get(el)?.()
  running.delete(el)
}

/**
 * 把名字滑到行尾还差多少像素。
 *
 * = 文字右缘 − 内容盒右缘：没截断时是负数或 0（那就什么都不做）。
 * 量的是 `scrollLeft` 的**增量**，所以元素已经滑到一半时再量也成立。
 */
function tailDistance(el: HTMLElement): number {
  const range = document.createRange()
  range.selectNodeContents(el)
  const text = range.getBoundingClientRect()
  const box = el.getBoundingClientRect()
  const padEnd = Number.parseFloat(window.getComputedStyle(el).paddingInlineEnd) || 0
  return text.right - (box.right - padEnd) - el.scrollLeft
}

function animateScrollLeft(el: HTMLElement, to: number): void {
  const from = el.scrollLeft
  if (Math.abs(to - from) < 1) return
  // 减少动态效果：不滑，直接到位（内容照样看得到，只是没有动画）
  if (prefersReducedMotion()) {
    el.scrollLeft = to
    return
  }
  const started = performance.now()
  const ms = (Math.abs(to - from) / SPEED_PX_PER_S) * 1000
  let raf = window.requestAnimationFrame(function step(now) {
    // 线性插值 = 恒定速度（缓动函数会带来先慢后快再慢的「加速度」感）
    const t = Math.min(1, (now - started) / ms)
    el.scrollLeft = from + (to - from) * t
    if (t < 1) raf = window.requestAnimationFrame(step)
    else running.delete(el)
  })
  running.set(el, () => window.cancelAnimationFrame(raf))
}

/**
 * 鼠标进入某一行（会话行 / 项目行）时调用：该行的名字若被截断，延迟一点滑到行尾。
 *
 * @param row 行元素（即 `group` 那个盒子），内部用 `[data-name-text]` 找名字
 */
export function revealTruncatedName(row: HTMLElement | null | undefined): void {
  const el = row?.querySelector<HTMLElement>(NAME_SELECTOR)
  if (!el) return
  cancel(el)
  pending.set(
    el,
    window.setTimeout(() => {
      pending.delete(el)
      const distance = tailDistance(el)
      if (distance <= SLACK_PX) return
      // 开滑之前先摘掉「…」（它是按行画的、会跟着内容一起往左跑，见文件头第 5 条）
      el.style.textOverflow = 'clip'
      // 不自己夹上限：超出可滚动范围时浏览器会把 scrollLeft 钳到最大值
      animateScrollLeft(el, el.scrollLeft + distance)
    }, HOLD_MS)
  )
}

/**
 * 鼠标离开那一行时调用：**立刻**回到行首 + 立刻把省略号还回来，不做回程动画。
 *
 * 让位 padding 一撤，这一行就该回到「行首 + …」的原样；再花半秒到两秒滑回去，看起来就是
 * 「鼠标都走了，名字还赖在行尾」——而且那段时间文字仍在动，省略号还得跟着一起藏。复位是
 * 「撤销」，不是「过渡」，直接跳最干脆。
 */
export function resetTruncatedName(row: HTMLElement | null | undefined): void {
  const el = row?.querySelector<HTMLElement>(NAME_SELECTOR)
  if (!el) return
  cancel(el)
  el.scrollLeft = 0
  el.style.textOverflow = ''
}
