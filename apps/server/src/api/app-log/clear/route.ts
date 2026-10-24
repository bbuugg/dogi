/**
 * 应用日志：清空（内存 + 落盘）。
 *
 * DELETE /api/app-log/clear → AppLogResult（清空后的快照）
 *
 * 用 DELETE 而不是 POST：语义是「删掉现有日志」，且没有任何请求体。
 * 返回清空后的快照，前端一次请求就能把本地状态换新，不用再拉一次 `GET /api/app-log`。
 */
import { clearAppLog } from '@/lib/server/app-log/service'

export async function DELETE() {
  // 会连终端会话文件（`logs/terminal/`）一起删，所以是异步的
  return Response.json(await clearAppLog())
}
