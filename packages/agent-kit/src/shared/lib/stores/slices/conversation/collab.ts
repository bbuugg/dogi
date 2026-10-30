/**
 * 协作会话的事件折叠：把一条流事件并入 `CollabState` + 各 agent 的流式现场。
 * 纯函数（不碰 store），由 `handleFrame` 按事件类型分派。
 */
import type { AgentStreamEvent } from "@fizz/contracts/agent-api";
import {
  appendPartDelta,
  appendToolCallPart,
  foldToolResult,
  type CollabAgentRuntime,
  type CollabTask,
} from "@fizz/contracts/types";
import type { CollabClientState } from "./types";

/** 任务收口（这批事件之后该轮不会再变），实时现场交给快照里的 `parts` */
function isTerminal(status: CollabTask["status"]): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

/**
 * 服务端把工具入参**截断成 JSON 文本**发过来（完整性让给收口后的 `task.parts`）。
 *
 * 能 parse 就还原成对象：卡片抬头那个明细（`toolDetailOf`）只认 `path` / `command`
 * 这些键，喂字符串它一律忽略，卡片就只剩一个工具名。截断导致半截 JSON 时保留原文
 * ——卡片里至少能展开看到「它到底传了什么」。
 */
function parseToolInput(raw?: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

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
    const liveParts = { ...(base.liveParts ?? {}) };
    if (isTerminal(event.task.status)) {
      delete liveText[event.task.agentId];
      delete liveParts[event.task.agentId];
    }
    return {
      state: { ...state, tasks, updatedAt: Date.now() },
      liveText,
      liveParts,
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
      liveParts: base.liveParts ?? {},
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
      liveParts: base.liveParts ?? {},
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
    /**
     * 工具卡**边跑边长**：start 落一张卡，end 把结果折进同一张。
     *
     * 卡片形状与服务端收口后的 `CollabTask.parts` 完全一致（同一套
     * `appendToolCallPart` / `foldToolResult`），任务到终态、快照覆盖上来时不会跳变。
     * `input` / `output` 缺省时退回 `label`（老服务端只发摘要），卡片上至少还有一行字。
     */
    const liveParts = { ...(base.liveParts ?? {}) };
    const parts = [...(liveParts[event.agentId] ?? [])];
    if (event.phase === "start") {
      appendToolCallPart(parts, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: parseToolInput(event.input) ?? event.label ?? null,
      });
    } else {
      foldToolResult(parts, {
        toolCallId: event.toolCallId,
        output: event.output ?? event.label ?? null,
        isError: event.ok === false,
      });
    }
    liveParts[event.agentId] = parts;
    return {
      state: {
        ...state,
        statuses: { ...state.statuses, [event.agentId]: runtime },
        updatedAt: Date.now(),
      },
      liveText: base.liveText,
      liveParts,
    };
  }
  if (event.type !== "collab-delta") return base;
  const liveText = { ...base.liveText };
  liveText[event.agentId] = (
    (liveText[event.agentId] ?? "") + event.delta
  ).slice(-4000);
  /**
   * 正文 / 思考同步进过程记录。
   *
   * 不这么做的话，卡片会全部堆在正文**前面**（工具事件只追加卡，文本只走 `liveText`，
   * 两条流各记一份），看起来就像「先把工具都调完，再一口气说话」—— 与实际执行顺序不符。
   */
  const liveParts = { ...(base.liveParts ?? {}) };
  const parts = [...(liveParts[event.agentId] ?? [])];
  appendPartDelta(parts, event.channel, event.delta);
  liveParts[event.agentId] = parts;
  return { state, liveText, liveParts };
}
