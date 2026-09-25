import { ipcMain } from 'electron'
import { listSkills } from '../services/ai/skills'
import { storage } from '../services/storage'
import type { SkillSettings } from '@shared/types'

/**
 * 技能 IPC：技能发现结果与用户设置（启停 / 额外根目录）。
 *
 * 技能内容在磁盘上（`SKILL.md`），这里只做「扫描 + 读用户选择」，
 * 没有增删改通道 —— 要加技能就往技能目录里放一个目录。
 */
export function registerSkillsIpc(): void {
  ipcMain.handle('skills:list', (_e, workspaceId?: string) => {
    // 工作区已被删除 / 没传：退化成只看全局技能，不报错
    const workspace = workspaceId ? storage.getAgentWorkspace(workspaceId) : undefined
    return listSkills(workspace?.path)
  })
  ipcMain.handle('skills:saveSettings', (_e, patch: Partial<SkillSettings>) =>
    storage.saveSkillSettings(patch)
  )
}
