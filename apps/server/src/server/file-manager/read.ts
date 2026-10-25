/**
 * 文件内容读取（预览 / 文本编辑用）。
 *
 * 与 `/api/files/content` 的分工：
 * - 这里回 **JSON**（文本 utf8 / 二进制 base64），给预览面板与文本编辑器用，**有大小上限**；
 * - 那里回**原始字节 + Range**，给 `<img>` / `<video>` / `<iframe>` 用，不经过内存。
 *
 * 二进制判定不靠扩展名而看**内容里有没有 NUL**：`README`（无扩展名）、`.env`、`.gitignore`
 * 都是正经文本，靠扩展名会判错；而真正的二进制文件（png / zip）头几个字节里必有 0。
 */
import { promises as fs } from 'node:fs'
import type { FmReadResult } from '@fizz/contracts/agent-api'
import { normalizeTarget } from './paths'

/** 文本预览上限：2MB —— 一个 2MB 的纯文本已经是 5 万行，再大浏览器渲染就开始卡 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** 二进制走 base64 会更胖（4/3），上限给 8MB */
const MAX_BINARY_BYTES = 8 * 1024 * 1024

/** 头 8KB 里有 NUL 就当二进制（与 Git / grep 的判定口径一致） */
function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192)
  return head.includes(0)
}

/** 读一个文件（`path` 必须是文件；目录会被 `lstat` 判出来并报错） */
export async function readPath(path?: string | null): Promise<FmReadResult> {
  const abs = normalizeTarget(path)
  const stat = await fs.lstat(abs)
  if (stat.isDirectory()) throw new Error('这是一个目录，不能当文件读')

  const handle = await fs.open(abs, 'r')
  try {
    const headSize = Math.min(Number(stat.size) || 0, 8192)
    const head = Buffer.alloc(headSize)
    if (headSize > 0) await handle.read(head, 0, headSize, 0)

    if (looksBinary(head)) {
      if (Number(stat.size) > MAX_BINARY_BYTES) {
        throw new Error('二进制文件超过 8MB，请下载后再看')
      }
      const data = await fs.readFile(abs)
      return {
        path: abs,
        content: data.toString('base64'),
        encoding: 'base64',
        size: data.length,
        truncated: false
      }
    }

    const limit = Math.min(Number(stat.size) || 0, MAX_TEXT_BYTES)
    const data = Buffer.alloc(limit)
    if (limit > 0) await handle.read(data, 0, limit, 0)
    return {
      path: abs,
      content: data.toString('utf8'),
      encoding: 'utf8',
      size: Number(stat.size) || 0,
      truncated: Number(stat.size) > MAX_TEXT_BYTES
    }
  } finally {
    await handle.close()
  }
}
