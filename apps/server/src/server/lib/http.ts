/**
 * HTTP 辅助：统一错误体、错误描述、token 定长比较。
 *
 * 全部路由共用的**纯函数**，不依赖 store/domain 之类的运行时状态。
 */

/** 统一的错误体（HTTP 状态码 + 这条消息） */
export function jsonError(status: 400 | 401 | 403 | 404 | 409 | 500 | 502, error: string): Response {
  return Response.json({ error }, { status })
}

/** 把 handler 抛出的错误统一成 `{ error }`（客户端只需要这一种错误体） */
export function describeError(err: unknown): { status: 400 | 500; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  // 领域校验错误（路径不存在、模型没配、重复添加）都是「客户端能改」的，按 400 返回
  const clientIssue = /不存在|必须|请先|尚未|不支持|越界|重复|已存在|已经添加过/.test(message)
  return { status: clientIssue ? 400 : 500, message }
}

/** 定长比较，避免用 `===` 比 token 带来的时序侧信道 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  let diff = 0
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i]! ^ bufB[i]!
  return diff === 0
}