/**
 * 服务端视角的技能发现：「内置技能根 + home」的统一组装口。
 *
 * 与 `plugin-roots.ts` 同一个理由 —— 技能的根目录有一堆（内置 / 项目 / 用户级 / agents /
 * 自定义），少传一个参数的症状是**静默少一批技能**（没有报错、只是列表里没有），
 * 所以组装规则只留一份，四个调用点（技能路由、health、state-ws 快照、每轮对话）都用它。
 *
 * 内置技能根（随产品分发，`<仓库根>/skills`）**在哪儿**由 `builtin-dirs.ts` 探测
 * （三种运行形态 + 标记文件判据，见那份文件头）。
 */
import { homedir } from 'node:os'
import { listSkills, skillsForAgent } from '@fizz/skills'
import type { SkillInfo, SkillListResult } from '@fizz/skills'
import { resolveBuiltinSkillsDir } from './builtin-dirs'
import { domain } from './state'

/** 扫一遍技能（内置 + 项目 + 用户级 + 各兼容目录），带全局启停设置 —— 设置页 / 快照用 */
export async function listServerSkills(workspacePath?: string): Promise<SkillListResult> {
  return listSkills(domain, {
    workspacePath,
    home: homedir(),
    builtinDir: resolveBuiltinSkillsDir()
  })
}

/** 供 Agent 使用：某个项目下（含内置）、未被停用的技能 */
export async function serverSkillsForAgent(workspacePath: string): Promise<SkillInfo[]> {
  return skillsForAgent(domain, {
    workspacePath,
    home: homedir(),
    builtinDir: resolveBuiltinSkillsDir()
  })
}
