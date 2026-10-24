/**
 * 场景光栅化（移植自 `console/apps/captcha` 的 `scene.go`，零依赖、不用 canvas / 图形库）。
 *
 * 场景是一个**解析函数** `sampleScene(x, y)`（渐变底 + 光斑 + 方块 + 斜线），不是一张位图。
 * 于是：
 * - 背景图：逐像素采样 `sampleScene(x, y)`，再把缺口处压暗；
 * - 拼图块：逐像素采样 `sampleScene(targetX + lx, pieceY + ly)`，再按形状裁切。
 *
 * 两者采样的是同一个函数，所以拼图块拖到真缺口处时与背景**像素级严丝合缝** —— 这也是
 * 「拼图块与背景必须吃同一个 seed」的原因（`mulberry32`）。
 *
 * ── 抗锯齿 ─────────────────────────────────────────────────────────────────
 * 形状（拼图块轮廓、缺口、内圈描边/虚线）一律走「SDF + 每像素 4×4 超采样」求覆盖率。
 * 早期版本用硬阈值（`d > -1.6`）裁描边，描边内侧边界是一级级台阶，就是俗称的「毛边」；
 * 现在描边的内外两侧都由子样本占比给出过渡，圆角与圆形凸起也是 17 级灰度，边缘干净。
 *
 * 场景图元（光斑 / 方块 / 斜线）用解析覆盖率抗锯齿（每个图元本身就等价于一个 SDF），
 * 不需要超采样，成本只是把原来的 `if` 换成一次 clamp。
 */
import { mulberry32 } from './prng'

/** 每像素超采样网格边长（4 → 每像素 16 个子样本 → 17 级覆盖率） */
const SS_GRID = 4
/** 场景图元解析抗锯齿的过渡带总宽（px） */
const AA_WIDTH = 1.0

/** 缺口处压暗到原亮度的比例 */
const NOTCH_DIM = 0.42
/** 缺口内圈虚线的白度 */
const NOTCH_DASH_ALPHA = 0.9
/** 拼图块内圈描边的白度 */
const RING_ALPHA = 0.9

/** 描边 / 虚线的宽度（px）。随拼图块尺寸缩放，太小的块描边不会糊成一片。 */
export function ringWidth(pieceSize: number): number {
  return Math.min(3.0, Math.max(1.6, pieceSize * 0.05))
}

/** 第 i 个子样本在像素内的相对偏移（0..1） */
function subOffset(i: number): number {
  return (i + 0.5) / SS_GRID
}

/** 把「到边界的距离 d」换算成覆盖率：d <= -aa/2 完全在内，d >= aa/2 完全在外 */
function coverage(d: number): number {
  return clamp01(0.5 - d / AA_WIDTH)
}

type Rgb = readonly [number, number, number]

interface Blob {
  cx: number
  cy: number
  r: number
  color: Rgb
  alpha: number
}

interface RotRect {
  cx: number
  cy: number
  hw: number
  hh: number
  cos: number
  sin: number
  color: Rgb
  alpha: number
}

interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
  half: number
  color: Rgb
  alpha: number
}

interface Scene {
  width: number
  height: number
  from: Rgb
  to: Rgb
  blobs: Blob[]
  rects: RotRect[]
  lines: Segment[]
}

/** 调色板（与 fizz 早年 TS 版的 PALETTE_HEX 一致） */
const PALETTE: readonly Rgb[] = [
  [249, 115, 22],
  [251, 113, 133],
  [168, 85, 247],
  [99, 102, 241],
  [14, 165, 233],
  [16, 185, 129],
  [245, 158, 11],
  [239, 68, 68],
  [20, 184, 166],
  [139, 92, 246]
]

const WHITE: Rgb = [255, 255, 255]

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** 由 seed 生成场景（同 seed 必然同场景）。 */
export function createScene(seed: number, width: number, height: number): Scene {
  const rng = mulberry32(seed)
  const pick = (): Rgb => PALETTE[Math.trunc(rng() * PALETTE.length)]!

  const blobs: Blob[] = []
  for (let i = 0; i < 5; i++) {
    blobs.push({
      cx: rng() * width,
      cy: rng() * height,
      r: 20 + rng() * 60,
      color: pick(),
      alpha: 0.18 + rng() * 0.25
    })
  }

  const rects: RotRect[] = []
  for (let i = 0; i < 5; i++) {
    const rot = ((rng() * 60 - 30) * Math.PI) / 180
    rects.push({
      cx: rng() * width,
      cy: rng() * height,
      hw: (12 + rng() * 36) / 2,
      hh: (12 + rng() * 36) / 2,
      cos: Math.cos(rot),
      sin: Math.sin(rot),
      color: pick(),
      alpha: 0.12 + rng() * 0.22
    })
  }

  const lines: Segment[] = []
  for (let i = 0; i < 6; i++) {
    const x = rng() * width
    const y = rng() * height
    const l = 30 + rng() * 80
    lines.push({
      x1: x,
      y1: y,
      x2: x + l,
      y2: y - l,
      half: (1 + rng() * 2) / 2,
      color: WHITE,
      alpha: 0.1 + rng() * 0.2
    })
  }

  return {
    width,
    height,
    from: pick(),
    to: pick(),
    blobs,
    rects,
    lines
  }
}

/** 点到线段的距离。 */
function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const vx = x2 - x1
  const vy = y2 - y1
  const wx = px - x1
  const wy = py - y1
  const len2 = vx * vx + vy * vy
  const t = len2 > 0 ? clamp01((wx * vx + wy * vy) / len2) : 0
  const dx = wx - vx * t
  const dy = wy - vy * t
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * 采样场景颜色。每个图元都带解析抗锯齿，且**同一坐标必然得到同一颜色** ——
 * 这是拼图块与缺口严丝合缝的前提。
 */
export function sampleScene(s: Scene, x: number, y: number): [number, number, number] {
  const t = clamp01((x / s.width + y / s.height) * 0.5)
  let r = s.from[0] + (s.to[0] - s.from[0]) * t
  let g = s.from[1] + (s.to[1] - s.from[1]) * t
  let b = s.from[2] + (s.to[2] - s.from[2]) * t

  for (const sb of s.blobs) {
    const dx = x - sb.cx
    const dy = y - sb.cy
    const dd = dx * dx + dy * dy
    const outer = sb.r + AA_WIDTH
    if (dd > outer * outer) continue
    const a = sb.alpha * coverage(Math.sqrt(dd) - sb.r)
    if (a <= 0) continue
    r += (sb.color[0] - r) * a
    g += (sb.color[1] - g) * a
    b += (sb.color[2] - b) * a
  }

  for (const sr of s.rects) {
    const dx = x - sr.cx
    const dy = y - sr.cy
    const lx = dx * sr.cos + dy * sr.sin
    const ly = -dx * sr.sin + dy * sr.cos
    // 轴对齐盒的 SDF：正值 = 在盒外多少
    const out = Math.max(Math.abs(lx) - sr.hw, Math.abs(ly) - sr.hh)
    if (out > AA_WIDTH) continue
    const a = sr.alpha * coverage(out)
    if (a <= 0) continue
    r += (sr.color[0] - r) * a
    g += (sr.color[1] - g) * a
    b += (sr.color[2] - b) * a
  }

  for (const sl of s.lines) {
    const d = distToSegment(x, y, sl.x1, sl.y1, sl.x2, sl.y2) - sl.half
    if (d > AA_WIDTH) continue
    const a = sl.alpha * coverage(d)
    if (a <= 0) continue
    r += (sl.color[0] - r) * a
    g += (sl.color[1] - g) * a
    b += (sl.color[2] - b) * a
  }

  return [r, g, b]
}

/**
 * 拼图块形状的有向距离（局部坐标，左上角 0,0）：圆角方块 ∪ 右侧圆形凸起。
 * 负值 = 内部（数值 = 到边界的距离），用于裁切、描边、抗锯齿。
 */
export function pieceSdf(lx: number, ly: number, size: number, radius: number, tab: number): number {
  const r = Math.max(1, Math.min(radius, Math.floor(size / 4)))
  const t = Math.max(1, Math.min(tab, Math.floor(size / 2 - r - 1)))
  const fs = size

  const nx = Math.min(Math.max(lx, r), fs - r)
  const ny = Math.min(Math.max(ly, r), fs - r)
  const rectD = Math.sqrt((lx - nx) * (lx - nx) + (ly - ny) * (ly - ny)) - r
  const tabD = Math.sqrt((lx - fs) * (lx - fs) + (ly - fs / 2) * (ly - fs / 2)) - t
  return Math.min(rectD, tabD)
}

export interface RasterInput {
  scene: Scene
  width: number
  height: number
  targetX: number
  pieceY: number
  pieceSize: number
  radius: number
  tab: number
  decoys: Array<{ x: number; y: number }>
}

/**
 * 返回 (x,y) 到「真缺口 ∪ 所有干扰缺口」的距离（负值在内部）。
 *
 * 远离的干扰缺口用包围盒剪枝掉：它们只会给出正距离，不影响覆盖率是否为 0。
 */
function notchSdf(input: RasterInput, x: number, y: number): number {
  let d = pieceSdf(x - input.targetX, y - input.pieceY, input.pieceSize, input.radius, input.tab)
  for (const dc of input.decoys) {
    if (
      x < dc.x - 1 ||
      x > dc.x + input.pieceSize + input.tab + 1 ||
      y < dc.y - 1 ||
      y > dc.y + input.pieceSize + 1
    ) {
      continue
    }
    const dd = pieceSdf(x - dc.x, y - dc.y, input.pieceSize, input.radius, input.tab)
    if (dd < d) d = dd
  }
  return d
}

/**
 * 缺口内圈虚线在 (px,py) 处的强度：沿对角线 14px 一个周期（亮 7 / 暗 7），
 * 亮暗交界处留 0.3 个相位的过渡，避免虚线自己又变成硬边。
 */
function dashMask(px: number, py: number): number {
  let u = ((px + py) / 7) % 2
  if (u < 0) u += 2
  const e = 0.3
  if (u < 1 - e) return 1
  if (u < 1 + e) return (1 + e - u) / (2 * e)
  if (u < 2 - e) return 0
  return (u - (2 - e)) / (2 * e)
}

/**
 * 渲染背景图：场景 + 若干干扰缺口 + 真缺口（内部压暗、边缘白色虚线）。
 * 返回 `width * height * 4` 的 RGBA 缓冲。
 */
export function renderBackground(input: RasterInput): Uint8Array {
  const w = input.width
  const h = input.height
  const rgba = new Uint8Array(w * h * 4)
  const bandW = ringWidth(input.pieceSize)
  const n = SS_GRID * SS_GRID

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const c = sampleScene(input.scene, px, py)
      let r = c[0]
      let g = c[1]
      let b = c[2]

      // 离所有缺口都足够远（> 1px）时直接输出，省掉 16 次 SDF —— 缺口只占画面一小部分，
      // 绝大多数像素走这条快路径。
      if (notchSdf(input, px, py) > 1) {
        const o = (y * w + x) * 4
        rgba[o] = clampByte(r)
        rgba[o + 1] = clampByte(g)
        rgba[o + 2] = clampByte(b)
        rgba[o + 3] = 255
        continue
      }

      // 缺口覆盖率与虚线覆盖率：只超采样 SDF（场景色已采过一次，渐变亚像素变化可忽略）
      let cov = 0
      let dash = 0
      for (let sy = 0; sy < SS_GRID; sy++) {
        const syf = y + subOffset(sy)
        for (let sx = 0; sx < SS_GRID; sx++) {
          const sxf = x + subOffset(sx)
          const d = notchSdf(input, sxf, syf)
          if (d > 0) continue
          cov++
          if (d > -bandW) dash += dashMask(sxf, syf)
        }
      }

      if (cov > 0) {
        const k = 1 - ((1 - NOTCH_DIM) * cov) / n
        r *= k
        g *= k
        b *= k
        if (dash > 0) {
          const a = (dash / n) * NOTCH_DASH_ALPHA
          r += (255 - r) * a
          g += (255 - g) * a
          b += (255 - b) * a
        }
      }

      const o = (y * w + x) * 4
      rgba[o] = clampByte(r)
      rgba[o + 1] = clampByte(g)
      rgba[o + 2] = clampByte(b)
      rgba[o + 3] = 255
    }
  }
  return rgba
}

/**
 * 渲染拼图块图：形状外的像素透明，形状内是「场景在真缺口处」的像素（与背景同源）。
 * 返回 `(pieceSize + tab) * pieceSize * 4` 的 RGBA 缓冲。
 */
export function renderPiece(input: RasterInput): Uint8Array {
  const w = input.pieceSize + input.tab
  const h = input.pieceSize
  const rgba = new Uint8Array(w * h * 4)
  const bandW = ringWidth(input.pieceSize)
  const n = SS_GRID * SS_GRID

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 场景色每像素只采一次：真正需要抗锯齿的是形状边界，由下面的 SDF 超采样给出。
      // 采样坐标与背景在 (targetX+x, pieceY+y) 处完全一致，保证拖到位后严丝合缝。
      const c = sampleScene(input.scene, input.targetX + x + 0.5, input.pieceY + y + 0.5)

      let cov = 0
      let ring = 0
      for (let sy = 0; sy < SS_GRID; sy++) {
        const ly = y + subOffset(sy)
        for (let sx = 0; sx < SS_GRID; sx++) {
          const lx = x + subOffset(sx)
          const d = pieceSdf(lx, ly, input.pieceSize, input.radius, input.tab)
          if (d > 0) continue
          cov++
          if (d > -bandW) ring++
        }
      }
      if (cov === 0) continue

      // 描边强度取「已覆盖子样本里的占比」：于是描边内侧边界也是渐变的，
      // 不会再出现硬阈值裁出来的台阶（毛边）。
      const a = (ring / cov) * RING_ALPHA
      const r = c[0] + (255 - c[0]) * a
      const g = c[1] + (255 - c[1]) * a
      const b = c[2] + (255 - c[2]) * a

      const o = (y * w + x) * 4
      rgba[o] = clampByte(r)
      rgba[o + 1] = clampByte(g)
      rgba[o + 2] = clampByte(b)
      rgba[o + 3] = clampByte((cov / n) * 255)
    }
  }
  return rgba
}

function clampByte(v: number): number {
  if (v < 0) return 0
  if (v > 255) return 255
  return Math.round(v)
}
