/**
 * 解析导入包，**只看不写**（左下角菜单「导入数据…」的第一步）。
 *
 * POST /api/transfer/inspect  body `{ dataBase64: string, fileName?: string }`
 *   → `TransferInspectResult`（`{ format, entries }`）
 *
 * 为什么要分成两步（inspect → apply）：导入是**覆盖式**的（同 id 会被替换），
 * 先让用户看清「这一包里有什么、各多少条、多少个分组」再决定导哪几类，
 * 比选完文件直接闷头写库安全。同 dogi 的 pick → apply。
 *
 * 包的内容留在**客户端**（apply 时再传一次），服务端不缓存会话 —— 少一份会过期的状态。
 */
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { decodeBase64, parseBundle } from '../_lib'

export async function POST(request: Request) {
  const body = await parseJsonBody<{ dataBase64?: unknown; fileName?: unknown }>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')

  try {
    const buf = decodeBase64(body.dataBase64)
    const fileName = typeof body.fileName === 'string' ? body.fileName : ''
    return Response.json(parseBundle(buf, fileName))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
