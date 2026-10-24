/**
 * 滑块（拖拽）验证码（移植自 `console/apps/captcha` 的 `slider.go`）。
 *
 * 交互：背景图上有一个虚线缺口，用户把拼图块拖到缺口处对齐，提交时回传最终 x 与拖动轨迹。
 *
 * 判定（三道关，缺一不可）：
 *  1. **轨迹**：必须带一段像人拖出来的 track（≥4 采样、时间单调不减、从起点出发、
 *     末尾与提交的 x 一致、耗时在合理区间、确实移动过）。直接堵死「拿到 x 直接 POST」。
 *  2. **位置**：`|x - targetX| <= tolerance`。
 *  3. **一次性**：挑战无论成败，校验后即作废。
 */
import type {
  CaptchaAnswer,
  CaptchaChallenge,
  CaptchaTrackPoint,
  CaptchaVerifyResponse
} from '@fizz/contracts'
import { randomId, randomInt } from './prng'
import { encodePng, pngDataUrl } from './png'
import { createScene, renderBackground, renderPiece } from './scene'
import { createChallengeStore } from './store'

const DEFAULT_WIDTH = 320
const DEFAULT_HEIGHT = 160
const DEFAULT_PIECE_SIZE = 44
const DEFAULT_TOLERANCE = 6
const DEFAULT_TTL_MS = 120_000
const DEFAULT_MIN_ELAPSED_MS = 200
const DEFAULT_MAX_ELAPSED_MS = 60_000
const DEFAULT_DECOY_COUNT = 2
const DEFAULT_STORE_MAX = 5000

/** 轨迹至少要有的采样点数（人拖一次通常几十个，脚本图省事只给一两个）。 */
const MIN_TRACK_POINTS = 4
/** 首/末采样与「起点 0 / 提交的 x」允许的误差（客户端会四舍五入 x）。 */
const TRACK_EDGE_TOLERANCE = 3

/** 文案统一在这里：前端原样展示，不自己拼。 */
const MSG = {
  expired: '验证码已失效，请刷新后重试',
  failed: '验证码校验失败，请重试',
  notPassed: '验证未通过，请重试',
  tooFast: '操作过快，请重试',
  tooSlow: '验证超时，请重试'
} as const

export interface SliderOptions {
  /** 背景逻辑宽高（px） */
  width: number
  height: number
  /** 拼图块边长（px） */
  pieceSize: number
  /** 允许的横向误差（px） */
  tolerance: number
  /** 挑战有效期（ms） */
  ttlMs: number
  /** 最短拖动耗时（ms），低于它判为脚本 */
  minElapsedMs: number
  /** 最长拖动耗时（ms），超过它判异常 */
  maxElapsedMs: number
  /** 背景上额外画几个干扰缺口（0 = 关闭） */
  decoyCount: number
  /** 自定义时钟（测试用） */
  now?: () => number
}

export function defaultSliderOptions(): SliderOptions {
  return {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    pieceSize: DEFAULT_PIECE_SIZE,
    tolerance: DEFAULT_TOLERANCE,
    ttlMs: DEFAULT_TTL_MS,
    minElapsedMs: DEFAULT_MIN_ELAPSED_MS,
    maxElapsedMs: DEFAULT_MAX_ELAPSED_MS,
    decoyCount: DEFAULT_DECOY_COUNT
  }
}

export interface SliderProvider {
  issue(): CaptchaChallenge
  verify(id: string, answer: CaptchaAnswer | null | undefined): CaptchaVerifyResponse
  /** 当前存活的挑战数（诊断用） */
  pending(): number
}

interface Point {
  x: number
  y: number
}

/** 构造滑块 Provider。参数会被夹到安全范围。 */
export function createSlider(options: Partial<SliderOptions> = {}): SliderProvider {
  const opt: SliderOptions = { ...defaultSliderOptions(), ...options }

  if (opt.width < 160) opt.width = DEFAULT_WIDTH
  if (opt.height < 80) opt.height = DEFAULT_HEIGHT
  if (opt.pieceSize < 24) opt.pieceSize = DEFAULT_PIECE_SIZE
  if (opt.tolerance < 1) opt.tolerance = DEFAULT_TOLERANCE
  if (opt.ttlMs < 1000) opt.ttlMs = DEFAULT_TTL_MS
  if (opt.minElapsedMs < 0) opt.minElapsedMs = 0
  if (opt.maxElapsedMs <= opt.minElapsedMs) opt.maxElapsedMs = opt.minElapsedMs + 1
  if (opt.decoyCount < 0) opt.decoyCount = 0

  const radius = Math.round(opt.pieceSize * 0.16)
  const tab = Math.round(opt.pieceSize * 0.2)
  const pieceWidth = opt.pieceSize + tab
  const maxX = Math.max(1, opt.width - pieceWidth)

  const now = (): number => (opt.now ? opt.now() : Date.now())
  const store = createChallengeStore({ max: DEFAULT_STORE_MAX, now })

  /** 干扰缺口：网格候选 + 洗牌（而不是拒绝采样 —— 后者在画布挤的时候会放不满）。 */
  const buildDecoys = (targetX: number, pieceY: number): Point[] => {
    if (opt.decoyCount <= 0) return []
    const step = opt.pieceSize + 20
    const farEnough = (ax: number, ay: number, bx: number, by: number): boolean =>
      Math.abs(ax - bx) >= step || Math.abs(ay - by) >= step

    const candidates: Point[] = []
    for (let x = 0; x <= maxX; x += step) {
      for (let y = 8; y + opt.pieceSize <= opt.height - 8; y += step) {
        candidates.push({ x, y })
      }
    }
    // Fisher-Yates 洗牌（用本模块的随机源，不引第三方）
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = randomInt(i + 1)
      const tmp = candidates[i]!
      candidates[i] = candidates[j]!
      candidates[j] = tmp
    }

    const decoys: Point[] = []
    for (const c of candidates) {
      if (decoys.length >= opt.decoyCount) break
      // 别盖在真缺口上（也别和已选的干扰重叠）
      if (!farEnough(c.x, c.y, targetX, pieceY)) continue
      let overlap = false
      for (const d of decoys) {
        if (!farEnough(c.x, c.y, d.x, d.y)) {
          overlap = true
          break
        }
      }
      if (overlap) continue
      decoys.push(c)
    }
    return decoys
  }

  return {
    issue(): CaptchaChallenge {
      const seed = randomInt(2 ** 31)

      // 缺口不要贴边：左边界从 30% 起，右边界留出拼图块宽度
      let minX = Math.round(opt.width * 0.3)
      if (minX > maxX - 1) minX = maxX - 1
      if (minX < 0) minX = 0
      const span = Math.max(1, maxX - minX)
      const targetX = minX + randomInt(span)

      const ySpan = Math.max(1, opt.height - opt.pieceSize - 16)
      const pieceY = 8 + randomInt(ySpan)

      const id = randomId()
      const decoys = buildDecoys(targetX, pieceY)

      store.put(id, { targetX, createdAt: now(), ttlMs: opt.ttlMs })

      // ⚠️ 场景只建一次、背景与拼图块共用：这是「拼图块拖到缺口处像素级严丝合缝」的前提
      const scene = createScene(seed, opt.width, opt.height)
      const input = {
        scene,
        width: opt.width,
        height: opt.height,
        targetX,
        pieceY,
        pieceSize: opt.pieceSize,
        radius,
        tab,
        decoys
      }

      const background = pngDataUrl(encodePng(opt.width, opt.height, renderBackground(input)))
      const piece = pngDataUrl(encodePng(pieceWidth, opt.pieceSize, renderPiece(input)))

      return {
        kind: 'slider',
        id,
        background,
        piece,
        width: opt.width,
        height: opt.height,
        pieceWidth,
        pieceHeight: opt.pieceSize,
        pieceY,
        maxX
      }
    },

    verify(id: string, answer: CaptchaAnswer | null | undefined): CaptchaVerifyResponse {
      // 先消费：无论成败，这张挑战都作废（一次性）
      const rec = store.consume(id)
      if (!rec) return { ok: false, error: MSG.expired }
      if (!answer || !Number.isFinite(answer.x)) return { ok: false, error: MSG.failed }

      // 第一关：拖动轨迹（拦「直接 POST 一个 x」的脚本）
      const trackError = checkTrack(answer, answer.x, opt.minElapsedMs, opt.maxElapsedMs)
      if (trackError) return { ok: false, error: trackError }

      // 第二关：位置
      if (Math.abs(answer.x - rec.targetX) > opt.tolerance) return { ok: false, error: MSG.notPassed }
      return { ok: true }
    },

    pending() {
      return store.size()
    }
  }
}

/**
 * 校验拖动轨迹，返回错误文案（空串 = 通过）。
 *
 * ⚠️ 这不是「防伪造」的终极手段（轨迹本身也能被合成），但它把攻击成本从
 * 「一个正则 + 一次 POST」抬到「解 PNG + 图像定位缺口 + 合成拟人轨迹」。
 */
function checkTrack(
  answer: CaptchaAnswer,
  x: number,
  minElapsedMs: number,
  maxElapsedMs: number
): string {
  const track = answer.track
  if (!Array.isArray(track) || track.length < MIN_TRACK_POINTS) return MSG.notPassed

  let prevT = -Infinity
  let maxAbsX = 0
  for (const p of track as CaptchaTrackPoint[]) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.t)) return MSG.notPassed
    // 时间必须单调不减（真实拖动不可能倒流）
    if (p.t < prevT) return MSG.notPassed
    prevT = p.t
    const abs = Math.abs(p.x)
    if (abs > maxAbsX) maxAbsX = abs
  }

  const first = track[0]!
  const last = track[track.length - 1]!
  // 必须从起点出发、末尾与提交的 x 对得上（否则是「轨迹与答案拼凑」）
  if (Math.abs(first.x) > TRACK_EDGE_TOLERANCE) return MSG.notPassed
  if (Math.abs(last.x - x) > TRACK_EDGE_TOLERANCE) return MSG.notPassed
  if (last.t < minElapsedMs) return MSG.tooFast
  if (last.t > maxElapsedMs) return MSG.tooSlow
  // 必须真的「移动过去」过，而不是从头到尾都在答案附近微抖
  if (maxAbsX < Math.abs(x) * 0.9) return MSG.notPassed
  return ''
}
