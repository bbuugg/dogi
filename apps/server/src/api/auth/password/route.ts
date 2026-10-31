/**
 * 修改登录密码：`POST /api/auth/password`，body `{ currentPassword, newPassword }`。
 *
 * 单用户系统里这是**唯一**的修改入口（没有用户名、也没有「不验证旧密码的重置」）：
 * - 已设置密码：必须先验对旧密码，再写入新密码的哈希；
 * - 还没设置密码（`FIZZ_AUTH_PASS` 为空）：允许直接设置，与首次登录一致。
 *
 * 旧密码校验走登录限流（按客户端 IP），避免被拿来暴力猜当前密码。写入只保留
 * scrypt 哈希，明文不落盘（持久化由 `lib/auth-password.ts` 的 persister 负责）。
 * 本接口本身需要已登录（桌面端走进程内直连，web 端带 JWT）。
 */
import { authEnabled } from '@/lib/auth-jwt'
import { isPasswordHash, setStoredPassword, verifyPassword } from '@/lib/auth-password'
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
  const body = (await request.json().catch(() => null)) as
    | { currentPassword?: unknown; newPassword?: unknown }
    | null
  const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''

  if (!authEnabled()) {
    return Response.json({ error: '登录未启用，无法修改密码' }, { status: 400 })
  }
  if (!newPassword) {
    return Response.json({ error: '新密码不能为空' }, { status: 400 })
  }

  const stored = process.env.FIZZ_AUTH_PASS ?? ''
  if (stored) {
    const clientIp = clientIpOf(request)
    if (rateLimitEnabled()) {
      const limit = getLoginRateLimiter().hit(clientIp)
      if (!limit.allowed) return rateLimitedResponse(limit)
    }

    const ok = isPasswordHash(stored)
      ? await verifyPassword(currentPassword, stored)
      : safeEqual(currentPassword, stored)
    if (!ok) {
      return Response.json({ error: '当前密码错误' }, { status: 401 })
    }
    if (rateLimitEnabled()) getLoginRateLimiter().reset(clientIp)
  }

  await setStoredPassword(newPassword)
  return Response.json({ ok: true })
}
