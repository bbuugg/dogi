/**
 * 登录接口：`POST /api/auth/login`，body `{ username, password, captchaPass? }`。
 *
 * 校验顺序：**限流 → 验证码 → 凭据**。验证码启用时必填 `captchaPass` —— 前端先在
 * `POST /api/auth/captcha/verify` 上拖滑块换来的**一次性票据**，这里消费并作废（过期 / 已用
 * 都 fail-closed）。凭据比对用定长比较避免时序侧信道。
 *
 * 校验通过签发 JWT（payload 带用户名），返回 `{ token }`；
 * 校验失败 / 未启用登录都回 401，失败体带 `code`（`'captcha' | 'credentials' | 'rate-limited'`）
 * —— 前端据此决定要不要重新弹验证码，还是把错误交给全局提示。
 * 本接口**不对自身鉴权**（否则永远登不进去）。
 */
import { authEnabled, signJwt } from '@/lib/auth-jwt'
import { captchaEnabled, consumeCaptchaPass } from '@/lib/captcha'
import {
  clientIpOf,
  getLoginRateLimiter,
  rateLimitEnabled,
  rateLimitedResponse
} from '@/lib/rate-limit'
import { timingSafeEqual } from '@/lib/server/lib/http'

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(a, b)
}

export async function POST(request: Request): Promise<Response> {
  // 整个请求体只在最外层读一次（Request 的 body 只能读一次）
  const body = (await request.json().catch(() => null)) as
    | { username?: unknown; password?: unknown; captchaPass?: unknown }
    | null
  const username = typeof body?.username === 'string' ? body.username : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  // 未启用鉴权（没配凭据/密钥）：开发态，等同旧逻辑「不配置就放行」。
  // 这里仍然签一个 token 返回，让前端「登录 → 存 token → 拉 health」的连接流程照常走，
  // 服务端对这类请求也一律放行。
  if (!authEnabled()) {
    const name = username ? username : 'dev'
    const token = await signJwt(name)
    return Response.json({ token })
  }

  // 限流：拦「拿固定账号反复试密码」的暴力破解。放在凭据比对**之前**，
  // 这样连密码都不用算，直接 429 打回。key = 客户端 IP。
  const clientIp = clientIpOf(request)
  if (rateLimitEnabled()) {
    const limit = getLoginRateLimiter().hit(clientIp)
    if (!limit.allowed) return rateLimitedResponse(limit)
  }

  // 验证码：启用时先过这一关 —— 票据由 `POST /api/auth/captcha/verify` 签发，一次性消费。
  // 消费失败时票据很可能已被烧掉，前端必须重新走一遍滑块。
  if (captchaEnabled()) {
    const captchaPass = typeof body?.captchaPass === 'string' ? body.captchaPass : ''
    if (!consumeCaptchaPass(captchaPass)) {
      // `code` 让前端能区分「验证码错」与「凭据错」：前者重新弹滑块，后者走全局提示。
      return Response.json(
        { error: '验证码校验失败或已过期，请重试', code: 'captcha' },
        { status: 401 }
      )
    }
  }

  const user = process.env.FIZZ_AUTH_USER ?? ''
  const pass = process.env.FIZZ_AUTH_PASS ?? ''
  // 定长比较避免时序侧信道（用户名/密码逐一比，任一个不等都判失败）
  if (!safeEqual(username, user) || !safeEqual(password, pass)) {
    return Response.json({ error: '用户名或密码错误', code: 'credentials' }, { status: 401 })
  }

  // 登录成功：清掉这个 IP 的失败计数，免得正常用户手滑几次后被自己之前的失败拖住
  if (rateLimitEnabled()) getLoginRateLimiter().reset(clientIp)

  const token = await signJwt(username)
  return Response.json({ token })
}
