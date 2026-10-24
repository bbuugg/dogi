/**
 * 拖动轨迹采集（移植自 `console/apps/captcha/sdk/src/track.ts`，逻辑一字未改）。
 *
 * 服务端会强制校验轨迹：≥4 个采样、时间单调不减、起点为 0、末点等于提交的 x、
 * 耗时在合理区间、确实移动过。不带轨迹的请求一律拒绝。
 *
 * ## 轨迹必须「从第一次按下算起」
 *
 * 用户常见动作是「拖过去 → 松手 → 再拖一下微调」。如果第二段轨迹从当前位置起记，
 * 起点就不是 0，会被服务端直接判「验证未通过」—— 正常用户被自己误伤。
 * 所以这里按「本次挑战」累加：第一次按下才把 t 归零并清空轨迹，之后每次「松手再拖」
 * 都接着往后记，t 一直以第一次按下为原点。换挑战时 `reset()`。
 */
import type { CaptchaTrackPoint } from '@fizz/contracts'

/** 位移 ≥1px 或距上次 ≥30ms 才记一条，免得一次拖动塞几百个点给服务端。 */
const TRACK_MIN_DX = 1
const TRACK_MIN_DT = 30

export class TrackRecorder {
  private points: CaptchaTrackPoint[] = []
  private origin: number | null = null

  /** 换挑战时重置。 */
  reset(): void {
    this.points = []
    this.origin = null
  }

  /** 是否已经拖动过（第一次按下之后）。 */
  get started(): boolean {
    return this.origin !== null
  }

  /** 采样点数。 */
  get size(): number {
    return this.points.length
  }

  /** 一次按下。 */
  begin(x: number, now: number): void {
    if (this.origin === null) {
      this.origin = now
      this.points = [{ x, t: 0 }]
    } else {
      this.points.push({ x, t: now - this.origin })
    }
  }

  /** 拖动中采样（带节流）。 */
  sample(x: number, now: number): void {
    if (this.origin === null) return
    const t = now - this.origin
    const last = this.points[this.points.length - 1]
    if (!last || Math.abs(x - last.x) >= TRACK_MIN_DX || t - last.t >= TRACK_MIN_DT) {
      this.points.push({ x, t })
    }
  }

  /** 松手：补一条终态采样（服务端会核对末点与提交的 x 一致），返回轨迹与耗时。 */
  finish(x: number, now: number): { track: CaptchaTrackPoint[]; elapsedMs: number } {
    const elapsedMs = this.origin === null ? 0 : now - this.origin
    if (this.origin !== null) this.points.push({ x, t: elapsedMs })
    return { track: this.points.slice(), elapsedMs }
  }
}
