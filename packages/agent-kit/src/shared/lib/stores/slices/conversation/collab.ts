/**
 * 协作会话的事件折叠：把一条流事件并入 `CollabState` + 各 agent 的流式文本。
 * 纯函数（不碰 store），由 `handleFrame` 按事件类型分派。
 */
import type { AgentStreamEvent } from "@fizz/contracts/agent-api";
import type { CollabAgentRuntime } from "@fizz/contracts/types";
import type { CollabClientState } from "./types";

export function applyCollabEvent(
  base: CollabClientState,
  event: AgentStreamEvent,
): CollabClientState {
  const state = base.state;
  if (event.type === "collab-task") {
    const tasks = [...state.tasks];
    const index = tasks.findIndex((t) => t.id === event.task.id);
    if (index >= 0) tasks[index] = event.task;
    else tasks.push(event.task);
    const liveText = { ...base.liveText };
    if (
      event.task.status === "done" ||
      event.task.status === "error" ||
      event.task.status === "cancelled"
    ) {
      delete liveText[event.task.agentId];
    }
    return {
      state: { ...state, tasks, updatedAt: Date.now() },
      liveText,
    };
  }
  if (event.type === "collab-message") {
    if (state.messages.some((m) => m.id === event.message.id)) return base;
    return {
      state: {
        ...state,
        messages: [...state.messages, event.message].slice(-500),
        updatedAt: Date.now(),
      },
      liveText: base.liveText,
    };
  }
  if (event.type === "collab-agent") {
    const runtime: CollabAgentRuntime = {
      status: event.status,
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(event.step !== undefined ? { step: event.step } : {}),
      ...(event.error ? { error: event.error } : {}),
      updatedAt: event.updatedAt,
    };
    return {
      state: {
        ...state,
        statuses: { ...state.statuses, [event.agentId]: runtime },
        updatedAt: Date.now(),
      },
      liveText: base.liveText,
    };
  }
  if (event.type === "collab-tool") {
    const prev = state.statuses[event.agentId] ?? {
      status: "running",
      updatedAt: Date.now(),
    };
    const runtime: CollabAgentRuntime = {
      ...prev,
      status: prev.status,
      ...(event.taskId ? { taskId: event.taskId } : {}),
      updatedAt: Date.now(),
    };
    if (event.phase === "start") runtime.toolName = event.toolName;
    else delete runtime.toolName;
    return {
      state: {
        ...state,
        statuses: { ...state.statuses, [event.agentId]: runtime },
        updatedAt: Date.now(),
      },
      liveText: base.liveText,
    };
  }
  if (event.type !== "collab-delta") return base;
  const liveText = { ...base.liveText };
  liveText[event.agentId] = (
    (liveText[event.agentId] ?? "") + event.delta
  ).slice(-4000);
  return { state, liveText };
}
