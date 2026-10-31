import type { UpstreamModelsInput } from '@fizz/contracts/agent-api'
import { probeModelsFromUpstream } from '@/lib/server/model-probe'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const input = await parseJsonBody<UpstreamModelsInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')
  if (!input?.kind) return jsonError(400, '缺少 kind 字段（要按服务商走不同的 /models 协议）')
  try {
    // 实现与全局助手的 fetch_upstream_models 工具同源（见 server/model-probe.ts）
    return Response.json({ models: await probeModelsFromUpstream(input) })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
