/**
 * server 端技能发现：根目录与扫描顺序和桌面端**共用同一份**（`standardSkillRoots`
 * / `scanSkillRoots`），差别只在这里的设置来自服务端自己的 JSON 存储。
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { scanSkillRoots, standardSkillRoots } from './skills-scan'
import type { SkillInfo, SkillListResult, SkillRootInfo, SkillSettings } from './types'

/**
 * 技能设置的最小读取面。用结构化接口而不是直接引 `@fizz/workspace` 的 `AgentDomain` 类型：
 * 那会让本包反向依赖领域包（而编排层又依赖本包），包之间成环。
 * AgentDomain 按结构满足它，调用方照旧把 domain 传进来即可。
 */
export interface SkillSettingsProvider {
  getSkillSettings(): SkillSettings
}

/** 用户级技能目录（不存在就建出来，方便管理员直接往里放技能） */
export function userSkillsDir(home = homedir()): string {
  return `${home}/.fizz/skills`
}

/**
 * 扫出技能与各根的扫描情况。
 *
 * `opts.builtinDir` 由宿主给（见 `standardSkillRoots` 关于「本包不做路径探测」的说明）——
 * 服务端的唯一调用方是 `apps/server/src/server/skill-roots.ts`，那里把内置根与 home 一起填上。
 */
export async function discoverSkills(
  domain: SkillSettingsProvider,
  opts: { workspacePath?: string; home?: string; builtinDir?: string } = {}
): Promise<{ skills: SkillInfo[]; roots: SkillRootInfo[] }> {
  const home = opts.home ?? homedir()
  await fs.mkdir(userSkillsDir(home), { recursive: true }).catch(() => undefined)
  const settings = domain.getSkillSettings()
  const { skills, rootInfos } = await scanSkillRoots(
    standardSkillRoots({
      workspacePath: opts.workspacePath,
      home,
      builtinDir: opts.builtinDir,
      extraDirs: settings.extraDirs
    })
  )
  return { skills, roots: rootInfos }
}

export async function listSkills(
  domain: SkillSettingsProvider,
  opts: { workspacePath?: string; home?: string; builtinDir?: string } = {}
): Promise<SkillListResult> {
  const { skills, roots } = await discoverSkills(domain, opts)
  return { skills, roots, settings: domain.getSkillSettings() }
}

/** 过滤掉被停用的技能 */
export function filterEnabled(skills: SkillInfo[], settings: SkillSettings): SkillInfo[] {
  if (settings.disabled.length === 0) return skills
  const disabled = new Set(settings.disabled)
  return skills.filter((s) => !disabled.has(s.id))
}

/** 供 Agent 使用：当前工作区下（含内置）、未被停用的技能 */
export async function skillsForAgent(
  domain: SkillSettingsProvider,
  opts: { workspacePath: string; home?: string; builtinDir?: string }
): Promise<SkillInfo[]> {
  const { skills } = await discoverSkills(domain, opts)
  return filterEnabled(skills, domain.getSkillSettings())
}
