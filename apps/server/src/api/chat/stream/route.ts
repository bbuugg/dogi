/**
 * 重新订阅一条进行中的对话（SSE）：GET /api/chat/stream?requestId=
 *
 * 刷新 / 重载 / 断线后恢复现场：服务端先从帧日志**头部回放**（完整现场），再转直播。
 * 同一条 run 可以被多个客户端同时 attach（审批答复共享，任一端答完另一端撤卡）。
 *
 * ⚠️ 必须是**独立路由文件**：客户端请求的路径是 `/api/chat/stream`，写在
 * `app/api/chat/route.ts` 里只对应 `/api/chat`，路径对不上会一路穿透到
 * `app/[...rest]` 兜底页返回 HTML —— 前端拿到 200 + HTML，一帧没有、一错不报，
 * 界面永远停在「正在思考」（实测踩过）。
 */
import { getRun } from '@/lib/server/chat-run'
import { jsonError } from '@/app/api/_lib/auth'
import { pipeRun } from '@/app/api/_lib/chat-stream'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const requestId = url.searchParams.get('requestId')
  if (!requestId) return jsonError(400, '缺少 requestId')
  const run = getRun(requestId)
  if (!run) return jsonError(404, '这条对话请求不存在或已过期')
  return pipeRun(run)
}
