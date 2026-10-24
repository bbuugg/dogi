/**
 * 登录的**滑动窗口限流**（进程内、单机、零依赖）。
 *
 * 为什么要有它：验证码（独立部署的滑块服务）只是「提高单次攻击成本」的门槛，真正决定
 * 暴力破解是否可行的，是**单位时间内允许尝试多少次**。最省事的攻击就是拿一个固定账号
 * 反复试密码 —— 限流直接把这条路堵死。
 *
 * ## 设计取舍
 * - **进程内内存**，不引 Redis：Fizz 是自托管单实例，进程重启丢计数可接受（重启本身就
 *   让攻击者前面的尝试白费了）。
 * - **滑动窗口**（记时间戳）而不是固定窗口计数：固定窗口在边界上能被「窗口末尾打满 +
 *   下一窗口开头再打满」绕过，滑动窗口没有这个缝。
 * - **key 数量有上限**（默认 1 万）：否则一堆伪造 IP 能把 Map 撑爆内存。超限时按插入
 *   顺序淘汰最旧的 key（FIFO），宁可误伤冷门 IP 也不 OOM。
 *
 * ## 客户端 IP 怎么拿
 * 路由处理函数拿到的是**原生 `Request`**（`next-route.ts` 传的 `c.req.raw`），拿不到
 * Hono 的 `Context`，也就没法直接调 `getConnInfo(c)`。所以由 `app.ts` 的中间件在**进入
 * 路由之前**把解析好的 IP 用 `setClientIp()` 挂到这个 `Request` 对象上（WeakMap 旁路，
 * 不改动 Request 本身），路由里再用 `clientIpOf(request)` 取回。同一个对象，
 * 查得到。
 */
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'

/** `Request` 实例 → 客户端 IP。WeakMap 不阻止 Request 被 GC。 */
const ipByRequest = new WeakMap<Request, string>()

/** 中间件在放行前调用：把解析好的 IP 绑到这次请求上。 */
export function setClientIp(request: Request, ip: string): void {
  ipByRequest.set(request, ip)
}

/**
 * 路由里取客户端 IP。
 *
 * 优先读中间件挂上去的（可信）；万一中间件没跑（比如单测直接调路由），退回自己解析头，
 * 再不行给个 `'unknown'` 兜底 —— 绝不能让限流因为取不到 IP 就整段失效。
 */
export function clientIpOf(request: Request): string {
  const bound = ipByRequest.get(request)
  if (bound) return bound
  return headerIp(request) ?? 'unknown'
}

/** 从常见反代头里抠 IP（`x-forwarded-for` 取第一段）。仅作兜底，默认不信任。 */
function headerIp(request: Request): string | null {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  return request.headers.get('x-real-ip')?.trim() || null
}

/** 回环 / 私网地址：对端是这些，说明前面很可能站着反向代理，此时才敢采信 XFF。 */
function isPrivateOrLoopback(ip: string): boolean {
  if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') return true
  if (ip.startsWith('::ffff:')) return isPrivateOrLoopback(ip.slice('::ffff:'.length))
  if (/^10\./.test(ip)) return true
  if (/^192\.168\./.test(ip)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
  if (/^f[cd]/i.test(ip)) return true // IPv6 ULA (fc00::/7)
  if (/^fe80:/i.test(ip)) return true // IPv6 link-local
  return false
}

/**
 * 解析客户端 IP（给 `app.ts` 的中间件用）。
 *
 * 顺序：**TCP 对端地址**（客户端伪造不了）→ 若对端是回环/私网，再采信 `x-forwarded-for`
 * → 都没有就 `'unknown'`。
 *
 * 桌面端是进程内 `app.fetch()`，没有 `incoming` socket，`getConnInfo` 会抛 ——
 * 直接吞掉走兜底（桌面端本来就关着鉴权，限流形同虚设，无所谓）。
 */
export function resolveClientIp(c: Context): string {
  let peer: string | undefined
  try {
    peer = getConnInfo(c).remote.address
  } catch {
    peer = undefined
  }
  if (peer && isPrivateOrLoopback(peer)) {
    const forwarded = headerIp(c.req.raw)
    if (forwarded) return forwarded
  }
  return peer ?? 'unknown'
}

export interface RateLimitResult {
  allowed: boolean
  /** 本窗口还剩几次（allowed 为 false 时是 0） */
  remaining: number
  /** 被拦时建议的重试秒数（`Retry-After` 用） */
  retryAfterSec: number
}

export interface RateLimiter {
  /** 记一次尝试，返回是否放行 */
  hit(key: string): RateLimitResult
  /** 清空（某个 key 或全部）—— 登录成功后清掉该 IP 的失败计数，免得误伤正常用户 */
  reset(key?: string): void
  /** 当前在跟踪的 key 数（测试 / 观测用） */
  size(): number
}

export interface RateLimiterOptions {
  /** 窗口内允许的最大次数 */
  max: number
  /** 窗口长度（ms） */
  windowMs: number
  /** key 上限（超过按插入顺序淘汰最旧的），默认 10000 */
  maxKeys?: number
  /** 自定义时钟（测试用） */
  now?: () => number
}

/**
 * 创建一个滑动窗口限流器。
 *
 * 每个 key 存一个「命中时间戳」数组，`hit` 时先丢掉窗口外的，再判断是否超限 —— 这就是
 * 滑动窗口的全部：不维护计数器、不用定时器，天然跟着请求走。
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const max = Math.max(1, Math.trunc(options.max))
  const windowMs = Math.max(1000, Math.trunc(options.windowMs))
  const maxKeys = Math.max(1, Math.trunc(options.maxKeys ?? 10_000))
  const now = options.now ?? (() => Date.now())
  const buckets = new Map<string, number[]>()

  return {
    hit(key: string): RateLimitResult {
      const t = now()
      let times = buckets.get(key)
      if (!times) {
        times = []
        buckets.set(key, times)
      }

      // 丢掉滑出窗口的时间戳
      let drop = 0
      while (drop < times.length && t - times[drop]! >= windowMs) drop++
      if (drop > 0) times.splice(0, drop)

      if (times.length >= max) {
        const earliest = times[0]!
        const retryAfterSec = Math.max(1, Math.ceil((earliest + windowMs - t) / 1000))
        return { allowed: false, remaining: 0, retryAfterSec }
      }

      times.push(t)

      // key 数量兜底：超限就淘汰最早插入的那个（FIFO），防止伪造 IP 撑爆内存
      if (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value
        if (oldest !== undefined && oldest !== key) buckets.delete(oldest)
      }

      return { allowed: true, remaining: max - times.length, retryAfterSec: 0 }
    },

    reset(key?: string): void {
      if (key === undefined) buckets.clear()
      else buckets.delete(key)
    },

    size(): number {
      return buckets.size
    }
  }
}

// ---------------------------------------------------------------------------
// 按环境变量配置的进程内单例
// ---------------------------------------------------------------------------

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name] ?? '')
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * 是否启用限流：**鉴权启用时默认开**；`FIZZ_RATE_LIMIT=0/false/off/no` 显式关。
 * （鉴权没启用时登录接口本来就全放行，限流没有意义。）
 */
export function rateLimitEnabled(): boolean {
  const v = (process.env.FIZZ_RATE_LIMIT ?? '').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

let loginLimiter: RateLimiter | null = null

/**
 * 登录尝试限流：默认 **每 IP 60 秒 10 次**。
 * 正常人手打密码不会一分钟错 10 次，而暴力破解会被这 10 次卡到「一分钟十个密码」。
 * （验证码挑战的签发限流在独立验证码服务上，本进程不管签发。）
 */
export function getLoginRateLimiter(): RateLimiter {
  if (!loginLimiter) {
    loginLimiter = createRateLimiter({
      max: numEnv('FIZZ_LOGIN_RATE_MAX', 10),
      windowMs: Math.round(numEnv('FIZZ_LOGIN_RATE_WINDOW_SEC', 60) * 1000)
    })
  }
  return loginLimiter
}

/** 被限流时统一的 429 响应：带 `Retry-After` 与 `code`，前端能识别并提示等待。 */
export function rateLimitedResponse(result: RateLimitResult): Response {
  return Response.json(
    { error: `操作过于频繁，请 ${result.retryAfterSec} 秒后再试`, code: 'rate-limited' },
    {
      status: 429,
      headers: { 'retry-after': String(result.retryAfterSec), 'cache-control': 'no-store' }
    }
  )
}
