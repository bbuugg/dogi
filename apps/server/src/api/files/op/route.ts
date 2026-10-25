/**
 * `POST /api/files/op` —— 所有**改动**动作的总线（新建 / 改名 / 复制 / 移动 / 删除 /
 * 还原 / 写文本 / 压缩 / 解压）。
 *
 * 为什么合成一条：这些动作的错误语义与应答形状完全一致（`FmOpResult`），拆成十几个
 * 路由只会让前端多十几个薄封装。真正的实现全部在 `lib/server/file-manager/ops.ts`，
 * 这里只负责「JSON → 领域函数 → JSON」以及**冲突映射成 409**。
 */
import type { FmOpInput } from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { ConflictError, runOp } from '@/lib/server/file-manager/ops'

export async function POST(request: Request) {
  const body = await parseJsonBody<FmOpInput>(request)
  if (!body || typeof body !== 'object' || !('op' in body)) {
    return jsonError(400, '请求体不是合法的文件操作')
  }
  try {
    return Response.json(await runOp(body))
  } catch (err) {
    // 同名冲突单独给 409：界面上「换个名字」与「真出错了」是两种提示
    if (err instanceof ConflictError) return jsonError(409, err.message)
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
