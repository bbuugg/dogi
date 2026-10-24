/**
 * 读远端文件的一段：`POST /api/sftp/download/chunk`（body: `SftpDownloadChunkInput`）。
 *
 * 「SFTP 文件管理」标签里点「下载」的服务端落点。客户端按 `offset` 逐段拉，直到应答里的
 * `eof` 为真。协议与上传同源：**JSON + base64**（不用流 / multipart，理由见
 * `SftpUploadChunkInput` 的说明）—— 渲染端两端同一套代码。
 *
 * **不再按 lstat 判大小**：那是旧的一次性协议的产物（整份文件要驻留内存，只能画一条
 * 100MB 的线）。分片之后每次只读 `length` 字节，内存峰值与文件大小脱钩；文件总大小由
 * 调用方从文件列表的 `SftpEntry.size` 拿，不必再问服务端一趟。
 *
 * **没有 `transferId`、也没有 abort**：下载是「客户端拉」，不拉了就是取消，服务端这边
 * 没有在途状态要收拾。这是无状态白拿的一处简化。
 *
 * 文件以字节回到渲染端后由渲染端落盘：服务端很可能跟浏览器不在同一台机器上
 * （web 部署形态），它看不见用户的本地磁盘，没有「下载到某路径」这回事。
 *
 * 鉴权由根中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import {
  SFTP_CHUNK_BYTES,
  type SftpDownloadChunkInput,
  type SftpDownloadChunkResult
} from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { sftpService } from '@/lib/server/ssh/sftp'
import { isEof } from '@/lib/server/ssh/sftp-chunk'

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<SftpDownloadChunkInput>(request)
  if (!body) return jsonError(400, '缺少请求体')

  const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
  if (!hostId) return jsonError(400, '缺少 hostId')
  const path = typeof body.path === 'string' ? body.path.trim() : ''
  if (!path) return jsonError(400, '缺少 path')

  const offset = Number(body.offset)
  if (!Number.isInteger(offset) || offset < 0) return jsonError(400, 'offset 必须是非负整数')
  const length = Number(body.length)
  if (!Number.isInteger(length) || length <= 0) return jsonError(400, 'length 必须是正整数')
  // 单片上限：挡畸形请求。调用方按 SFTP_CHUNK_BYTES 切片，正常不会超
  if (length > SFTP_CHUNK_BYTES) {
    return jsonError(400, `单个分片超过上限（${SFTP_CHUNK_BYTES / 1024 / 1024}MB）`)
  }

  try {
    const buf = await sftpService.readRange(hostId, path, offset, length)
    return Response.json({
      dataBase64: buf.toString('base64'),
      // 「读到的比请求的少」= 到尾了。别改成「读到的为空」：offset 恰好落在文件末尾时
      // 也是 0 字节，那同样是 eof
      eof: isEof(buf.length, length)
    } satisfies SftpDownloadChunkResult)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
