/**
 * AI 侧各类「等多久算超时」的读取与兜底定时器。
 *
 * 缺省值在 `@shared/ai-timeouts`（和设置页的档位共用一份），**用户可在
 * 「设置 → AI → 超时」里覆盖**（存 `AiSettings.confirmTimeoutMs` /
 * `modelTimeoutMs`，`0` = 不限时）。本文件只负责「取生效值」与「装定时器」，
 * 三处调用（工作区 Agent / 终端 AI 助手 / ACP 权限弹卡）都走这里，不各自读配置。
 */
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  DEFAULT_MODEL_TIMEOUT_MS
} from '@shared/ai-timeouts'

// ---------- 确认审批 ----------

/**
 * 生效的审批等待超时：用户设置优先，缺省用 `DEFAULT_CONFIRM_TIMEOUT_MS`。
 *
 * **缺省不限时**的理由：超时这件事**是静默的** —— 卡片自己消失（渲染端收到的是
 * 「已有结论」），而工具那边拿到的是 `approved = false`，于是模型跑去问用户
 * 「接下来怎么办」，用户则一头雾水：我什么都没点，命令怎么就「被拒绝」了。
 * 审批卡本来就是「停下来等你」，用户可能正在读 diff、翻文档、去接杯咖啡 ——
 * 「没人管的会话挂着一轮」比「回来发现操作被默默取消」好接受得多。
 *
 * 挂起不会漏：中止（停止按钮 / 切会话）与整轮结束都会走各服务的
 * `clearPendingConfirms` 释放它，所以**随时有退路**，只是不会自己超时。
 */
export function resolveConfirmTimeoutMs(overrideMs?: number): number {
  return overrideMs ?? DEFAULT_CONFIRM_TIMEOUT_MS
}

/**
 * 给「等待用户确认」的 Promise 装兜底定时器。
 *
 * 不限时（`<= 0`）时返回 `undefined`，调用方原样存进 pending 记录即可 ——
 * `clearTimeout(undefined)` 是安全的空操作，不必到处判空。
 */
export function armConfirmTimeout(
  settle: () => void,
  overrideMs?: number
): ReturnType<typeof setTimeout> | undefined {
  const ms = resolveConfirmTimeoutMs(overrideMs)
  return ms > 0 ? setTimeout(settle, ms) : undefined
}

// ---------- 模型请求 ----------

/**
 * 生效的模型请求超时：用户设置优先，缺省 `DEFAULT_MODEL_TIMEOUT_MS`（5 分钟）。
 *
 * 为什么要设：`streamText` 与 mastra 的默认都是**完全不限时**（`timeout` 为
 * `undefined` 时那些取值函数直接返回 `undefined`）—— 一个黑洞网关能让这一轮永远
 * 转圈，只能用户手动点中止。这里只兜住「连接 / 流」两个阶段：首个内容块、以及
 * 相邻两块之间的间隔。缺省 5 分钟与 Node fetch 自身的响应头超时（undici
 * `headersTimeout`，默认 300s）持平 —— 不比它更早掐断，但报错是我们自己的、能看懂。
 *
 * **刻意不设** `totalMs` / `stepMs` / `toolMs`：那些是「这次任务该多久做完」的预算，
 * 而一次 Agent 回合最多 25 步、每步都可能停下来等用户点确认，用总量 / 单步预算去卡它，
 * 等于把「用户正在看 diff」判成超时。判活交给上面两项就够了。
 */
export function resolveModelTimeoutMs(overrideMs?: number): number {
  return overrideMs ?? DEFAULT_MODEL_TIMEOUT_MS
}

/** AI SDK `streamText` 的 `timeout` 选项；不限时时返回 `undefined`（不设 = 原行为） */
export function modelStreamTimeout(
  overrideMs?: number
): { firstChunkMs: number; chunkMs: number } | undefined {
  const ms = resolveModelTimeoutMs(overrideMs)
  return ms > 0 ? { firstChunkMs: ms, chunkMs: ms } : undefined
}

/**
 * 同上，但只留 mastra 认的字段：`modelSettings.timeout` 是 `ModelTimeoutSettings`，
 * 只有 `totalMs` / `stepMs` / `firstChunkMs`（它的 `stepMs` 覆盖「开流后卡住」那种情况，
 * 但那会把正常的长回答一起算进去，所以不设）。
 */
export function modelRunTimeout(overrideMs?: number): { firstChunkMs: number } | undefined {
  const ms = resolveModelTimeoutMs(overrideMs)
  return ms > 0 ? { firstChunkMs: ms } : undefined
}
