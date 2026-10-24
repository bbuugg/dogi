/**
 * 对外提供截图图片：screenshot 工具把图存到数据目录的 `screenshots/`，
 * 这里按文件名读出来以正确的 MIME 返回（支持 Range，便于大图流式）。
 *
 * 文件名是随机 UUID + 扩展名（见 packages/tools/src/screenshot.ts），既挡路径穿越，
 * 又保证「高熵不可猜测」—— 所以这条路由在 proxy.ts 里被放进 PUBLIC_PATHS：
 * markdown 里的 `<img>` 带不了 Authorization 头，启用鉴权时也得能直接加载
 * （文件名是服务端生成的高熵 UUID）。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from '@fizz/workspace'
import { jsonError } from '@/app/api/_lib/auth'
import { mediaResponse, mimeOf } from '@/lib/server/lib/media'

// 只允许 <uuid>.<ext>：既挡路径穿越，也限定只服务截图目录里的图
const NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$/

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  return handleScreenshot(request, params)
}

export async function HEAD(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  return handleScreenshot(request, params)
}

async function handleScreenshot(
  request: Request,
  paramsPromise: Promise<{ name: string }>
) {
  const { name } = await paramsPromise
  if (!NAME_RE.test(name)) return jsonError(400, '非法文件名')
  const abs = join(resolveDataDir(), 'screenshots', name)
  const stat = await fs.stat(abs).catch(() => null)
  if (!stat?.isFile()) return jsonError(404, '截图不存在或已被清理')
  return mediaResponse(abs, mimeOf(abs), stat.size, request.headers.get('range'), request.method)
}
