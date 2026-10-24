import { probeUpstreamModels } from '@fizz/agent'
import type { UpstreamModelsInput } from '@fizz/contracts/agent-api'
import { store } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function POST(request: Request) {
  const input = await parseJsonBody<UpstreamModelsInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')
  if (!input?.kind) return jsonError(400, '缺少 kind 字段（要按服务商走不同的 /models 协议）')
  try {
    const saved = input.id ? store.snapshot().models.find((model) => model.id === input.id) : undefined
    if (input.id && !saved) return jsonError(404, '模型配置不存在或已被删除')
    // 编辑时空 key 与保存语义一致：复用原密钥，仅在服务端解密，不回传客户端。
    const apiKey = input.apiKey?.trim() || (saved ? store.decryptSecret(saved.apiKey) : '')
    return Response.json({ models: await probeUpstreamModels({ ...input, apiKey }) })
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
