/**
 * 登录接口：`POST /api/auth/login`，body `{ password, captchaPass? }`。
 *
 * 单用户系统：没有用户名。密码**只以 scrypt 哈希保存**在 `FIZZ_AUTH_PASS` 里。
 * - 该值为空 = 首次登录：把这次输入的密码哈希后写入（之后按哈希校验）；
 * - 该值已是哈希 = 正常校验；
 * - 该值还是旧版明文 = 比对通过后顺手升级成哈希（一次性迁移）。
 *
 * 校验顺序：**限流 → 验证码 → 密码**。验证码启用时必填 `captchaPass` —— 前端先在
 * `POST /api/auth/captcha/verify` 上拖滑块换来的**一次性票据**，这里消费并作废（过期 / 已用
 * 都 fail-closed）。
 *
 * 校验通过签发 JWT，返回 `{ token }`；校验失败 / 未启用登录都回 401，失败体带 `code`
 * （`'captcha' | 'credentials' | 'rate-limited'`）—— 前端据此决定要不要重新弹验证码，
 * 还是把错误交给全局提示。本接口**不对自身鉴权**（否则永远登不进去）。
 */
import { authEnabled, signJwt } from '@/lib/auth-jwt'
import { isPasswordHash, setStoredPassword, verifyPassword } from '@/lib/auth-password'
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
    | { password?: unknown; captchaPass?: unknown }
    | null
  const password = typeof body?.password === 'string' ? body.password : ''

  // 未启用鉴权（没配密码变量/密钥）：开发态，等同旧逻辑「不配置就放行」。
  // 这里仍然签一个 token 返回，让前端「登录 → 存 token → 拉 health」的连接流程照常走，
  // 服务端对这类请求也一律放行。
  if (!authEnabled()) {
    const token = await signJwt()
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

  const stored = process.env.FIZZ_AUTH_PASS ?? ''
  if (!password) {
    return Response.json({ error: '密码不能为空', code: 'credentials' }, { status: 401 })
  }

  if (!stored) {
    // 首次登录：这次输入的密码就是新密码（只落哈希）
    await setStoredPassword(password)
  } else if (isPasswordHash(stored)) {
    if (!(await verifyPassword(password, stored))) {
      return Response.json({ error: '密码错误', code: 'credentials' }, { status: 401 })
    }
  } else {
    // 旧版 `.env` 里还是明文：比对通过后升级成哈希，明文不再保留
    if (!safeEqual(password, stored)) {
      return Response.json({ error: '密码错误', code: 'credentials' }, { status: 401 })
    }
    await setStoredPassword(password)
  }

  // 登录成功：清掉这个 IP 的失败计数，免得正常用户手滑几次后被自己之前的失败拖住
  if (rateLimitEnabled()) getLoginRateLimiter().reset(clientIp)

  const token = await signJwt()
  return Response.json({ token })
}
