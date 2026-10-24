/**
 * 应用日志：全量拉取。
 *
 * GET /api/app-log → AppLogResult
 *
 * 全量而非分页：日志是内存环形缓冲（上限 `APP_LOG_MAX_ENTRIES`），量有硬上限，
 * 一次给完最简单 —— 面板还要靠 `maxSeq` 作为 SSE 订阅起点。
 */
import { appLogSnapshot } from '@/lib/server/app-log/service'

export async function GET() {
  return Response.json(appLogSnapshot())
}
