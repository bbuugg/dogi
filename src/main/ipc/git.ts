import { ipcMain } from 'electron'
import {
  getGitBranches,
  getGitDiff,
  getGitLog,
  getGitStatus,
  listGitDir,
  runGitAction
} from '../services/git'
import type { GitAction } from '@shared/types'

/**
 * Git（源代码管理）IPC：渲染端的「源代码管理」面板走这里。
 *
 * 所有接口都以工作区目录（cwd）为入口，由主进程定位真正的仓库根（git rev-parse --show-toplevel）。
 * 写操作统一把 git 的原话（成功输出或失败 stderr）回传，渲染端直接展示。
 */
export function registerGitIpc(): void {
  ipcMain.handle('git:status', (_e, cwd: string) => getGitStatus(cwd))
  ipcMain.handle('git:branches', (_e, cwd: string, pruneRemote?: boolean) => getGitBranches(cwd, pruneRemote ?? false))
  ipcMain.handle('git:log', (_e, cwd: string, n?: number) => getGitLog(cwd, n ?? 30))
  ipcMain.handle('git:diff', (_e, cwd: string, path: string, staged: boolean) =>
    getGitDiff(cwd, path, staged)
  )
  ipcMain.handle('git:action', (_e, cwd: string, action: GitAction) => runGitAction(cwd, action))
  // 目录条目（未跟踪的目录 / 嵌套仓库）里的文件列表：git 不跨仓库边界，只能自己读盘
  ipcMain.handle('git:dirList', (_e, cwd: string, path: string) => listGitDir(cwd, path))
}
