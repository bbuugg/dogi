/**
 * 从 Git 导入项目:服务端克隆远端仓库并登记成工作区。
 * POST /api/workspaces/clone(body: `WorkspaceCloneInput`) → `WorkspaceCloneResult`
 *
 * ## 这趟克隆同时是一条后台任务
 *
 * 校验通过后先登记成后台任务(`startBackgroundTask`,id = 渲染端的 `cloneId`),
 * 然后本路由只是**众多等待方之一**:
 * - 默认等它出结果,按老样子回新工作区 / 错误;
 * - `background: true` 或收到 `POST /api/background-tasks/:id/detach` 时,立刻回
 *   `{ detached: true, taskId }` —— 人不等了,git 继续跑,进度留在状态栏那张任务列表里;
 * - 被取消时回 **200 + `{ canceled: true }`**:取消是正常结局,不该让前端弹红条。
 *
 * ⚠️ 校验(`prepareGitClone`)**在登记之前**跑:路径不是绝对路径、目标目录已存在这类
 * 表单错误当场回 4xx,别往任务列表里塞一条「失败的克隆」。
 *
 * ⚠️ 客户端断开连接**不再**杀克隆(上一版会):关标签页不该等于放弃一个跑了十分钟的克隆,
 * 它现在的身份就是后台任务,回来还能在状态栏里看见。要停就显式取消。
 */
import type { WorkspaceCloneInput, WorkspaceCloneResult } from '@fizz/contracts/agent-api'
import type { AgentWorkspace } from '@fizz/contracts/agent-api'
import { maskRepoUrl } from '@fizz/git'
import { createProject, prepareGitClone, projectError } from '@/lib/server/projects'
import { startBackgroundTask } from '@/lib/server/background-tasks'
import { jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const body = await parseJsonBody<WorkspaceCloneInput>(request)
  if (!body?.url?.trim() || !body.parentDir?.trim()) {
    return jsonError(400, '缺少 url 或 parentDir')
  }

  // 表单错误当场回:这些不该变成任务列表里的失败记录
  let prep
  try {
    prep = prepareGitClone({
      gitUrl: body.url,
      parentPath: body.parentDir,
      ...(body.name ? { name: body.name } : {})
    })
  } catch (err) {
    const e = projectError(err)
    return jsonError(e.status, e.message)
  }

  const task = startBackgroundTask({
    ...(body.cloneId?.trim() ? { id: body.cloneId.trim() } : {}),
    kind: 'git-clone',
    title: `克隆 ${prep.dirName}`,
    detail: prep.destDir,
    run: async (signal, log) => {
      /*
       * 日志就是这个任务的「黑匣子」：状态栏里展开能看到时间线。
       * 地址先过 `maskRepoUrl` —— https 地址里可能带着 token，日志是会进界面的。
       */
      log(`开始克隆 ${maskRepoUrl(prep.url)}`)
      log(`目标目录 ${prep.destDir}`)
      const workspace = await createProject({
        mode: 'git',
        gitUrl: prep.url,
        parentPath: prep.parentDir,
        signal,
        // git 的进度 / 报错原文（`Receiving objects: 45%`、`fatal: …`）原样进日志
        onLog: log,
        ...(prep.name ? { name: prep.name } : {})
      })
      log(`已登记项目 ${workspace.name || workspace.path}`)
      return { value: workspace, summary: { workspaceId: workspace.id, path: workspace.path } }
    }
  })

  // 「一开始就只登记后台」与「等待中被 detach」走同一个出口
  if (body.background) {
    task.detach()
    const result: WorkspaceCloneResult = { detached: true, taskId: task.id }
    return Response.json(result, { status: 202 })
  }

  const outcome = await task.wait()
  if (outcome.detached) {
    const result: WorkspaceCloneResult = { detached: true, taskId: task.id }
    return Response.json(result, { status: 202 })
  }
  if (outcome.status === 'canceled') {
    const result: WorkspaceCloneResult = { canceled: true }
    return Response.json(result)
  }
  if (outcome.status === 'failed') {
    const e = projectError(outcome.errorObject)
    return jsonError(e.status, e.message)
  }
  return Response.json(outcome.value as AgentWorkspace)
}
