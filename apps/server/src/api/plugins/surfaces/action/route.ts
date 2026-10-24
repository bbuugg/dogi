/**
 * 插件界面里的一个动作：POST /api/plugins/surfaces/action
 *
 * 插件的块里可以有可点的项（列表项 / 按钮），点了就走到这里：{ pluginId, kind, id,
 * actionId, args } → 调插件声明的 `onAction` → 返回新内容（或一句话）。
 *
 * `args` 是**不可信输入**：只留 string / number / boolean，且键名与长度都封顶 ——
 * 插件的 `onAction` 自己还要再判一次，这里只保证它拿到的是「干净的形状」而不是任意 JSON。
 *
 * 动作的副作用由插件自己决定（刷新 / 关闭连接 / 删一条记录…），本路由不管语义，
 * 只负责「找到那个面 → 调它的回调 → 把结果收敛成块」。
 */
import type { PluginSurfaceActionResult } from '@fizz/contracts/agent-api'
import type { UiSurfaceKind } from '@fizz/plugin'
import { cleanSurfaceParams, runPluginSurfaceAction } from '@/lib/server/plugin-ui'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

const KINDS: UiSurfaceKind[] = ['activityBar', 'sider', 'view']

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<{
    pluginId?: string
    kind?: string
    id?: string
    actionId?: string
    args?: unknown
    /** 这一面是哪个参数开的（如「哪个连接」）—— 动作要按它区分实例 */
    params?: unknown
    workspaceId?: string
  }>(request)

  const pluginId = typeof body?.pluginId === 'string' && body.pluginId ? body.pluginId : ''
  if (!pluginId) return jsonError(400, '缺少 pluginId')
  if (!body?.kind || !(KINDS as string[]).includes(body.kind)) {
    return jsonError(400, `kind 必须是 ${KINDS.join(' / ')} 之一`)
  }
  const id = typeof body?.id === 'string' && body.id ? body.id : ''
  if (!id) return jsonError(400, '缺少面 id')
  const actionId = typeof body?.actionId === 'string' && body.actionId ? body.actionId : ''
  if (!actionId) return jsonError(400, '缺少 actionId')

  const workspaceId = typeof body?.workspaceId === 'string' && body.workspaceId ? body.workspaceId : undefined
  const args = cleanSurfaceParams(body?.args)
  const params = cleanSurfaceParams(body?.params)
  const result: PluginSurfaceActionResult = await runPluginSurfaceAction({
    pluginId,
    kind: body.kind as UiSurfaceKind,
    id,
    actionId,
    ...(args ? { args } : {}),
    ...(params ? { params } : {}),
    ...(workspaceId ? { workspaceId } : {})
  })
  return Response.json(result)
}
