/**
 * `GET /api/files/trash` —— 回收站清单（新的在前）。
 *
 * 回收站是**程序自己管的目录**（`<dataDir>/file-manager-trash`，见 `file-manager/trash.ts`），
 * 界面按「回收站模式」渲染它，不走普通目录浏览 —— 这样「还原 / 彻底删除」才有点可指。
 */
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { listTrash } from '@/lib/server/file-manager/trash'

export async function GET() {
  try {
    return Response.json({ items: await listTrash() })
  } catch (err) {
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
