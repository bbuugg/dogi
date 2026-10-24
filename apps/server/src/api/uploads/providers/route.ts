/**
 * 可用的上传源清单：GET /api/uploads/providers?workspaceId=xxx
 *
 * 前端用它做两件事：
 * - **放宽本地预校验**：`splitUploadable` 目前按契约白名单（图片 + PDF）拦文件，插件
 *   上传源可以声明自己的 accept，所以要按这里给出的并集判；
 * - **渲染选择器**：超过一个可选项时，附件按钮上多一个「传到哪儿」的下拉。
 *
 * 路径刻意是 `/api/uploads/providers` 而不是 `/api/upload-providers`：
 * `next-route.ts` 的排序（静态段多的在前）+ Hono 本身的路由优先级都会让静态段赢过
 * `/api/uploads/:name`，所以不会被那个动态路由吞掉。
 *
 * 不传 `workspaceId` = 只有全局（用户级）插件 + 内置存储，这是合法用法（上传本来就可能
 * 发生在还没选项目的场景）。
 */
import { getUploadProviders } from '@/lib/server/upload/index'
import { domain } from '@/lib/server/state'

export async function GET(request: Request): Promise<Response> {
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? undefined
  const workspacePath = workspaceId ? domain.getWorkspace(workspaceId)?.path : undefined
  try {
    const providers = await getUploadProviders({ workspaceId, workspacePath })
    return Response.json({ providers })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[upload] 读取上传源清单失败：', err)
    return Response.json({ error: message }, { status: 500 })
  }
}
