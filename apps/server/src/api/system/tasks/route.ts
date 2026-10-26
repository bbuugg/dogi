/**
 * 任务管理器的进程表：GET `/api/system/tasks` → `SystemTaskList`。
 *
 * **按请求现采**（`ps` / `tasklist`），不是快照：只有开着任务管理器标签时才有请求，
 * 关掉就彻底没有采集 —— 与状态栏那条「常驻采样器 + 快照」(`GET /api/system`) 是两条
 * 独立通路（见 `lib/server/system-tasks/index.ts` 文件头的对照表）。
 *
 * 采集失败（`ps` 不存在 / 输出解析不出来）返回 500 而不是一张空表：空表会让界面显示
 * 「0 个进程」，那是在骗人。
 *
 * 鉴权由根 `app.ts` 的中间件统一兜底（`/api/*` 全走 JWT），这里不重复判。
 */
import { listSystemTasks } from '@/lib/server/system-tasks'
import { fail } from '@/app/api/_lib/http'

export async function GET() {
  try {
    return Response.json(await listSystemTasks())
  } catch (err) {
    return fail(err)
  }
}
