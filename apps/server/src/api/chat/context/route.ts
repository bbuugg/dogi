/**
 * 上下文窗口查询：GET /api/chat/context
 *
 * 只回答一件事：**兜底窗口**是多少（环境变量 `FIZZ_CONTEXT_BUDGET` > 默认 200k）。
 *
 * 为什么不是「本次要用的窗口」：窗口是**每个模型自己**的属性，配在 `AiModelEntry.contextWindow`
 * 里，前端从已经拿到的 `ModelView.models` 里直接查条目即可（contracts 的 `resolveContextWindow` 是前后端
 * 共用的纯函数，不需要为它再发一次请求）。这个端点只补最后一块拼图 —— 模型没配窗口时的兜底值，
 * 它只存在于服务端（环境变量），前端拿不到。
 *
 * 纯读、无副作用，数值几乎不变，前端拉一次缓存即可。
 */
import { defaultContextWindowFromEnv } from '@fizz/agent'

export async function GET() {
  return Response.json({ defaultContextWindow: defaultContextWindowFromEnv() })
}
