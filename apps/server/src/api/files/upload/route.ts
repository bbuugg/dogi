/**
 * `POST /api/files/upload` —— 上传**一个**文件到目标目录。
 *
 * ⚠️ **JSON + base64，禁止 multipart/FormData**：desktop 的 IPC 桥 body 只支持字符串，
 * FormData 会被静默丢成空 body（AGENTS.md 的硬约束）。
 *
 * 一个文件一次请求：客户端按文件循环，进度条才有「第 3 / 共 12 个」可言；上传文件夹时
 * 客户端先把目录建好（`op: mkdir`）再逐个传，路径结构就保住了。
 *
 * 同名不覆盖：默认回 **409**，把「覆盖吗」交给用户（`overwrite: true` 才是显式同意）。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { FmOpResult, FmUploadInput } from '@fizz/contracts/agent-api'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { assertEntryName, normalizeTarget } from '@/lib/server/file-manager/paths'

export async function POST(request: Request) {
  const body = await parseJsonBody<FmUploadInput>(request)
  if (!body || typeof body.dir !== 'string' || typeof body.name !== 'string') {
    return jsonError(400, '请求体缺少 dir / name')
  }
  try {
    const dir = normalizeTarget(body.dir)
    const name = assertEntryName(body.name)
    const stat = await fs.stat(dir).catch(() => null)
    if (!stat?.isDirectory()) return jsonError(400, `目标目录不存在：${dir}`)

    const target = join(dir, name)
    const exists = await fs
      .lstat(target)
      .then(() => true)
      .catch(() => false)
    if (exists && body.overwrite !== true) return jsonError(409, `「${name}」已存在`)

    const data = Buffer.from(body.dataBase64 ?? '', 'base64')
    await fs.writeFile(target, data)
    return Response.json({ paths: [target] } satisfies FmOpResult)
  } catch (err) {
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
