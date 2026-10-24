/**
 * 技能路由：扫描技能目录 + 用户启停设置。技能内容在磁盘（SKILL.md），只读 + 配置。
 *
 * 扫描走 `listServerSkills`（`lib/server/skill-roots.ts`）：它负责把**内置技能根**
 * （随产品分发）与 home 一起填上 —— 这里只管 HTTP 壳。
 */
import { listServerSkills } from '@/lib/server/skill-roots'
import { domain } from '@/lib/server/state'
import { parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  const workspace = domain.listWorkspaces()[0]
  return Response.json(await listServerSkills(workspace?.path))
}

export async function POST(request: Request) {
  const body = await parseJsonBody<{ disabled?: string[]; extraDirs?: string[] }>(request)
  domain.saveSkillSettings({
    disabled: Array.isArray(body?.disabled) ? body.disabled : [],
    extraDirs: Array.isArray(body?.extraDirs) ? body.extraDirs : []
  })
  const workspace = domain.listWorkspaces()[0]
  return Response.json(await listServerSkills(workspace?.path))
}
