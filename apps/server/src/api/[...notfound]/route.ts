/**
 * /api 的兜底路由：吃掉所有**没匹配上任何 route 文件**的 `/api/*` 请求，回 404 JSON。
 *
 * 没有它，写错 / 已删的 API 路径会一路穿透到 `app/[...rest]` 页面 —— 调用方拿到
 * 200 的 HTML 壳：一帧没有、一错不报，界面静默卡死（`GET /api/chat/stream` 实测
 * 踩过：刷新接回现场永久停在「正在思考」就是它）。具体的 API 路由优先于这个
 * catch-all，只有真空路径才会落到这里。
 */
import { jsonError } from '@/app/api/_lib/auth'

export function GET() {
  return jsonError(404, 'API 路由不存在')
}

export function POST() {
  return jsonError(404, 'API 路由不存在')
}

export function PATCH() {
  return jsonError(404, 'API 路由不存在')
}

export function PUT() {
  return jsonError(404, 'API 路由不存在')
}

export function DELETE() {
  return jsonError(404, 'API 路由不存在')
}
