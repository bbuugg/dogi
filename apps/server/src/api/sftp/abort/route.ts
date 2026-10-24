/**
 * 取消一笔进行中的 SFTP 上传：`POST /api/sftp/abort`（body: `SftpAbortInput`）。
 *
 * 两件事，**顺序不能反**：
 * 1. 销毁在途写流（按 `transferId`，幂等）；
 * 2. **删掉已写入的半份文件**（`hostId` + `dir` + `name`）。
 *
 * ⚠️ 第 2 步是分片协议带来的**新增必要动作**。旧的一次性协议里文件只有「完整」和
 * 「不存在」两种状态，停流就够了；分片之后，传了一半的文件是**真实存在且内容完整**的
 * 一堆前缀字节 —— 只停流会留下一个「看起来成功」的坏文件。
 *
 * ⚠️ 先停流再删：反过来的话，在途那一片可能正把字节写回刚被删掉的文件。
 *
 * ⚠️ 清理走 `removeFileIfExists` 而**不是** `sftpService.remove()`：后者是递归删除
 * （等价 `rm -rf`），而这里的路径是客户端给的 `dir` + `name` 拼出来的 —— 万一远端恰好
 * 有一个同名**目录**，一次取消就会把它整棵删掉。
 *
 * **幂等**：找不到 `transferId`（已经传完 / 已经取消过）也回 204，不报错 —— 用户点
 * 「取消」时那笔传输正好结束，是很正常的事，为此回一个错误只会让客户端在「取消」这条
 * 路上还要处理失败分支。`removeFileIfExists` 本身也是幂等的。
 *
 * 为什么不让服务端「靠请求断开」自己判断：desktop 的 IPC 桥断开时不一定有信号传回来，
 * 而且一次拖入的多个文件要能各自取消（见 `SftpUploadChunkInput.transferId`）。
 *
 * 鉴权由根中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import type { SftpAbortInput } from '@fizz/contracts/agent-api'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { joinSftpPath, sftpService } from '@/lib/server/ssh/sftp'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<SftpAbortInput>(request)
  const transferId = typeof body?.transferId === 'string' ? body.transferId.trim() : ''
  const hostId = typeof body?.hostId === 'string' ? body.hostId.trim() : ''
  const dir = typeof body?.dir === 'string' ? body.dir.trim() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''

  /**
   * ⚠️ 四个字段**全部必填**，不做「缺了就只销毁流」的宽容：漏传 `dir` / `name` 的后果
   * 正是「半份文件被静默留下」—— 那恰恰是这次要修的病。宁可当场 400，也不要让它看起来成功。
   */
  if (!transferId || !hostId || !dir || !name) {
    return jsonError(400, '缺少 transferId / hostId / dir / name')
  }
  // 拼路径的口子仍要堵：`removeFileIfExists` 只删文件，但路径不该由客户端随意决定
  if (name.includes('/') || name.includes('\\')) {
    return jsonError(400, 'name 只能是文件名，不能带路径分隔符')
  }

  sftpService.abortTransfer(transferId) // ① 销毁在途写流（幂等）
  await sftpService.removeFileIfExists(hostId, joinSftpPath(dir, name)) // ② 删半份文件
  return new Response(null, { status: 204 })
}
