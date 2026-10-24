/**
 * 子任务（subagent）路由：用户启停设置 + 子任务模型。**默认全关**（见 contracts 的
 * SubagentSettings）。
 *
 * 与 skills 路由的关系：技能内容是磁盘上的 SKILL.md，这里只是「用户选了哪几个」——
 * subagent 的**定义**（工具白名单 / 模型 / 步数）在 `packages/agent/src/subagents.ts`，
 * 磁盘上只存 enabled 清单与可选的模型偏好。
 *
 * 启用了并不意味着一定派活：父模型得自己判断「这活该派出去」。所以这里只做幂等读写，
 * 不做「本轮是否派过」的状态机。
 */
import { domain } from '@/lib/server/state'
import { parseJsonBody } from '@/app/api/_lib/auth'
import { normalizeSubagentSettings, type SubagentId } from '@fizz/contracts/types'

export async function GET() {
  return Response.json({ subagents: domain.getSubagentSettings() })
}

export async function POST(request: Request) {
  const body = await parseJsonBody<{
    enabled?: SubagentId[]
    modelConfigId?: string | null
    modelId?: string | null
  }>(request)
  // 归一化在这里也过一次：HTTP 请求体是不可信输入，非法 id / 空串直接收敛。
  // ⚠️ 缺字段 = 保留 —— 启停开关只传 enabled，不能顺手把已选的模型清掉。
  const normalized = normalizeSubagentSettings(body ?? {})
  const patch = {
    ...(body?.enabled !== undefined ? { enabled: normalized.enabled } : {}),
    ...('modelConfigId' in (body ?? {}) ? { modelConfigId: normalized.modelConfigId ?? null } : {}),
    ...('modelId' in (body ?? {}) ? { modelId: normalized.modelId ?? null } : {})
  }
  const subagents = domain.saveSubagentSettings(patch)
  return Response.json({ subagents })
}
