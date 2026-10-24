/**
 * POST /api/container-images/:env/build → 当前快照
 *
 * `:env` = 运行环境 id（node / php / golang）或 `base`（基础层）。
 *
 * **不 await 构建**：`docker build` 可能几分钟，同步等会把 HTTP 挂在那儿、前端也拿不到
 * 进度。这里只负责「点着火」并立即返回快照（`building: true`），前端轮询
 * `GET /api/container-images` 看日志与结果。
 *
 * ⚠️ 构建失败**不在这里报**（已经返回 200 了）：错因落在快照对应项的 `error` 里。
 * 这里只对「路径参数不认识」这类前置错误给 400。
 */
import { buildContainerImage, containerImageKeyOf, containerImagesSnapshot } from '@/lib/server/container-projects/image'
import { jsonError } from '@/app/api/_lib/auth'

export async function POST(_request: Request, { params }: { params: Promise<{ env: string }> }) {
  const { env } = await params
  const key = containerImageKeyOf(env)
  if (!key) return jsonError(400, `未知的镜像：${env}（应为 base / node / php / golang）`)

  // 不 await：长任务；reject 由快照里的 error 承载，这里吞掉避免 unhandled rejection
  void buildContainerImage(key).catch(() => undefined)
  return Response.json(await containerImagesSnapshot())
}
