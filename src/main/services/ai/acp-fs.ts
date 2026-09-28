import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/**
 * ACP agent 借客户端读写文件（`fs/read_text_file` / `fs/write_text_file`）。
 *
 * ⚠️ 只允许**工作区内**的路径：agent 是我们 spawn 的外部进程，不能让它借这条通道
 * 读写工作区外的文件。越界时抛错，ACP 会把它当成 JSON-RPC error 回给 agent
 * （表现为那次工具调用失败），而不是静默改坏别处的文件。
 *
 * 单独成文件（不 import electron）是为了能直接跑真代码验证：见 `scripts/verify-acp-fs.ts`。
 */
export function resolveInsideWorkspace(root: string, target: string): string {
  const resolved = isAbsolute(target) ? resolve(target) : resolve(root, target)
  const rel = relative(root, resolved)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`拒绝访问工作区外的路径：${target}`)
  }
  return resolved
}

/** 读文本文件；ACP 的 `line` 是 1-based 起始行，`limit` 是行数 */
export async function readWorkspaceTextFile(
  root: string,
  path: string,
  line?: number | null,
  limit?: number | null
): Promise<string> {
  const text = await readFile(resolveInsideWorkspace(root, path), 'utf8')
  if (!line && !limit) return text
  const lines = text.split('\n')
  const start = Math.max(0, (line ?? 1) - 1)
  return lines.slice(start, limit ? start + limit : undefined).join('\n')
}

/** 写文本文件；父目录不存在时自动建（agent 常用来落新文件） */
export async function writeWorkspaceTextFile(
  root: string,
  path: string,
  content: string
): Promise<void> {
  const full = resolveInsideWorkspace(root, path)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}
