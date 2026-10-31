/**
 * 自带浏览器的安装状态 / 卸载：GET、DELETE /api/browser/runtime。
 *
 * - `GET` → `BrowserRuntimeResult`（安装状态 + 最近一次安装任务），设置页轮询它；
 * - `DELETE` → 卸载：先关掉所有浏览器会话再删目录，回卸载后的快照。
 *
 * `runtime.installed` 是「装没装」的唯一判据：输入框上方那颗开关显不显示、
 * `web_fetch` / `screenshot` 要不要直接回绝，都读它。
 *
 * ⚠️ 与 `/api/browser`（screencast 的 **WS** 端点，升级请求在 `ws.ts` 就被拦下）
 * 不是同一个东西：那个是画面通道。「用不用浏览器」是会话级偏好，也不在这里。
 */
import { jsonError } from '@/app/api/_lib/auth'
import {
  browserRuntimeSnapshot,
  uninstallBrowserRuntime
} from '@/lib/server/browser-runtime'

export async function GET(): Promise<Response> {
  return Response.json(browserRuntimeSnapshot())
}

export async function DELETE(): Promise<Response> {
  try {
    return Response.json(await uninstallBrowserRuntime())
  } catch (err) {
    // 只有「正在安装中」是 409，其余都按 500 处理（`jsonError` 只收固定的几个码）
    const conflict = (err as { status?: number }).status === 409
    return jsonError(conflict ? 409 : 500, err instanceof Error ? err.message : String(err))
  }
}
