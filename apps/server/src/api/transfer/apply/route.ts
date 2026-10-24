/**
 * 执行导入（左下角菜单「导入数据…」的第二步，真正写库）。
 *
 * POST /api/transfer/apply  body `{ dataBase64: string, fileName?: string, kinds: TransferKind[] }`
 *   → `TransferImportResult`（`{ added, updated, skipped }`，按类型分列）
 *
 * 只写 `kinds` 里勾中的那几类：界面勾掉了就不动它（一个包里三类数据全有是常态，
 * 但用户可能只想恢复接口请求）。
 *
 * 落盘走 `domain.importTransfer` → `store.mutate`，而 `state.ts` 的 live store 会在每次
 * `mutate` 后自动标脏全部 store 域，所以前端不需要在这里另发通知。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { decodeBase64, parseBundle, pickKinds } from '../_lib'

export async function POST(request: Request) {
  const body = await parseJsonBody<{
    dataBase64?: unknown
    fileName?: unknown
    kinds?: unknown
  }>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')

  const kinds = pickKinds(body.kinds)
  if (kinds.length === 0) return jsonError(400, '没有选择要导入的数据')

  try {
    const buf = decodeBase64(body.dataBase64)
    const fileName = typeof body.fileName === 'string' ? body.fileName : ''
    const { payloads } = parseBundle(buf, fileName)
    return Response.json(domain.importTransfer(payloads, kinds))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
