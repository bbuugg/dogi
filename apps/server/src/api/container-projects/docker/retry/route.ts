/**
 * POST /api/container-projects/docker/retry → { reason?: string }
 *
 * 「连不上 docker 引擎」那张卡片上「重试」按钮的后端：清掉探测缓存后**现问一次** daemon，
 * 再推一次容器项目快照。
 *
 * 为什么值得单独一条接口：docker 探测有两层缓存（`dockerVersion()` 的 30s 成功缓存 +
 * `dockerReason()` 的 60s 失败缓存），只让前端「重新拉一次快照」的话，用户把 Docker
 * Desktop 起来之后点了重试也还是坏的，看起来就是按钮没反应。
 *
 * 200 是**结论**而不是「探测成功」：`reason` 为空 = 现在可用了；非空 = 仍然连不上，
 * 前端直接拿它更新提示文案。
 */
import { retryDockerProbe } from '@/lib/server/container-projects/lifecycle'
import { describeError, jsonError } from '@/app/api/_lib/auth'

export async function POST() {
  try {
    return Response.json({ reason: await retryDockerProbe() })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
