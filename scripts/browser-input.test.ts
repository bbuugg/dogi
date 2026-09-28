/**
 * `features/agent/browser-input.ts` 的纯函数单测 —— 跑的是**真源码**，不是手抄副本。
 *
 * 为什么能直接用 `node --experimental-strip-types` 跑（不需要 `.tooltest` 包装）：
 * 该文件只有 `import type { ... } from '@shared/types'`（类型导入会被擦除），
 * 没有无扩展名的相对 import、也没有 `@shared/*` 别名 —— 解析得通。
 *
 *   node --experimental-strip-types scripts/browser-input.test.ts
 *
 * 重点覆盖 **object-contain 留白** 的坐标映射：视口固定成预设之后，面板宽高比
 * 和视口宽高比不再一致，图片上下/左右会留黑边。元素 rect ≠ 画面 rect，
 * 拿元素 rect 映射坐标会导致点击**整体偏移**，偏移量随离中心的距离线性增长。
 */
import { containedRect, toPageCoords, wheelEvent } from '../src/renderer/src/features/agent/browser-input.ts'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const near = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) < eps

// 真实尺寸（自动化页在 1920×1080 / 200% DPI 窗口下的实测值）：
// 浏览器面板 731×560，PC 视口预设 1280×800 → 上下各约 51.6px 黑边
const PANE = { left: 0, top: 0, width: 731, height: 560 }
const PC = { width: 1280, height: 800 }
const MOBILE = { width: 390, height: 844 }

// ---------------------------------------------------------------------------
// containedRect：等比缩进 + 居中
// ---------------------------------------------------------------------------
const pc = containedRect(PANE, PC)
console.log('PC 画面矩形:', JSON.stringify(pc))
check('PC：等比缩进后宽度铺满面板', near(pc.width, 731, 0.5), `width=${pc.width.toFixed(2)}`)
check('PC：高度按比例缩到 456.88', near(pc.height, 456.875, 0.5), `height=${pc.height.toFixed(2)}`)
check('PC：上下黑边各约 51.56（居中）', near(pc.top, 51.5625, 0.5), `top=${pc.top.toFixed(2)}`)

const mobile = containedRect(PANE, MOBILE)
console.log('手机画面矩形:', JSON.stringify(mobile))
check(
  '手机：纵向铺满、左右留白（柱状黑边）',
  near(mobile.height, 560, 0.5) && mobile.width < 300 && near(mobile.left, (731 - mobile.width) / 2, 0.5),
  `w=${mobile.width.toFixed(2)} left=${mobile.left.toFixed(2)}`
)

// 宽高比一致时不应该有任何留白（别把「本来就对」的情况改坏）
const same = containedRect({ left: 0, top: 0, width: 640, height: 400 }, PC)
check(
  '宽高比一致时画面矩形 = 元素矩形（无留白）',
  near(same.left, 0) && near(same.top, 0) && near(same.width, 640) && near(same.height, 400)
)

// ---------------------------------------------------------------------------
// toPageCoords：回归用例 —— 点画面底部，不能打到上面去
// ---------------------------------------------------------------------------
// 页面 y=700 在屏幕上应该落在画面矩形内的这个位置
const clientY = pc.top + (700 / PC.height) * pc.height
const correct = toPageCoords(0, clientY, pc, PC)
// 用**元素 rect** 算会得到什么（这就是修复前的行为）
const buggyY = ((clientY - PANE.top) / PANE.height) * PC.height

console.log(`点页面 y=700 → 屏幕 y=${clientY.toFixed(2)}；正确映射=${correct?.y.toFixed(2)}；元素 rect 映射=${buggyY.toFixed(2)}`)
check('画面矩形的映射结果 ≈ 700（点哪就是哪）', Boolean(correct && near(correct.y, 700, 0.5)))
check(
  '用元素 rect 会偏 45px 以上（这就是用户报的偏移）',
  Math.abs(buggyY - 700) > 45,
  `偏差 ${(700 - buggyY).toFixed(1)}px`
)

// 画面四角必须精确落在视口四角
const tl = toPageCoords(pc.left, pc.top, pc, PC)
const br = toPageCoords(pc.left + pc.width, pc.top + pc.height, pc, PC)
check('画面左上角 → 视口 (0,0)', Boolean(tl && near(tl.x, 0, 0.5) && near(tl.y, 0, 0.5)))
check(
  '画面右下角 → 视口 (1280,800)',
  Boolean(br && near(br.x, 1280, 0.5) && near(br.y, 800, 0.5)),
  br ? `(${br.x.toFixed(1)}, ${br.y.toFixed(1)})` : ''
)

// 中心对中心（偏移量最小的地方，两种算法在这里一致 —— 所以只测中心是抓不到这个 bug 的）
const center = toPageCoords(pc.left + pc.width / 2, pc.top + pc.height / 2, pc, PC)
check('画面中心 → 视口中心 (640,400)', Boolean(center && near(center.x, 640, 0.5) && near(center.y, 400, 0.5)))

// ---------------------------------------------------------------------------
// 黑边里的点要丢掉，不能转发成页面边缘的坐标
// ---------------------------------------------------------------------------
check('顶部黑边里的点击被丢掉', toPageCoords(0, 10, pc, PC) === null)
check('底部黑边里的点击被丢掉', toPageCoords(0, 550, pc, PC) === null)
check('画面内的点击正常转发', toPageCoords(0, 300, pc, PC) !== null)

// 手机视口下左右黑边同理
check('手机视口：左侧黑边里的点击被丢掉', toPageCoords(5, 280, mobile, MOBILE) === null)

// ---------------------------------------------------------------------------
// 滚轮走同一套映射
// ---------------------------------------------------------------------------
const wheel = wheelEvent({ clientX: pc.left + pc.width / 2, clientY: clientY, deltaX: 0, deltaY: 120 }, pc, PC, 0)
check(
  '滚轮坐标同样按画面矩形映射',
  Boolean(wheel && wheel.kind === 'wheel' && near(wheel.y, 700, 0.5)),
  wheel && wheel.kind === 'wheel' ? `y=${wheel.y.toFixed(1)}` : ''
)
check('黑边上的滚轮被丢掉', wheelEvent({ clientX: 0, clientY: 10, deltaX: 0, deltaY: 120 }, pc, PC, 0) === null)

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
