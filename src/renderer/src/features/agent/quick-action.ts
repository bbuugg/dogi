/**
 * 工作区快捷功能（`<工作区>/.dogi/workspace.json` 里的 quickActions）的渲染端配套：
 * 类型展示名 / 图标、目标路径解析，以及「点一下执行」的统一入口。
 *
 * 三类动作各自的执行方式：
 * - `link`    交给主进程用系统浏览器打开（协议白名单在 openExternalSafe 里）；
 * - `command` 交给 AgentPage 的内嵌终端（在工作区目录下执行）；
 * - `path`    用系统默认程序打开该路径（相对路径按工作区根解析）。
 */
import { FolderOpen, Link2, Terminal } from 'lucide-react'
import type { ComponentType } from 'react'
import type { QuickAction, QuickActionKind } from '@shared/workspace-config'

/** 三类快捷功能的展示名（表单下拉与列表共用） */
export const QUICK_ACTION_KIND_LABELS: Record<QuickActionKind, string> = {
  link: '打开链接',
  command: '执行命令',
  path: '打开路径'
}

/** 表单里「目标」输入框的提示语 */
export const QUICK_ACTION_TARGET_HINTS: Record<QuickActionKind, string> = {
  link: 'https://example.com',
  command: 'npm run dev（在工作区目录的终端里执行）',
  path: 'src/index.ts（相对工作区，也可填绝对路径）'
}

export const QUICK_ACTION_ICONS: Record<QuickActionKind, ComponentType<{ className?: string }>> = {
  link: Link2,
  command: Terminal,
  path: FolderOpen
}

/** 目标是否已是绝对路径（Windows 盘符 / UNC / POSIX 根） */
function isAbsoluteTarget(target: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('/') || target.startsWith('\\\\')
}

/** 把目标解析成绝对路径：绝对路径原样返回，相对路径按工作区根拼接 */
export function resolveQuickActionPath(workspacePath: string, target: string): string {
  if (isAbsoluteTarget(target)) return target
  const sep = window.api.app.platform === 'win32' ? '\\' : '/'
  const base = workspacePath.replace(/[\\/]+$/, '')
  const rest = target
    .replace(/^\.[\\/]/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .join(sep)
  return `${base}${sep}${rest}`
}

/** 执行快捷功能所需的外部能力（由 AgentPage 注入，见 WorkspaceQuickActions 的 props） */
export interface QuickActionRunContext {
  /** 当前工作区根目录（解析相对路径用） */
  workspacePath: string
  /** 在工作区目录的内嵌终端里执行一条命令；失败时抛错 */
  runCommand: (command: string) => Promise<void>
}

/** 执行一个快捷功能；返回失败原因（成功返回 null），提示与否由调用方决定 */
export async function runQuickAction(
  action: QuickAction,
  ctx: QuickActionRunContext
): Promise<string | null> {
  try {
    if (action.kind === 'link') {
      await window.api.app.openExternal(action.target)
      return null
    }
    if (action.kind === 'command') {
      await ctx.runCommand(action.target)
      return null
    }
    const result = await window.api.shell.openFileManager(
      resolveQuickActionPath(ctx.workspacePath, action.target)
    )
    return result.ok ? null : (result.error ?? '打开失败')
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
