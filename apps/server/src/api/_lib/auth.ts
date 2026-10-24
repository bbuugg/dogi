/**
 * Next.js Route Handler 的共享工具函数。
 *
 * ⚠️ HTTP 接口的鉴权已统一收进 `middleware.ts`（见仓库根 `middleware.ts`）：
 * 所有 `/api/*` 请求经过它校验 JWT（除登录接口本身）。各 Route Handler **不再自己**
 * 调 `requireAuth` —— 加在中间件里一处兜底，新增接口也不会漏。
 *
 * 这里只留纯函数工具（错误体 / JSON 解析），被各 Route Handler 复用。
 */
import { jsonError, describeError } from '@/lib/server/lib/http'

/**
 * 从 Request 解析 JSON 体。**解析失败返回 null**（调用方决定怎么回错）。
 */
export async function parseJsonBody<T = unknown>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

/** 把领域 / 编排层抛出的错误统一成 HTTP 响应（沿用 describeError 的判定）。 */
export { describeError, jsonError }
