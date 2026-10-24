import { probeUpstreamModels } from '@fizz/agent'
import type { ModelInput, UpstreamModelsInput } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { refreshPluginModels } from '@/lib/server/plugin-models'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  // 打开设置页时顺带刷新（指纹没变就是几次 stat）：改插件文件 / 填完设置立刻可见
  await refreshPluginModels()
  return Response.json(domain.listModels())
}

export async function POST(request: Request) {
  const input = await parseJsonBody<ModelInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')
  if (!Array.isArray(input?.models)) {
    return jsonError(400, '缺少 models 字段（模型清单，可为空数组）')
  }
  try {
    return Response.json(domain.saveModel(input))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
