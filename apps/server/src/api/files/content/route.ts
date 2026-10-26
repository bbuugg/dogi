/**
 * `GET /api/files/content?path=` —— 原始字节（图片 / 音频 / 视频 / PDF 预览）。
 *
 * 复用 `mediaResponse`：MIME 按扩展名给、**支持 Range**（`<video>` 拖进度条要靠它），
 * 走的是流不是整块进内存。
 *
 * ⚠️ 鉴权：`<img src>` / `<video src>` 带不了 `Authorization` 头，浏览器请求会 401。
 * 前端因此有两种走法（见 `features/file-manager/api.ts`）：优先**带 token 的 query**
 * （`?token=`，服务端 jwt 中间件认那条，见 `extractTokenFromRequest`），桌面端走 IPC 时
 * 则取 blob 再由渲染端造 objectURL。
 */
import { promises as fs } from 'node:fs'
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { mediaResponse, mimeOf } from '@/lib/server/lib/media'
import { normalizeTarget } from '@/lib/server/file-manager/paths'

export async function GET(request: Request) {
  return handle(request)
}

export async function HEAD(request: Request) {
  return handle(request)
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  try {
    const abs = normalizeTarget(url.searchParams.get('path'))
    const stat = await fs.stat(abs)
    if (stat.isDirectory()) return jsonError(400, '这是一个目录，没有内容可预览')
    return mediaResponse(abs, mimeOf(abs), Number(stat.size) || 0, request.headers.get('range'), request.method)
  } catch (err) {
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
