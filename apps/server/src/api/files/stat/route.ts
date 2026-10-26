/**
 * `GET /api/files/stat?path=` —— 单条属性（属性弹窗与预览头部用）。
 *
 * 注意它回的是 `FmEntry`（与列表里的一项同形），界面不需要为「属性」再写一套渲染。
 */
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { statPath } from '@/lib/server/file-manager/list'

export async function GET(request: Request) {
  const url = new URL(request.url)
  try {
    return Response.json(await statPath(url.searchParams.get('path')))
  } catch (err) {
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
