/**
 * 客户端工具 broker：把「服务端推来的工具调用」落到本机执行，并把结果回填。
 *
 * ## 一次调用的完整链路
 *
 * 1. **发送前**：`clientToolsFor(tabKey)` 从终端 MCP server 取工具声明，随请求上送
 *    （服务端把它们当普通 MCP 工具挂进这一轮）；
 * 2. 模型决定调用 → 服务端推一帧 `client-tool-call`（带 callId / 工具名 / 入参）；
 * 3. 这里 `handleClientToolCall` 就地执行（驱动本机终端），POST 回结果；
 * 4. 服务端解开 await，同一个回合继续跑。
 *
 * ## 权限
 *
 * 客户端**只负责声明与执行**：工具声明里的 `mutating` 标出哪些会改动终端状态
 * （见 `terminal-mcp.ts` 的 `MUTATING_TOOLS`），审批闸在服务端按这一轮的权限档套
 * （`readonly` 拒 / `confirm` 弹审批卡 / `full` 放行，见 server 的 `client-tool-gate.ts`）。
 *
 * 为什么闸不在这一层：工具是**模型直接调用**的，这边只有 `callTerminalTool` 一个执行入口，
 * 一旦哪条路径漏了判断就是裸跑；而服务端那边审批通道（confirm-gate → 助手面板的
 * `ConfirmCard`）本来就已经接通，套在同一处不需要任何新 UI。
 */
import type { ChatStreamFrame, ClientToolSpec } from '@fizz/contracts/agent-api'
import type { AgentApi } from '@fizz/agent-client/api'
import { callTerminalTool, listTerminalToolSpecs, setBoundTerminal } from '@fizz/agent-kit/shared/lib/terminal/terminal-mcp'

/**
 * 为本轮请求准备客户端工具。
 *
 * `tabKey` = 这一轮绑定的终端标签。**只有传了 tabKey 才带工具** —— 全局面板没有绑定
 * 任何终端，就不该拿到终端工具（否则模型会对一条跟这个面板无关的终端下手）。
 *
 * 失败一律**静默降级成「没有客户端工具」**：终端 MCP 起不来不该让整个对话发不出去。
 */
export async function clientToolsFor(tabKey: string | null | undefined): Promise<ClientToolSpec[] | undefined> {
  if (!tabKey) {
    // 没有绑定 → 顺手把上次的绑定清掉（免得残留的目标被别的路径读到）
    setBoundTerminal(null)
    return undefined
  }
  try {
    const specs = await listTerminalToolSpecs(tabKey)
    return specs.length ? specs : undefined
  } catch (err) {
    console.warn('[client-tools] 终端工具清单获取失败，本轮不带客户端工具：', err)
    return undefined
  }
}

/**
 * 处理一帧 `client-tool-call`：本地执行 + 回填。
 *
 * ⚠️ **任何异常都要回填**（`ok:false` + 原因），否则服务端那条 await 只能等超时 ——
 * 整轮会被吊住 60s。回填本身失败也只记日志（服务端侧有超时兜底）。
 */
export async function handleClientToolCall(
  frame: ChatStreamFrame,
  api: AgentApi
): Promise<void> {
  const callId = frame.clientToolCallId
  const name = frame.clientToolName
  if (!callId || !name) return
  try {
    const result = await callTerminalTool(name, (frame.clientToolInput ?? {}) as Record<string, unknown>)
    await api.resolveClientTool({ callId, ok: true, result })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    try {
      await api.resolveClientTool({ callId, ok: false, error })
    } catch (postErr) {
      console.warn('[client-tools] 回填失败（服务端会按超时收场）：', postErr)
    }
  }
}
