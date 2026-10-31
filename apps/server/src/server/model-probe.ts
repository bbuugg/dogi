/**
 * 「从上游拉模型清单」的服务端实现。
 *
 * 两个调用方：设置页的探针路由（`api/models/probe/route.ts`）与全局助手的
 * `fetch_upstream_models` 工具（`packages/tools/src/model-tools.ts`）。
 * **只留这一份**：两处各写一遍，「编辑态空 key = 复用已存密钥」这条判据迟早会漂，
 * 而它一旦写错就是「设置页能拉、助手拉不了」这种查半天的怪现象。
 *
 * apiKey 只在服务端解密，**绝不回传**：上游拿到的明文、返回给调用方的只有模型 id 清单。
 */
import { probeUpstreamModels } from '@fizz/agent'
import type { UpstreamModelsInput } from '@fizz/contracts/agent-api'
import { store } from './state'

/**
 * 拉上游模型清单。
 *
 * - 带 `id`：用那份已存配置的 key（输入里的 apiKey 优先，空则解密已存的）；
 *   配置不存在直接抛错 —— 静默用「空 key 去探」只会得到一个莫名其妙的 401。
 * - 不带 `id`：用入参里的 kind / baseURL / apiKey 裸探，不落盘。
 */
export async function probeModelsFromUpstream(input: UpstreamModelsInput): Promise<string[]> {
  const saved = input.id ? store.snapshot().models.find((model) => model.id === input.id) : undefined
  if (input.id && !saved) throw new Error('模型配置不存在或已被删除')
  // 编辑时空 key 与保存语义一致：复用原密钥，仅在服务端解密，不回传客户端。
  const apiKey = input.apiKey?.trim() || (saved ? store.decryptSecret(saved.apiKey) : '')
  return probeUpstreamModels({ ...input, apiKey })
}
