// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import type { AgentWorkspace } from "@fizz/contracts/agent-api";

/**
 * 刚登记进来的工作区 / 项目：选中它、回到空会话。
 *
 * `addWorkspace` / `cloneWorkspace` 都已经在 store 里 `await refresh()` 过，拿到返回值时
 * 它已经在列表里了 —— 所以直接按 id 选，不用「等列表刷新 → 按路径找回来」那一跳。
 */
export function selectNewWorkspace(app: AgentApp, ws: AgentWorkspace): void {
  app.selectWorkspace(ws.id);
  void app.openConversation(null);
}
