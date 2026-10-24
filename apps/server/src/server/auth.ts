import type { URL } from 'node:url'
import { authEnabled, verifyJwt } from '@/lib/auth-jwt'

/**
 * 校验一条 WS 升级请求的鉴权。`null` = 通过；否则返回要回给客户端的失败原因。
 *
 * - 未启用鉴权（没配凭据/密钥）：放行（开发态，等同旧逻辑）；
 * - 取 `?token=` 查参里的 JWT，验签名 + 过期（浏览器 `WebSocket` 带不了自定义请求头，
 *   token 只能走查询参数；连接建立后 token 过期不影响已建立的连接）。
 *
 * 曾经的「IP 绑定」已移除：IP 随网络漂移会造成无谓掉线，且同网攻击者本来就同 IP。
 */
export async function verifyWsToken(url: URL): Promise<string | null> {
  if (!authEnabled()) return null
  const token = url.searchParams.get('token') ?? ''
  if (!token) return '缺少 token'
  const claims = await verifyJwt(token)
  if (!claims) return 'token 无效或已过期'
  return null
}
