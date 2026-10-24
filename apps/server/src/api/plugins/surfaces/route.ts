/**
 * 插件界面：列出所有面 + 渲染一面。GET /api/plugins/surfaces
 *
 * 两个用途共用一个路由（**按有没有 `pluginId` 区分**）：
 *
 * - 不带 `pluginId`：`?workspaceId=` → 清单（图标栏 / 侧栏 / 标签页各有哪些）；
 * - 带 `pluginId`：`?pluginId=&kind=&id=&workspaceId=` → 渲染那一面（调插件的 `render`）。
 *
 * 为什么合一：两者的「找插件 → 挂上去」是同一段逻辑，分成两个文件各写一遍，迟早出现
 * 「清单里有这一项、点过去却说找不到」的两套判据。
 *
 * 「挂上去」是**每次请求现挂一次**（见 `server/plugin-ui.ts` 文件头的取舍），所以插件文件
 * 改完 / 设置改完，下一次请求就是新代码 —— 与热重载的口径一致。
 *
 * 不缓存：界面内容本来就该是**当下**的（Redis 状态、端口结果…），缓存只会让人看到旧数据。
 */
import type {
  PluginSurfaceContent,
  PluginSurfacesResult
} from '@fizz/contracts/agent-api'
import type { UiSurfaceKind } from '@fizz/plugin'
import {
  cleanSurfaceParams,
  listPluginSurfaces,
  renderPluginSurface
} from '@/lib/server/plugin-ui'
import { jsonError } from '@/app/api/_lib/auth'

const KINDS: UiSurfaceKind[] = ['activityBar', 'sider', 'view']

function strParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)
  return typeof value === 'string' && value ? value : undefined
}

/** `?params={"conn":"local"}` → 对象；不是 JSON / 不是对象 = 当没传（不报错，面照常渲染） */
function parseParamJson(raw: string | undefined): unknown {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const workspaceId = strParam(query, 'workspaceId')
  const pluginId = strParam(query, 'pluginId')

  // 清单：图标栏 / 侧栏 / 标签页各有哪些（前端据此往图标栏里加项、往标签条里加页）
  if (!pluginId) {
    const { surfaces, errors } = await listPluginSurfaces({ workspaceId })
    const body: PluginSurfacesResult = { surfaces }
    if (errors.length) {
      for (const err of errors) console.warn('[server] 插件界面清单：', err)
    }
    return Response.json(body)
  }

  // 渲染一面
  const kind = strParam(query, 'kind')
  const id = strParam(query, 'id')
  if (!kind || !(KINDS as string[]).includes(kind)) {
    return jsonError(400, `kind 必须是 ${KINDS.join(' / ')} 之一`)
  }
  if (!id) return jsonError(400, '缺少面 id')
  // 参数（如「哪个连接」）：同一个面可以用不同参数开出多个标签页。
  // 值是 JSON 字符串；解析失败就当没传（面照常渲染，只是拿不到参数）
  const params = cleanSurfaceParams(parseParamJson(strParam(query, 'params')))
  // 渲染失败**不回 5xx**：界面上要显示成一条提示，而不是让整块内容消失（见 plugin-ui.ts）
  const content: PluginSurfaceContent = await renderPluginSurface({
    pluginId,
    kind: kind as UiSurfaceKind,
    id,
    ...(params ? { params } : {}),
    ...(workspaceId ? { workspaceId } : {})
  })
  return Response.json(content)
}
