/**
 * 工作区文件系统（渲染端文件树 / 编辑器用）。
 *
 * 与 Agent 工具共用同一套安全边界与忽略规则：
 * - 所有路径都经 `resolveInside` 校验，落盘范围限定在工作区根目录之内（`..` / 绝对路径直接抛错）；
 * - 列表吃 `.gitignore` 与默认忽略目录，避免把 node_modules / dist 这种上万条目的目录塞进树里。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createIgnoreChecker, relPathOf, resolveInside } from './agent-core'
import type { AgentFsEntry, AgentFsFile, AgentWorkspace } from '@shared/types'

/** 超过这个大小就不往编辑器里读（Monaco 会卡死），提示用户改用别的方式看 */
const MAX_READ_BYTES = 2 * 1024 * 1024

/** 单个目录最多返回多少条目（防御性上限，正常目录远达不到） */
const MAX_ENTRIES = 2000

/** 列出工作区某个目录的直接子项（懒加载：点开一层读一层，不预扫整棵树） */
export async function listWorkspaceDir(
  workspace: AgentWorkspace,
  dir = ''
): Promise<AgentFsEntry[]> {
  const root = workspace.path
  const abs = resolveInside(root, dir)
  const ignore = await createIgnoreChecker(root)
  const dirents = await fs.readdir(abs, { withFileTypes: true })

  const entries: AgentFsEntry[] = []
  for (const d of dirents) {
    // 符号链接 / 设备文件等既不是 file 也不是 dir，直接跳过（跟随链接会破坏越界校验）
    const isDir = d.isDirectory()
    if (!isDir && !d.isFile()) continue
    const rel = relPathOf(root, join(abs, d.name))
    if (ignore(rel, isDir)) continue
    entries.push({ name: d.name, path: rel, type: isDir ? 'dir' : 'file' })
    if (entries.length >= MAX_ENTRIES) break
  }

  // 目录在前，同类按名字排（localeCompare 对中文 / 大小写混排的顺序更自然）
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
  return entries
}

/** 读取工作区内的文本文件 */
export async function readWorkspaceFile(
  workspace: AgentWorkspace,
  path: string
): Promise<AgentFsFile> {
  const abs = resolveInside(workspace.path, path)
  const stat = await fs.stat(abs)
  if (!stat.isFile()) throw new Error('这不是一个文件')
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），暂不支持在编辑器里打开`
    )
  }
  const buf = await fs.readFile(abs)
  // 二进制检测：出现 NUL 字节就当二进制，否则 Monaco 里是一屏乱码
  if (buf.includes(0)) throw new Error('这是二进制文件，无法以文本方式打开')
  return { path, content: buf.toString('utf8'), size: stat.size }
}

/** 保存文本文件（整体覆盖写入） */
export async function writeWorkspaceFile(
  workspace: AgentWorkspace,
  path: string,
  content: string
): Promise<void> {
  const abs = resolveInside(workspace.path, path)
  await fs.writeFile(abs, content, 'utf8')
}
