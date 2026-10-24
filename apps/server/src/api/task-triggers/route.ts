/**
 * 定时任务 CRUD。
 * GET  /api/task-triggers?workspaceId=
 * POST /api/task-triggers
 *
 * ⚠️ 记录怎么算、怎么落库、落库后怎么让调度器对齐，都在 `@/lib/server/task-triggers` 里
 * （**唯一真源**，项目管理助手的 `create_task_trigger` 工具走同一份）；这里只做 HTTP 侧的
 * 逐字段校验，好给界面回精确到字段的 400。
 */
import type { TaskTriggerInput } from '@fizz/contracts/types'
import { domain, triggerDomain } from '@/lib/server/state'
import { buildTriggerRecord, isValidCron, saveTriggerAndSync } from '@/lib/server/task-triggers'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'
import { fail } from '@/app/api/_lib/http'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get('workspaceId') || undefined
  return Response.json(triggerDomain.listTriggers(workspaceId))
}

export async function POST(request: Request) {
  const body = await parseJsonBody<TaskTriggerInput>(request)
  if (!body) return jsonError(400, '缺少请求体')
  // 工作区可选:不选 = 每次触发自动建临时工作区(与「新建会话不选工作区」同一套语义)。
  // 给了就必须是登记过的 —— 否则触发时才炸,用户还看不出是哪一步错了。
  if (body.workspaceId && !domain.getWorkspace(body.workspaceId)) {
    return jsonError(400, '工作区不存在，请重新选择')
  }
  if (!body.name?.trim()) return jsonError(400, '请填写名称')
  // 目标必须明确选过：触发时没人值守，缺了只会在调度器里报错（不存在「第一份可用配置」兜底）。
  // 两种后端的必填项不同：
  // - 内置模型（mastra / 缺省）：配置 + 模型都要有；
  // - 外部 Agent（acp）：只要 agent（configId），模型可省 = 跟随 agent 自己的默认
  const template = body.template
  if (!template?.configId) {
    return jsonError(400, '请选择模型或外部 Agent：定时任务触发时没人值守，不会替你挑一份配置')
  }
  if (template.backend === 'acp') {
    try {
      domain.resolveAcpAgent(template.configId)
    } catch {
      return jsonError(400, '所选外部 Agent 不存在或已被删除，请重新选择')
    }
  } else if (!template.modelId) {
    return jsonError(400, '请选择模型：定时任务触发时没人值守，不会替你挑一份配置')
  }
  if (!body.cron && body.at === undefined) {
    return jsonError(400, '请选择触发方式：填 cron 表达式或定时时刻')
  }
  if (body.cron && !isValidCron(body.cron)) {
    return jsonError(400, 'cron 表达式不合法（5 段：分 时 日 月 周，如 0 9 * * *）')
  }
  if (body.at !== undefined && (!Number.isFinite(body.at) || body.at <= 0)) {
    return jsonError(400, '触发时刻不合法')
  }

  try {
    const existing = body.id ? triggerDomain.getTrigger(body.id) : undefined
    // 定时器投影对齐（同步、内部吞错）
    return Response.json(saveTriggerAndSync(buildTriggerRecord(body, existing)))
  } catch (err) {
    return fail(err)
  }
}
