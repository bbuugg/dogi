/**
 * `GET /api/files/read?path=` —— 读文件内容（文本 utf8 / 二进制 base64）。
 *
 * 文本预览与「就地编辑后保存」的前半段走它；**大文件与视频**不要走这条（进内存），
 * 那是 `/api/files/content` 的活儿（流式 + Range）。
 */
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { readPath } from '@/lib/server/file-manager/read'

export async function GET(request: Request) {
  const url = new URL(request.url)
  try {
    return Response.json(await readPath(url.searchParams.get('path')))
  } catch (err) {
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
