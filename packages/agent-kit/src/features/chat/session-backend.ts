// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";

/** 已打开的会话是不是 ACP 会话（消息操作行这类「会话内」的事用它）；没打开会话 = false */
export function activeConversationIsAcp(app: AgentApp): boolean {
  return (
    app.conversations.find((c) => c.id === app.activeConversationId)
      ?.backend === "acp"
  );
}

/**
 * 下一轮会不会走 ACP —— 输入框那一排（工具权限 / 上下文圆环）按它决定给不给。
 *
 * 会话已定型就以会话为准；**没有会话时看 `chatTarget`** —— 「开始新对话」页现在允许
 * 直接选外部 Agent（见 ModelSelect 的 ACP 组），所以这一支不是兜底，是新任务页的正路：
 * 选中即写 `chatTarget`，档位由 `probeDraftAcp` 探回来（见 `AcpModePill` 的草稿分支）。
 */
export function turnIsAcp(app: AgentApp): boolean {
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  return conversation
    ? conversation.backend === "acp"
    : app.chatTarget?.backend === "acp";
}
