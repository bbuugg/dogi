/**
 * GET /api/container-images → `ContainerImagesSnapshot`
 *
 * 设置页「容器」的数据源：docker 可用性 + 基础层 / 各环境镜像的存在性、大小、
 * 构建时间、构建中 / 上次失败的错因与日志尾部。
 *
 * 不抛错：docker 不可达时 `available: false` + 人话原因（与容器项目列表同一约定）。
 * 前端在 `building: true` 期间轮询这个接口拿进度。
 */
import { containerImagesSnapshot } from '@/lib/server/container-projects/image'

export async function GET() {
  return Response.json(await containerImagesSnapshot())
}
