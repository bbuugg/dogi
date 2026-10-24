/**
 * 工作区目录配置的落盘层（`<工作区>/.fizz/workspace.json`）。
 *
 * 与根应用主进程的 `src/main/services/ai/workspace-config.ts` 同一套语义：
 * 配置跟着项目走（换机器 / 复制目录都还在）；目录缺失就地补齐（含 .gitignore），
 * 工作区目录本身不存在时不创建任何东西直接抛错；JSON 损坏不覆盖原文件，
 * 返回默认配置 + `error` 由 UI 提示。
 *
 * server 版让 web 端也能通过 HTTP 读写；desktop 进程内调用同一份 Hono 路由。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_APPROVED_COMMANDS,
  MAX_APPROVED_COMMAND_LENGTH,
  WORKSPACE_CONFIG_DIR,
  WORKSPACE_CONFIG_FILE,
  createEmptyWorkspaceConfig,
  normalizeWorkspaceConfig,
  type WorkspaceConfig,
  type WorkspaceConfigSnapshot
} from '@fizz/contracts/workspace-config'
import type { AgentWorkspace } from '@fizz/contracts/agent-api'

/** 隐藏目录自带一份 .gitignore，配置属于本地环境数据，不该被提交 */
const GITIGNORE_CONTENT = '# Fizz 工作区配置（本地环境数据，不入版本库）\n*\n'

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
 * 确保工作区内的隐藏配置目录就绪（`.fizz/` + `.gitignore` + `workspace.json`）。
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

// ---------- 免确认命令（confirm 档审批卡上「始终允许」的落点） ----------

/**
 * 读工作区的免确认命令清单。**纯读**：文件缺失 / JSON 损坏一律按空清单返回，
 * 不建目录、不写盘（读不出来就多问一次用户，是安全方向的失效）。
 *
 * confirm-gate 每次 `requestConfirm` 都现调它 —— 用户手改 workspace.json
 * （比如删掉某条命令）后，**下一次工具调用立刻恢复询问**，不需要重启。
 */
export async function approvedCommandsOf(workspacePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(workspaceConfigPaths(workspacePath).filePath, 'utf8')
    return normalizeWorkspaceConfig(JSON.parse(raw)).approvedCommands
  } catch {
    return []
  }
}

/**
 * 把一条命令记进免确认清单（读-改-写，quickActions / defaultTerminal 原样保留）。
 *
 * 返回 false = 没写盘（空串 / 超长 / 已在清单里 —— 前两者由调用方退回内存记忆）。
 * JSON 损坏时**抛错且绝不覆盖**：用户可能正手改到一半，把整份配置冲成默认值
 * 不可接受；调用方接住后退回内存记忆即可。
 */
export async function rememberApprovedCommand(
  workspacePath: string,
  command: string
): Promise<boolean> {
  const cmd = command.trim()
  if (!cmd || cmd.length > MAX_APPROVED_COMMAND_LENGTH) return false
  const { filePath } = workspaceConfigPaths(workspacePath)
  if (!(await ensureWorkspaceConfigDir(workspacePath))) {
    throw new Error(`工作区目录不存在：${workspacePath}`)
  }

  let raw = ''
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    // 刚 ensure 过还读不到 = 被并发删了：按空配置继续，下面会把完整配置写回去
  }
  let current: WorkspaceConfig
  if (raw) {
    try {
      current = normalizeWorkspaceConfig(JSON.parse(raw))
    } catch {
      throw new Error(`工作区配置不是合法 JSON，未写入免确认命令：${filePath}`)
    }
  } else {
    current = createEmptyWorkspaceConfig()
  }

  if (current.approvedCommands.includes(cmd)) return true
  const approvedCommands = [...current.approvedCommands, cmd]
  // 封顶丢最旧的：这份文件是给人手改的，宁可让老条目恢复询问也不能无限膨胀
  while (approvedCommands.length > MAX_APPROVED_COMMANDS) approvedCommands.shift()
  await fs.writeFile(filePath, serialize({ ...current, approvedCommands }), 'utf8')
  return true
}
