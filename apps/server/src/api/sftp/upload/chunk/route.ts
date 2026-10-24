/**
 * 上传**一个分片**到远端主机：`POST /api/sftp/upload/chunk`（body: `SftpUploadChunkInput`）。
 *
 * 「把本地文件拖进 SSH 终端」的服务端落点。客户端把文件切成 `SFTP_CHUNK_BYTES` 大小的
 * 片、**串行**发过来；服务端只做「打开 → 写 → 关」，**不持有任何跨请求状态**。
 *
 * 分片语义由 `index` 决定：
 * - `index === 0` → `'w'` 截断创建，并逐层创建 `dir`；
 * - 其余 → `'a'` 追加。
 *
 * ⚠️ **「同名文件直接覆盖」这条既有语义就落在 `index === 0` 的 `'w'` 上**（拖拽是用户的
 * 显式动作，再弹一次「要不要覆盖」收益很低；要保留旧的请改名）。
 *
 * ⚠️ 服务端**校验不了分片顺序** —— 无状态换来了「没有会话回收、重启与多实例无感」，
 * 代价就是这个。客户端必须串行发；并发写同一个追加流会**静默**损坏文件内容。
 *
 * 协议与校验思路照抄 `/api/workspaces/:id/files/upload`：**base64 + JSON**，不用 multipart
 * （desktop 的 IPC 桥 body 只支持字符串，`FormData` 会被静默丢掉），base64 严格校验
 * （`Buffer.from` 对非法字符是宽容解码，会静默产出脏字节）。
 *
 * 取消语义见 `SftpUploadChunkInput.transferId`：取消**不算错误**，回 200 + `canceled`，
 * 由客户端决定怎么提示。
 *
 * 鉴权由根中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import {
  SFTP_CHUNK_BYTES,
  type SftpUploadChunkInput,
  type SftpUploadChunkResult
} from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { isTransferCancelled, sftpService } from '@/lib/server/ssh/sftp'

/** base64 严格形状（容忍空白与缺 padding）：非法字符会让解码静默产出脏字节 */
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<SftpUploadChunkInput>(request)
  if (!body) return jsonError(400, '缺少请求体')

  const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
  if (!hostId) return jsonError(400, '缺少 hostId')
  const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
  if (!dir) return jsonError(400, '缺少 dir')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return jsonError(400, '缺少 name')
  /**
   * 文件名必须是**纯文件名**。带分隔符就等于让客户端绕过 `dir` 决定写到哪 ——
   * 拼接交给服务端的 `joinSftpPath`，这里先把口子堵上。
   */
  if (name.includes('/') || name.includes('\\')) {
    return jsonError(400, 'name 只能是文件名，不能带路径分隔符')
  }
  // 分片序号：从 0 起、连续递增。0 = 截断创建，其余 = 追加（见文件头）
  const index = Number(body.index)
  if (!Number.isInteger(index) || index < 0) return jsonError(400, 'index 必须是非负整数')

  if (typeof body.dataBase64 !== 'string' || !BASE64_RE.test(body.dataBase64)) {
    return jsonError(400, '分片内容不是合法 base64')
  }
  const bytes = Buffer.from(body.dataBase64, 'base64')
  /**
   * ⚠️ 空片**只在 `index === 0` 时合法**：零字节文件就是靠那一片空片把远端文件建出来的
   * （`'w'` 截断成一个空文件）。若这里一刀切成「内容为空就 400」，零字节文件会**静默
   * 传不过去**（客户端以为传完了，远端什么都没有）。
   *
   * 其余 index 收到空片说明客户端分片算错了 —— 放行会静默写出一个不完整的文件，
   * 而且后续分片还会接在它后面，从任何日志里都看不出异常。
   */
  if (bytes.length === 0 && index !== 0) return jsonError(400, '分片内容为空')
  // 单片上限（**不再是总量上限**：文件多大都能传，只是多切几片）
  if (bytes.length > SFTP_CHUNK_BYTES) {
    return jsonError(400, `单个分片超过上限（${SFTP_CHUNK_BYTES / 1024 / 1024}MB）`)
  }

  const transferId = typeof body.transferId === 'string' ? body.transferId.trim() : undefined

  try {
    await sftpService.appendFile(hostId, dir, name, bytes, {
      index,
      ...(transferId ? { transferId } : {})
    })
    return Response.json({ ok: true } satisfies SftpUploadChunkResult)
  } catch (err) {
    // 取消不是错误：客户端可能已经 abort 掉了这条请求、读不到这个应答，
    // 但对「abort 先到、上传后失败」的次序仍要给一个语义正确的答案
    if (isTransferCancelled(err)) {
      return Response.json({ ok: false, canceled: true } satisfies SftpUploadChunkResult)
    }
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
