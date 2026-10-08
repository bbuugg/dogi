import { ipcMain } from 'electron'
import {
  cloneRepo,
  getGitBranches,
  getGitDiff,
  getGitLog,
  getGitStatus,
  gitVersion,
  listGitDir,
  runGitAction
} from '../services/git'
import type { GitAction } from '@shared/types'

/**
 * Git（源代码管理）IPC：渲染端的「源代码管理」面板走这里。
 *
 * 所有接口都以工作区目录（cwd）为入口，由主进程定位真正的仓库根（git rev-parse --show-toplevel）。
 * 写操作统一把 git 的原话（成功输出或失败 stderr）回传，渲染端直接展示。
 *
 * 例外两个不是「对某个仓库」而是「对这台机器 / 磁盘」的：`git:version`（装没装 git）、
 * `git:clone`（克隆出一个**新工作区目录**，所以额外接收目标路径而不是 cwd）。
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
  // 这台机器装没装 git：面板据此给「未安装」的引导，而不是让用户对着一句 spawn ENOENT 发呆
  ipcMain.handle('git:version', () => gitVersion())
  // 克隆仓库到 destDir（必须不存在）；返回克隆后的目录，由渲染端接着建工作区
  ipcMain.handle('git:clone', (_e, url: string, destDir: string) => cloneRepo({ url, destDir }))
}
