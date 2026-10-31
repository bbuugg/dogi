/**
 * 鉴权核心：JWT（HS256）签发 / 校验。
 *
 * 刻意只用 **Web Crypto**（`crypto.subtle`）+ `btoa`/`atob`：Node 18+ 与浏览器都内置，
 * 所以**一份实现多处共用**（Hono 中间件 / WS 升级处理器 / 将来可能的其它运行时），
 * 不会出现「一处签的 token 另一处验不过」的坑。
 *
 * 设计要点（对应需求）：
 * - 登录成功后签发 JWT，payload 里带 `sub`（单用户固定 `fizz`）与过期时间；
 * - 校验只验签名与有效期。曾经的「IP 绑定」已移除：IP 随网络漂移（DHCP / 手机网络 / 双栈切换）
 *   会造成无谓掉线，而同网攻击者本来就同 IP —— 防泄露交给短有效期 + 会话管理（见 auth-jwt 历史）。
 * - 所有 HTTP 接口由 Hono 的鉴权中间件统一拦（除登录接口本身），所有 WS 由各自的 upgrade
 *   处理器调用 `verifyWsToken` 拦。
 */
const enc = new TextEncoder()
const dec = new TextDecoder()

/** base64url 编码（输入是字符串或字节） */
function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? enc.encode(input) : input
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url 解码回字节（显式用 ArrayBuffer 承载，满足 Web Crypto 的 BufferSource 类型） */
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * 签名密钥：读 `FIZZ_JWT_SECRET`。
 * ⚠️ 从 `process.env` 读（不是 `state.ts` 里那个「没设就随机生成」的运行时值），
 * 这样 middleware（Edge）与 Route Handler / WS（Node）读到的是**同一个值**，token 才验得过。
 * 没设 = 密钥为空，此时 `authEnabled()` 返回 false，整套鉴权放行（开发态，等同旧逻辑）。
 */
function jwtSecret(): string {
  return process.env.FIZZ_JWT_SECRET ?? ''
}

/**
 * 实际用于 HMAC 的密钥：未配置时为避免 Web Crypto 拒绝「零长度密钥」，退一个固定占位串。
 * 这只影响「未启用鉴权」的开发态——那种情况下 `authEnabled()` 已经是 false，
 * 服务端对请求一律放行，token 本身的签名强弱无所谓。生产环境务必配 `FIZZ_JWT_SECRET`。
 */
const DEV_SECRET = '__fizz_dev_insecure__'
function signingSecret(): string {
  return jwtSecret() || DEV_SECRET
}

/**
 * 是否启用登录：只看有没有 JWT 密钥。
 *
 * `FIZZ_AUTH_PASS` 为空 / 不存在都是「还没有密码」的合法状态：登录接口会把首次输入的
 * 密码哈希后写入。完全不配 `FIZZ_JWT_SECRET` = 开发态，不做鉴权、全部放行。
 */
export function authEnabled(): boolean {
  return !!jwtSecret()
}

/** token 有效期（秒），可用 `FIZZ_TOKEN_TTL` 覆盖（单位分钟，默认 30） */
function tokenTtlSec(): number {
  const min = Number(process.env.FIZZ_TOKEN_TTL ?? '')
  return Number.isFinite(min) && min > 0 ? Math.trunc(min * 60) : 30 * 60
}

export interface JwtClaims {
  sub: string
  exp: number
}

/** 签发 JWT（HS256）。单用户系统，`sub` 固定为 `fizz`。 */
export async function signJwt(): Promise<string> {
  const secret = signingSecret()
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { sub: 'fizz', iat: now, exp: now + tokenTtlSec() }
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
  return `${data}.${b64url(sig)}`
}

/** 校验 JWT：签名 / 过期都过才返回 claims，否则 null */
export async function verifyJwt(token: string): Promise<JwtClaims | null> {
  const secret = signingSecret()
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(s), enc.encode(`${h}.${p}`))
  if (!ok) return null
  try {
    const payload = JSON.parse(dec.decode(b64urlToBytes(p))) as Record<string, unknown>
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null
    return {
      sub: typeof payload.sub === 'string' ? payload.sub : '',
      exp: payload.exp
    }
  } catch {
    return null
  }
}

/** 从标准 `Request` 取 Bearer 头或 `?token=` 查询参数里的 token */
export function extractTokenFromRequest(request: Request): string | null {
  const auth = request.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  return new URL(request.url).searchParams.get('token')
}
