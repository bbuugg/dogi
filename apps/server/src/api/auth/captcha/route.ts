/**
 * 签发验证码挑战：`GET /api/auth/captcha`。
 *
 * 引擎就在本进程（`@/lib/captcha`），不再有「独立部署的验证码服务 + UMD SDK」：
 * 这里直接光栅化一张背景图（含虚线缺口）与一张拼图块图，把**图片**下发，答案留在服务端。
 *
 * 两种响应：
 * - `{ enabled: false }` —— 当前不要求验证码（鉴权未启用，或 `FIZZ_AUTH_CAPTCHA=0`）；
 * - `{ enabled: true, challenge }` —— 前端弹滑块用。
 *
 * 签发比一次登录校验贵得多（320×160 像素逐点采样 + deflate），所以按 IP 限流；
 * 命中限流回 429 + `Retry-After`。响应一律 `no-store`：挑战是一次性的，缓存等于给重放。
 *
 * 与登录接口一样**不对自身鉴权**（已在 app.ts 的 `isPublicPath` 里放行）。
 */
import { captchaEnabled, captchaIssueLimit, issueCaptcha } from '@/lib/captcha'
import { clientIpOf, rateLimitEnabled, rateLimitedResponse } from '@/lib/rate-limit'

const NO_STORE = { 'cache-control': 'no-store' } as const

export async function GET(request: Request): Promise<Response> {
  if (!captchaEnabled()) return Response.json({ enabled: false }, { headers: NO_STORE })

  if (rateLimitEnabled()) {
    const limit = captchaIssueLimit(clientIpOf(request))
    if (!limit.allowed) return rateLimitedResponse(limit)
  }

  return Response.json({ enabled: true, challenge: issueCaptcha() }, { headers: NO_STORE })
}
