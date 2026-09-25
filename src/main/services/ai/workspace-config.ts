/**
 * 工作区目录配置的落盘层：`<工作区>/.dogi/workspace.json`。
 *
 * 与 electron-store 那份配置不同，这里是**直接读写工作区目录里的文件**：
 * 配置跟着项目走，换机器 / 复制目录都还在。所以目录由本文件负责创建与补齐
 * （目录存在但文件缺失时自动补一份默认配置），并且首次创建时写一份 `.gitignore`
 * 把整个目录排除在版本库之外。
 *
 * 工作区目录本身不存在（用户填了个已删除的路径）时**不创建任何东西**，
 * 直接抛错让渲染端提示 —— 别在没有项目的地方凭空造出一串目录。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  WORKSPACE_CONFIG_DIR,
  WORKSPACE_CONFIG_FILE,
  createEmptyWorkspaceConfig,
  normalizeWorkspaceConfig,
  type WorkspaceConfig,
  type WorkspaceConfigSnapshot
} from '@shared/workspace-config'
import type { AgentWorkspace } from '@shared/types'

/** 隐藏目录自带一份 .gitignore，配置属于本地环境数据，不该被提交 */
const GITIGNORE_CONTENT = '# Dogi 工作区配置（本地环境数据，不入版本库）\n*\n'

/** 配置目录 / 配置文件在工作区内的绝对路径 */
export function workspaceConfigPaths(workspacePath: string): { dir: string; filePath: string } {
  const dir = join(workspacePath, WORKSPACE_CONFIG_DIR)
  return { dir, filePath: join(dir, WORKSPACE_CONFIG_FILE) }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

function serialize(config: WorkspaceConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * 确保工作区内的隐藏配置目录就绪（`.dogi/` + `.gitignore` + `workspace.json`）。
 *
 * 已存在的一律不动（尤其是 `workspace.json`，绝不能覆盖用户配好的快捷功能），
 * 只补缺失的那几个文件。返回工作区目录是否存在 —— false 表示什么都没做。
 */
export async function ensureWorkspaceConfigDir(workspacePath: string): Promise<boolean> {
  if (!(await isDirectory(workspacePath))) return false

  const { dir, filePath } = workspaceConfigPaths(workspacePath)
  await fs.mkdir(dir, { recursive: true })

  const gitignore = join(dir, '.gitignore')
  if (!(await exists(gitignore))) await fs.writeFile(gitignore, GITIGNORE_CONTENT, 'utf8')
  if (!(await exists(filePath))) {
    await fs.writeFile(filePath, serialize(createEmptyWorkspaceConfig()), 'utf8')
  }
  return true
}

/**
 * 读取工作区配置：目录 / 文件缺失会就地补齐。
 *
 * JSON 损坏时**不覆盖原文件**（用户可能只是少写了一个逗号，下次保存才由 UI 覆盖），
 * 而是返回默认配置 + `error` 说明，由 UI 提示。
 */
export async function readWorkspaceConfig(
  workspace: AgentWorkspace
): Promise<WorkspaceConfigSnapshot> {
  const { dir, filePath } = workspaceConfigPaths(workspace.path)
  if (!(await ensureWorkspaceConfigDir(workspace.path))) {
    throw new Error(`工作区目录不存在：${workspace.path}`)
  }

  let raw = ''
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    // 上层 ensure 刚补过，这里再失败只能是被并发删了：按空配置返回
    return { dir, filePath, config: createEmptyWorkspaceConfig() }
  }

  try {
    return { dir, filePath, config: normalizeWorkspaceConfig(JSON.parse(raw)) }
  } catch {
    return {
      dir,
      filePath,
      config: createEmptyWorkspaceConfig(),
      error: `配置文件不是合法的 JSON，已按空配置加载：${filePath}（修复或删除该文件后重试）`
    }
  }
}

/** 保存工作区配置（整体覆盖写入，内容先规整一遍） */
export async function saveWorkspaceConfig(
  workspace: AgentWorkspace,
  input: unknown
): Promise<WorkspaceConfigSnapshot> {
  const { dir, filePath } = workspaceConfigPaths(workspace.path)
  if (!(await ensureWorkspaceConfigDir(workspace.path))) {
    throw new Error(`工作区目录不存在：${workspace.path}`)
  }
  const config = normalizeWorkspaceConfig(input)
  await fs.writeFile(filePath, serialize(config), 'utf8')
  return { dir, filePath, config }
}
