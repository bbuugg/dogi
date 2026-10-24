/**
 * 导出数据（左下角菜单「导入 / 导出」）。
 *
 * POST /api/transfer/export  body `{ kinds: TransferKind[], format: 'zip' | 'json' }`
 *   → `TransferExportResult`（文件内容以 base64 回传，见 `_lib.ts` 的理由）
 *
 * 形态规则：
 * - `format: 'zip'`（缺省）→ 一个压缩包，里面每类一个 JSON（`api.json` / `hosts.json` /
 *   `scripts.json`）—— **与 dogi 的导出包同构**，互相都能读；
 * - `format: 'json'` → 单类一份纯 JSON（与从 dogi 包里解出来的 `api.json` 完全同构）。
 *   只勾了一类才允许，多类时要求 zip —— 一个 `.json` 里塞三类数据，那个文件谁都不认识。
 */
import { Buffer } from 'node:buffer'
import { FILE_OF } from '@fizz/workspace'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { pickFormat, pickKinds, stampFileName, zipPayloads } from '../_lib'

export async function POST(request: Request) {
  const body = await parseJsonBody<{ kinds?: unknown; format?: unknown }>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')

  const kinds = pickKinds(body.kinds)
  if (kinds.length === 0) return jsonError(400, '没有选择要导出的数据')
  const format = pickFormat(body.format)
  if (format === 'json' && kinds.length !== 1) {
    return jsonError(400, '单文件 JSON 一次只能导出一类数据；多类请用 zip')
  }

  try {
    const { payloads, counts } = domain.exportTransfer(kinds)

    if (format === 'json') {
      const payload = payloads[0]
      const text = JSON.stringify(payload, null, 2)
      return Response.json({
        fileName: FILE_OF[payload.kind],
        mime: 'application/json',
        dataBase64: Buffer.from(text, 'utf8').toString('base64'),
        counts
      })
    }

    const zip = zipPayloads(payloads.map((p) => ({ name: FILE_OF[p.kind], payload: p })))
    return Response.json({
      fileName: stampFileName('zip'),
      mime: 'application/zip',
      dataBase64: zip.toString('base64'),
      counts
    })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
