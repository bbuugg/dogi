/**
 * 浏览器**全局默认**偏好（新会话的默认开关 + 来源）+ 本机探测到的可用来源：
 * GET /api/browser/settings。
 *
 * - **全局默认**：每个会话的实际偏好存在会话自己身上
 *   （`AgentConversation.browserSettings`，经 `PATCH /api/conversations/:id/target` 落库），
 *   新建会话时以它作初值。
 * - **来源探测**：回答「这台机器上装了哪些浏览器」，供工具条的来源菜单把没装的标出来。
 *
 * 全局那份同时是**新会话的来源默认值**：会话没单独设过时按它走。
 *
 * ⚠️ 与 `/api/browser`（screencast 的 **WS** 端点）不是一个东西：升级请求在走到 HTTP
 * 路由之前就被 `ws.ts` 拦下了，这里只是普通 JSON 接口。
 */
import { domain } from '@/lib/server/state'
import { detectBrowsers } from '@fizz/tools'
import type { BrowserSettingsResult } from '@fizz/contracts/agent-api'

export async function GET(): Promise<Response> {
  return Response.json({
    browser: domain.getBrowserSettings(),
    // 探测是本机（server 所在机器）视角：web 端回答的是服务器上装没装，
    // 桌面端走同一份路由、回答的是本机 —— 与浏览器实际跑在哪一致。
    detected: detectBrowsers()
  } satisfies BrowserSettingsResult)
}
