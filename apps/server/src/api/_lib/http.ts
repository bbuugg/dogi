/** HTTP 路由的公共错误处理。 */
import { describeError, jsonError } from '@/app/api/_lib/auth'

/** 把领域 / 编排层抛出的错误统一成响应 */
export function fail(err: unknown): Response {
  const { status, message } = describeError(err)
  return jsonError(status, message)
}
