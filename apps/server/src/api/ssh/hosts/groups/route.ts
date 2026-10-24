/**
 * 主机分组：列表 / 新建 / 更新（重命名 / 改父分组）。
 * GET  /api/ssh/hosts/groups  → `HostGroup[]`
 * POST /api/ssh/hosts/groups  body `HostGroupInput`（带 id 更新 / 不带新建）→ 分组树
 *
 * 分组是 SSH 主机与本机终端**共用**的（多级树）—— 两者同列在侧栏，分两套只会让
 * 本机终端进不了任何分组。
 *
 * ⚠️ 路径与 `/api/ssh/hosts/:id` 同级：静态段优先于动态段（`app/next-route.ts`），
 * `groups` 不会被当成某台主机的 id。
 */
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json(domain.listHostGroups())
}

export async function POST(request: Request) {
  const body = await parseJsonBody<Parameters<typeof domain.saveHostGroup>[0]>(request)
  if (!body) return jsonError(400, '请求体不是合法 JSON')
  try {
    domain.saveHostGroup(body)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
  return Response.json(domain.listHostGroups())
}
