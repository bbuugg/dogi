/**
 * 安装自带浏览器：POST /api/browser/runtime/install → `BrowserRuntimeResult`。
 *
 * **立刻返回**（不等下载）：任务登记完就把快照回给前端，`runtime.downloading` /
 * `task.status` 立刻是「进行中」，进度与日志从任务详情里取。已经装好或已经在装时
 * 是幂等的，回当前状态 —— 用户连点两次不会起两条下载。
 *
 * 下载失败不需要在这里回错误：失败原因会落在任务日志与 `task.error` 上，设置页
 * 那一行直接显示（重试按钮就是再 POST 一次）。
 */
import { startBrowserRuntimeInstall } from '@/lib/server/browser-runtime'

export async function POST(): Promise<Response> {
  return Response.json(startBrowserRuntimeInstall(), { status: 202 })
}
