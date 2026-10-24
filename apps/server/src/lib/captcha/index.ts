/**
 * 登录验证码（滑块）—— **本进程内实现**，不依赖任何外部服务或 SDK。
 *
 * 移植自仓库 `console/apps/captcha`（Go 服务 + UMD SDK）。当时的选择是「独立部署一套验证码
 * 服务，fizz 只做适配层」；现在改成把引擎直接搬进来，原因有两条：
 *
 * 1. 自托管产品不该为了一张验证码图强制外网依赖 —— 离线 / 内网部署会直接卡在登录页；
 * 2. 那个服务本来就只需要「进程内的一次性挑战表」，独立部署只是多了一个故障点。
 *
 * 对外只有四个动作，路由层保持极薄：
 * - `captchaEnabled()`    是否要求验证码（鉴权启用时默认要求）
 * - `captchaIssueLimit()` 签发限流（按 IP，防止被刷爆内存 / CPU）
 * - `issueCaptcha()`      签发一张挑战（PNG 图 + 缺口位置留在服务端）
 * - `verifyCaptcha()`     校验答案，通过则发一次性 `passToken`
 * - `consumeCaptchaPass()` 登录时消费票据（一次性、fail-closed）
 */
import type { CaptchaAnswer, CaptchaChallenge, CaptchaVerifyResponse } from '@fizz/contracts'
import { authEnabled } from '../auth-jwt'
import { createRateLimiter, type RateLimitResult } from '../rate-limit'
import { createPassStore } from './store'
import { createSlider, type SliderProvider } from './slider'

/** 单张挑战最多接受多少个轨迹采样（防「用超长数组」把校验拖慢） */
const MAX_TRACK_POINTS = 2000

/**
 * 是否要求验证码：**鉴权启用时默认开**；`FIZZ_AUTH_CAPTCHA` 显式设 0/false/off/no 可关。
 *
 * 鉴权没启用（开发态，全放行）时一律不要求 —— 否则本地开发还得先拖滑块，纯找罪受。
 */
export function captchaEnabled(): boolean {
  if (!authEnabled()) return false
  const v = (process.env.FIZZ_AUTH_CAPTCHA ?? '').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name] ?? '')
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * Provider 惰性单例。
 *
 * 不在模块顶层直接 `createSlider(...)` 的原因：`process.env` 可能在 import 之后才被写入
 * （测试、桌面端启动早期），惰性创建能保证读到的是最终值。
 */
let provider: SliderProvider | null = null

function getProvider(): SliderProvider {
  if (!provider) {
    provider = createSlider({
      width: numEnv('FIZZ_CAPTCHA_WIDTH', 320),
      height: numEnv('FIZZ_CAPTCHA_HEIGHT', 160),
      pieceSize: numEnv('FIZZ_CAPTCHA_PIECE_SIZE', 44),
      tolerance: numEnv('FIZZ_CAPTCHA_TOLERANCE', 6),
      ttlMs: numEnv('FIZZ_CAPTCHA_TTL_SEC', 120) * 1000,
      minElapsedMs: numEnv('FIZZ_CAPTCHA_MIN_ELAPSED_MS', 200),
      maxElapsedMs: numEnv('FIZZ_CAPTCHA_MAX_ELAPSED_MS', 60_000),
      decoyCount: numEnv('FIZZ_CAPTCHA_DECOYS', 2)
    })
  }
  return provider
}

/**
 * 一次性通过票据：验证码过了 → 票据 → 登录时消费。
 *
 * 票据与「挑战」分开存是刻意的：挑战用一次就废，而票据要跨两个请求（verify → login）。
 * TTL 只覆盖「刚拖完 → 紧接着提交登录」这个短窗口。
 */
const passStore = createPassStore({
  max: numEnv('FIZZ_CAPTCHA_PASS_MAX', 20_000),
  ttlMs: numEnv('FIZZ_CAPTCHA_PASS_TTL_SEC', 300) * 1000
})

/**
 * 签发限流：默认每 IP 每分钟 30 张。
 *
 * 一张挑战要真的画 320×160 像素 + deflate 编码，比一次登录校验贵得多 —— 不限流的话
 * 「狂刷签发接口」本身就是一次廉价的 DoS。
 */
const issueLimiter = createRateLimiter({
  max: numEnv('FIZZ_CAPTCHA_ISSUE_MAX', 30),
  windowMs: numEnv('FIZZ_CAPTCHA_ISSUE_WINDOW_SEC', 60) * 1000
})

/** 签发限流（路由层拿到 `allowed: false` 就回 429）。 */
export function captchaIssueLimit(ip: string): RateLimitResult {
  return issueLimiter.hit(ip)
}

/** 签发一张挑战。调用方必须先确认 `captchaEnabled()`。 */
export function issueCaptcha(): CaptchaChallenge {
  return getProvider().issue()
}

/**
 * 把请求体里不可信的 `answer` 收成结构化答案。
 *
 * 这里不做「猜用户意图」：形状不对就是失败。数字一律走 `Number.isFinite`（`NaN` / `Infinity`
 * 会让后面的距离比较恒为 false，等于放行 —— 必须挡在入口）。
 */
function parseAnswer(raw: unknown): CaptchaAnswer | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const x = obj.x
  if (typeof x !== 'number' || !Number.isFinite(x)) return null
  const trackRaw = obj.track
  if (!Array.isArray(trackRaw) || trackRaw.length === 0 || trackRaw.length > MAX_TRACK_POINTS) {
    return null
  }

  const track: CaptchaAnswer['track'] = []
  for (const item of trackRaw) {
    if (!item || typeof item !== 'object') return null
    const p = item as Record<string, unknown>
    if (typeof p.x !== 'number' || typeof p.t !== 'number') return null
    if (!Number.isFinite(p.x) || !Number.isFinite(p.t)) return null
    track.push({ x: p.x, t: p.t })
  }

  const elapsed = obj.elapsedMs
  return typeof elapsed === 'number' && Number.isFinite(elapsed)
    ? { x, track, elapsedMs: elapsed }
    : { x, track }
}

/**
 * 校验答案；通过则签发一次性票据。
 *
 * 失败文案直接来自 provider（可展示给用户）。挑战**无论成败都已被消费**，前端要重试就得
 * 重新拉一张 —— 这样「反复拿同一张挑战撞位置」的攻击方式就退化成只能撞一次。
 */
export function verifyCaptcha(id: unknown, answer: unknown): CaptchaVerifyResponse {
  if (typeof id !== 'string' || !id) return { ok: false, error: '验证码已失效，请刷新后重试' }
  const parsed = parseAnswer(answer)
  if (!parsed) return { ok: false, error: '验证码校验失败，请重试' }

  const result = getProvider().verify(id, parsed)
  if (!result.ok) return result
  return { ok: true, passToken: passStore.issue() }
}

/** 消费一次性票据。空票据、过期、已用、未知票据一律 false（fail-closed）。 */
export function consumeCaptchaPass(token: string): boolean {
  return passStore.consume(token)
}
