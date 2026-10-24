/**
 * 「待预填的输入框草稿」：一个单槽的跨组件传递(模块级,不用 Context / 事件)。
 *
 * ## 为什么不用 CustomEvent 广播
 *
 * 助手调 `create_conversation` 建好会话后,要让输入框里出现那段提示词。链路是
 * 「app-shell(收到 UI 动作)→ 打开那个会话 → ChatPanel 里的 `PromptInputProvider`」。
 * 用事件广播的话,app-shell 派发的那一刻新会话的 ChatPanel **很可能还没挂上** ——
 * 打开会话是异步的(要切视图 + 拉历史,`PanelView` 才把标签铺出来),监听器错过了这次
 * 事件,提示词就丢了,表现为「切过去了但输入框是空的」。
 * 放进一个模块级单槽就不会:先写进去,等 ChatPanel 挂上来主动来取(见下方 `takePendingDraft`)。
 *
 * 和 `assistant-panel.ts` 同一个理由 —— 带订阅的模块变量是最小做法。
 *
 * ## 为什么要带 conversationId
 *
 * 草稿是有归属的:只灌进「这次刚建的那个会话」。少了这个比对,稍后打开别的会话也会
 * 莫名冒出一段别人的提示词。取走即清(单槽),所以不会串味。
 */

/** 单槽：待预填的草稿（`conversationId` = 只往这个会话的输入框里灌） */
let pending: { conversationId: string; prompt: string } | null = null

/** 记下一个待预填草稿（同一 id 重复调用直接覆盖，不会堆叠） */
export function setPendingDraft(conversationId: string, prompt: string): void {
  if (!conversationId || !prompt) return
  pending = { conversationId, prompt }
}

/**
 * 取走「属于这个会话」的待预填草稿：命中即清空并返回。
 *
 * 调用方（ChatPanel）在会话切到目标 id 的那一轮 effect 里调 —— 先到先得，
 * 拿不到返回 `null`（正常路径，绝大多数时候都是 null）。
 */
export function takePendingDraft(conversationId: string | null): string | null {
  if (!conversationId || pending?.conversationId !== conversationId) return null
  const { prompt } = pending
  pending = null
  return prompt
}
