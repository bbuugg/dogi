/**
 * 工作区快捷功能（`<工作区>/.fizz/workspace.json` 里的 quickActions）的渲染端配套：
 * 类型展示名 / 图标、目标路径解析，以及「点一下执行」的统一入口。
 *
 * 从根应用 `features/agent/quick-action.ts` 迁移：不碰 window.api，
 * 系统能力全部走注入（宿主 openExternal / openPath，命令走工作区内嵌终端）。
 *
 * 三类动作各自的执行方式：
 * - `link`    交给宿主用系统浏览器打开（协议白名单在宿主侧）；
 * - `command` 在**新开的一条**工作区内嵌终端里执行；
 * - `path`    用系统默认程序打开该路径（相对路径按工作区根解析）。
 */
import { FolderOpen, Link2, Terminal } from 'lucide-react'
import type { ComponentType } from 'react'
import type { QuickAction, QuickActionKind } from '@fizz/contracts/workspace-config'

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
  // 渲染端拿不到 process.platform，用 UA 判（拿不到就按 POSIX，符号错了也只是路径分隔符差异）
  const isWindows = /win/i.test(navigator.userAgent)
  const sep = isWindows ? '\\' : '/'
  const base = workspacePath.replace(/[\\/]+$/, '')
  const rest = target
    .replace(/^\.[\\/]/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .join(sep)
  return `${base}${sep}${rest}`
}

/** 执行快捷功能所需的外部能力（由 AgentApp 注入） */
export interface QuickActionRunContext {
  /** 当前工作区根目录（解析相对路径用） */
  workspacePath: string
  /** 在工作区目录的内嵌终端里执行一条命令；失败时抛错 */
  runCommand: (command: string) => Promise<void>
  /** 系统浏览器打开链接 */
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
  /** 系统默认程序打开本地路径；未实现（web）返回不支持提示 */
  openPath: (path: string) => Promise<{ ok: boolean; error?: string }>
}

/** 执行一个快捷功能；返回失败原因（成功返回 null），提示与否由调用方决定 */
export async function runQuickAction(
  action: QuickAction,
  ctx: QuickActionRunContext
): Promise<string | null> {
  try {
    if (action.kind === 'link') {
      const result = await ctx.openExternal(action.target)
      return result.ok ? null : (result.error ?? '打开失败')
    }
    if (action.kind === 'command') {
      await ctx.runCommand(action.target)
      return null
    }
    const result = await ctx.openPath(resolveQuickActionPath(ctx.workspacePath, action.target))
    return result.ok ? null : (result.error ?? '打开失败')
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
