/**
 * 移除一个笔记根目录。
 *
 * ⚠️ **只摘登记，不动磁盘**（`deleteNotesRoot` 只改 store）—— 笔记是用户自己的资料，
 * 从侧栏移除不该让它少一个文件。
 */
import { jsonError } from '@/app/api/_lib/auth'
import { domain } from '@/lib/server/state'

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!domain.deleteNotesRoot(id)) return jsonError(404, '笔记目录不存在')
  return new Response(null, { status: 204 })
}
