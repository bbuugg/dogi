/**
 * 校验验证码答案：`POST /api/auth/captcha/verify`，body `{ id, answer }`。
 *
 * `answer = { x, track: [{ x, t }] }`（见 `@fizz/contracts` 的 `CaptchaAnswer`）。服务端做三
 * 道判定（轨迹 / 位置 / 一次性），通过则签发一次性 `passToken`，前端随后带着它登录。
 *
 * 这里**不再单独限流**：撞位置需要「一张有效挑战」，而挑战由签发接口按 IP 限流且用一次即废，
 * 所以爆破成本已经被签发侧卡住了；本接口只做一次 Map 查找 + 几个数值比较。
 *
 * 一次性：挑战无论成败都在校验后作废 —— 前端重试必须重新拉图。
 */
import { captchaEnabled, verifyCaptcha } from '@/lib/captcha'

export async function POST(request: Request): Promise<Response> {
  if (!captchaEnabled()) {
    return Response.json({ ok: false, error: '当前未启用验证码' }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as
    | { id?: unknown; answer?: unknown }
    | null

  const result = verifyCaptcha(body?.id, body?.answer)
  return Response.json(result, {
    status: result.ok ? 200 : 400,
    headers: { 'cache-control': 'no-store' }
  })
}
