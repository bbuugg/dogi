/**
 * 对话 slice：每会话一份的「对话现场」+ 对话运行时（发一轮 / 收流 / 接回 / 队列 /
 * 审批卡 / 停止）。这是 store 的核心，逻辑整体平移自旧的 `useAgentApp` hook ——
 * 当年的 ref 兼容层（防闭包旧值）全部消失：zustand 的 `get()` 永远是最新值，
 * action 之间直接 `get().xxx()` 互相调用，没有依赖数组也没有循环依赖。
 */
import type { StateCreator } from "zustand";
import type {
  AgentBackend,
  AgentChatMessage,
  AgentConfirmRequest,
  AgentConversation,
  AgentStreamEvent,
  AiPermissionMode,
  AskFollowupRequest,
  ChatRunSummary,
  ChatStreamFrame,
  UploadFileRef,
} from "@fizz/contracts/agent-api";
import type {
  AiModelEntry,
  AcpModesState,
  AcpPermissionMode,
  AcpThoughtLevelState,
  AskFollowupAnswer,
  CollabAgentRuntime,
  CollabMessage,
  CollabSettings,
  CollabState,
  CollabTask,
  QueuedMessage,
} from "@fizz/contracts/types";
import {
  DEFAULT_BROWSER_SETTINGS,
  type BrowserSettings,
} from "@fizz/contracts";
import {
  assistantSliceId,
  buildUserParts,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TOOL_CALL_CONCURRENCY,
  resolveToolCallConcurrency,
} from "@fizz/contracts/agent-api";
import { applyEvent, textOf } from "@fizz/agent-kit/shared/lib/parts";
import { fileRefsOfParts } from "@fizz/agent-kit/shared/lib/attachments";
import { toBuiltinHistory } from "@fizz/agent-kit/shared/lib/acp-convert";
import { createFrameBatcher } from "@fizz/agent-kit/shared/lib/frame-batch";
import {
  dispatchProjectUiAction,
  uiActionsFromEvent,
} from "@fizz/agent-kit/shared/lib/tool-actions";
import { ApiError, httpStatusOf } from "@fizz/agent-client/api";
import {
  loadPermissionMode,
  savePermissionMode,
} from "@fizz/agent-kit/shared/lib/permission";
import {
  loadLastTarget,
  saveLastTarget,
} from "@fizz/agent-kit/shared/lib/last-target";
import { defaultCollabSettings } from "@fizz/agent-kit/shared/lib/collab-defaults";
import {
  errorMessage,
  nextLocalId,
} from "@fizz/agent-kit/shared/lib/stores/shared";
import type { AgentStore } from "@fizz/agent-kit/shared/lib/stores/agent-store";
import type { AcpProbeResult } from "@fizz/acp";

// ---------------------------------------------------------------------------
// 客户端偏好：直接落 localStorage（key 沿用旧 web-host 的，已存的设置不丢）
// ---------------------------------------------------------------------------

/** 上次打开的工作区 / 会话（启动恢复现场，会话自己记着选的模型） */
const ACTIVE_WORKSPACE_KEY = "fizz.web.activeWorkspaceId";
const ACTIVE_CONVERSATION_KEY = "fizz.web.activeConversationId";
/** confirm 审批超时（分钟）：默认 10，0 = 不超时 */
const CONFIRM_TIMEOUT_KEY = "fizz.web.confirmTimeout";

/** SSR 上没有 localStorage：各 loader 返回兜底值（客户端行为不变） */ function lsGet(
  key: string,
): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(key);
}
function lsSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value);
}

export function loadActiveWorkspaceId(): string | null {
  return lsGet(ACTIVE_WORKSPACE_KEY) || null;
}
export function saveActiveWorkspaceId(id: string | null): void {
  lsSet(ACTIVE_WORKSPACE_KEY, id ?? "");
}
export function loadActiveConversationId(): string | null {
  return lsGet(ACTIVE_CONVERSATION_KEY) || null;
}
export function saveActiveConversationId(id: string | null): void {
  lsSet(ACTIVE_CONVERSATION_KEY, id ?? "");
}
/**
 * 抹掉这份记录（**连键一起移除**，不是写空串）。
 *
 * 与 `saveActiveConversationId(null)` 的区别正是 `loadBlankIntent()` 判的那条线：
 * 「从没选过」与「明确要空态」是两种不同的状态，登出清场要的是**前者**（下次登录照旧
 * 兜底到最新一条会话），所以这里不能只写空串。
 */
export function clearActiveConversationId(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
}
/**
 * 「用户明确要空态」是否**已落盘**（键在、但为空串）。
 *
 * `saveActiveConversationId(null)` 写的是空串，而 `loadActiveConversationId()` 把空串也读成
 * `null` —— 于是「关掉了所有会话」与「从没选过」在它眼里一模一样。启动恢复必须分清这两者：
 * 前者**不能**再把会话拉回来（用户刚亲手把它们关掉），后者才该兜底到该工作区最新一条。
 * 所以这里直接看**键在不在**：键在且为空 = 明确要空态。
 *
 * 为什么不能只靠 store 里的 `blankIntent`：那个是内存态，刷新即丢，而用户关掉所有会话之后
 * 往往紧接着就是刷新页面 —— 正是它护不住的那一刻。
 */
export function loadBlankIntent(): boolean {
  return lsGet(ACTIVE_CONVERSATION_KEY) === "";
}

/** 审批超时（分钟）：默认 10，0 = 不超时；存坏了回落默认 */
function loadConfirmTimeout(): number {
  const raw = lsGet(CONFIRM_TIMEOUT_KEY);
  if (raw === null) return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 10;
}
function saveConfirmTimeout(minutes: number): void {
  lsSet(CONFIRM_TIMEOUT_KEY, String(minutes));
}

/** 模型请求自动重试次数（0 = 不限制）：默认 2；存坏了 / 非法回落默认 */
const MAX_RETRIES_KEY = "fizz.web.maxRetries";
function loadMaxRetries(): number {
  const raw = lsGet(MAX_RETRIES_KEY);
  if (raw === null) return DEFAULT_MAX_RETRIES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_MAX_RETRIES;
}
function saveMaxRetries(value: number): void {
  lsSet(MAX_RETRIES_KEY, String(value));
}

/** 同一批工具调用的并发上限（1 = 串行）：默认 3；存坏了 / 越界夹回合法区间 */
const TOOL_CONCURRENCY_KEY = "fizz.web.toolCallConcurrency";
function loadToolCallConcurrency(): number {
  const raw = lsGet(TOOL_CONCURRENCY_KEY);
  if (raw === null) return DEFAULT_TOOL_CALL_CONCURRENCY;
  const n = Number(raw);
  return Number.isFinite(n)
    ? resolveToolCallConcurrency(n)
    : DEFAULT_TOOL_CALL_CONCURRENCY;
}
function saveToolCallConcurrency(value: number): void {
  lsSet(TOOL_CONCURRENCY_KEY, String(resolveToolCallConcurrency(value)));
}

/**
 * 这一轮的 live 助手消息：原占位本身，或运行中插话拆分出的后继
 * （`assistantSliceId(assistantId, 插话消息 id)`，形状见 contracts）。数组顺序即插入顺序，
 * **倒序找第一条**就是 live —— 插话之后到达的增量要写进后继那条（正文才不会跑到插话上面去）。
 */
function isSteerAssistant(m: AgentChatMessage, assistantId: string): boolean {
  return (
    m.role === "assistant" &&
    (m.id === assistantId || m.id.startsWith(`${assistantId}-s`))
  );
}

/**
 * 队列里一条待发送消息。
 *
 * 类型真源在契约层（`@fizz/contracts/types`）—— 队列要落服务端
 * （`AgentConversation.queuedMessages`），两端必须是同一个形状。这里 re-export
 * 一份，老调用方不用改 import 路径。
 */
export type { QueuedMessage };

/**
 * 待发送队列：**服务端权威** + localStorage 缓存。
 *
 * 缓存不是「老实现遗留」，它在两处仍是必需的：
 * 1. 打开会话时先拿缓存渲染，服务端那份回来后**无感替换**（否则列表先闪一下空）；
 * 2. 服务端 / 网络不可用（未连接 / 离线 / 写失败）时队列照旧能用，只是不跨端。
 */
const QUEUE_KEY_PREFIX = "fizz.web.queue.";
function loadQueue(conversationId: string): QueuedMessage[] {
  try {
    const raw = lsGet(QUEUE_KEY_PREFIX + conversationId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (m): m is QueuedMessage =>
            !!m && typeof m.id === "string" && typeof m.text === "string",
        )
      : [];
  } catch {
    return [];
  }
}
function saveQueue(
  conversationId: string | null,
  items: QueuedMessage[],
): void {
  if (!conversationId) return;
  try {
    if (items.length === 0) lsRemove(QUEUE_KEY_PREFIX + conversationId);
    else lsSet(QUEUE_KEY_PREFIX + conversationId, JSON.stringify(items));
  } catch {
    // localStorage 不可用（隐私模式 / 超额）：队列退回纯内存，不阻塞发送
  }
}
function lsRemove(key: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(key);
}
/** 清掉所有按会话隔离的待发送队列（登出 / 401 失效时别残留到下次登录） */
function clearAllQueues(): void {
  try {
    if (typeof window === "undefined") return;
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(QUEUE_KEY_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // localStorage 不可用：队列本来就只是内存态，跳过
  }
}

/** ---------------------------------------------------------------------------
 * 断线重接（页面切后台 / 电脑休眠 / 网络切换时那条 SSE 会断）
 * --------------------------------------------------------------------------- */

/**
 * 每个会话「接回中」的标记（`attachRun` 的重接循环持有它）。
 *
 * 只为一件事存在：**防止并发接入**。页面从后台回来时 `visibilitychange` 会主动触发
 * 一次重接，而自动重接的退避睡眠可能还挂着 —— 两条流同时 attach 会把回放帧追加两遍
 * （`handleFrame` 是追加式的，重复就是正文重复）。
 */
const subscribing = new Set<string>();

/**
 * 正在退避睡眠的重接循环：会话 id → 提前唤醒它（用户点了消息区那条「立即重连」）。
 *
 * 没有它的话，按钮点下去只会撞上 `subscribing` 的去重早退（`attachRun` 直接 return true，
 * 什么都不做），提示条看着像死的。唤醒之后由那个循环自己重试 —— 仍然只有一条流，
 * 不会出现两路回放把正文追加两遍。
 */
const reconnectNudges = new Map<string, () => void>();

/** 正在做「断线轮次对账」的会话：防并发（页面回前台 + online 会各触发一次） */
const reconciling = new Set<string>();

/** 第 N 次重接等多久：1s → 2s → 4s…，封顶 8s（后台 tab 的定时器会被浏览器拖慢，够用就好） */
const reconnectBackoff = (attempt: number): number =>
  Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000);

/** 睡一会儿（只给断线重接的退避用） */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 退避睡眠，且允许被「立即重连」提前唤醒（唤醒 = 立刻重试，不等剩下的退避时间） */
const sleepReconnect = (
  conversationId: string,
  attempt: number,
): Promise<void> =>
  new Promise<void>((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      if (reconnectNudges.get(conversationId) === wake)
        reconnectNudges.delete(conversationId);
      resolve();
    };
    const timer = setTimeout(wake, reconnectBackoff(attempt));
    reconnectNudges.set(conversationId, wake);
  });

// ---------------------------------------------------------------------------
// 每会话一份的「对话现场」（slice）
// ---------------------------------------------------------------------------

/**
 * 一个会话的**全部本地对话现场**。
 *
 * 以前这些全是全局单份（消息列表 / streaming / 当前轮 / 审批卡 / 提问表 / 队列 /
 * 装载标记 / 加载代次），隐含「一个标签页同一时刻只盯一轮」的假设：切走会话时
 * 消息列表被清空，在途 SSE 帧写到找不到的占位消息上被**静默丢弃**，切回来既没有
 * 半截现场、也不重新接回 —— 看起来像「断开了」。现在每个会话各留一份：切走时
 * 帧继续落在它自己的 slice 上，切回来就是最新直播；A 后台跑、B 发消息互不打架，
 * 停止钮 / 审批卡 / 队列都各归各的会话。
 *
 * 内存有界：淘汰策略见 `pruneSlices`（保留在跑的 + 最近看过的几个，其余现场丢弃
 * —— 历史真源在服务端，重新打开走装载链路再拉一遍）。
 */
export interface ConvSlice {
  messages: AgentChatMessage[];
  /** 这个会话正在流式（本地订着一轮，帧在往 `messages` 里追加） */
  streaming: boolean;
  /**
   * 正在**回放现场**：断线重连后，服务端从帧日志头部把这一轮重放一遍，客户端先把
   * 这一轮的 parts 清空再逐帧重建（见 `attachRun` 的重接循环）。
   *
   * 只在重连时短暂为真，`replay-end` 帧（服务端在回放末尾补的那条，见 contracts 的
   * `ChatStreamFrameType`）到达即撤。
   *
   * 它存在的唯一理由：回放期间内容高度**先塌后长**，而 `streaming` 为真时滚动跟随走
   * 的是库的 spring 平滑动画 —— 于是用户看到「消息列表像在重新加载，一直从顶部往下滚」
   * （实测反馈）。`MessageList` 用它把回放期间的跟随降级成瞬时贴底。
   */
  replaying: boolean;
  /**
   * 这一会话当前轮的 requestId / controller / 占位助手消息 id（停止钮用；null = 没有在跑的轮）。
   *
   * `assistantId` 是**断线重接**的关键：连接断了之后要接着往同一条占位消息上回放，
   * 没有它就分不清哪条是「这一轮的占位」，只能再 push 一条空的。
   */
  request: {
    id: string;
    controller: AbortController;
    assistantId: string;
  } | null;
  /** confirm 模式下等用户答复的审批（按到达顺序；同一时刻服务端只放一条） */
  pendingConfirms: AgentConfirmRequest[];
  /** 在等的 ask_followup_question 提问（按 toolCallId 索引，供工具卡片渲染提问表单） */
  followupRequests: Record<string, AskFollowupRequest>;
  /** 待发送队列：会话进行中用户继续发消息时先排这里，本轮结束依次执行 */
  queuedMessages: QueuedMessage[];
  /**
   * 已插入、还没生效的插话（steer）：POST 成功即入列，agent 在边界消费时随
   * `user-injected` 事件出列（转入会话流）。用户可在此撤回（DELETE steer）。
   * 只在**发送方**这个端有 —— 收件箱是 run 内存态，别的端要等消费事件才看得到。
   */
  pendingSteers: AgentChatMessage[];
  /**
   * 队列链为什么停了：上一轮**失败**时不自动发下一条（防坏配置把整个队列烧完），
   * 这里记 `'failed'`，队列头部据此显示「上轮失败，队列已暂停」+ 一键继续 / 清空。
   * 成功开轮、手动发队列、清空队列时复位为 null。null = 没有暂停。
   */
  queuePausedReason: "failed" | null;
  /** 历史装载中（打开会话后拉存档 / acp 回放的窗口）：消息区此时显示装载中而不是旧列表 */
  loading: boolean;
  /**
   * 正在删消息（「仅本条」/「本条及其后」/ 编辑重发里的那一步）。
   *
   * 消息区据此挂「正在删除…」的提示并暂时不收点击：删除要动服务端消息、随后整体回拉
   * 历史，中途再叠一次编辑 / 删除，两边的回拉会互相盖。用户报过「删的时候什么都没有、
   * 还能继续点别的消息」。
   */
  deleting: boolean;
  /** 历史装载失败（mastra 拉存档 / acp session/load 回放）：由消息列表展示错误 + 重试 */
  error: string | null;
  /**
   * 模型请求正在重试：显示「第 N 次重试」的**单条**提示（每次重试自替换，屏幕上只留最新一条）。
   * null = 当前没在重试。属于「通知」不是消息 part（不落盘，见 handleFrame）。
   */
  retryNotice: { attempt: number; maxRetries: number | null } | null;
  /**
   * 连接断了但服务端那轮还在跑：正在自动重接（第几次）。null = 连接正常 / 没在重接。
   * 属于「通知」不是消息 part（不落盘，见 `attachRun` 的断线重接循环）。
   */
  reconnectNotice: { attempt: number } | null;
  /**
   * 有一轮在客户端看是「断线失败」的，但服务端很可能在断线期间把它跑完并落盘了
   * （run 的生命周期不挂在客户端连接上）。这里记下 `baseCount` = **这一轮开跑前**
   * 本地有多少条消息，作为对账基准：之后拉服务端权威历史，比它长且末位是助手消息
   * 就说明这一轮真落盘了，用权威历史盖掉本地那条「网络错误」。
   *
   * 场景：手机息屏 / 电脑休眠，SSE 在睡梦里断了，醒来时那一轮早就跑完 —— 服务端
   * 有完整回复，客户端却只能显示网络错误。以前必须刷新页面才看得到内容。
   * null = 没有待对账的断线轮次。
   */
  droppedRound: { baseCount: number } | null;
  /**
   * 消息加载的代次。`runRound` 开跑会 +1：作废在途的 `loadMessages`，防止
   * 「上一轮收流后的权威快照」把**下一轮刚开始的本地消息**盖掉。
   */
  loadGen: number;
  /**
   * 「切换会话 / 消息装载完成」的信号：自增时 ChatPanel 让消息区**同帧同步**落底
   * （见 ai-elements/conversation.tsx 的 resetKey）。流式追加、每轮结束后的历史
   * 刷新都不碰它，免得把正在翻历史的用户拽到底部。
   */
  scrollResetSeq: number;
  /** 最近一次被打开 / 触碰的时刻（淘汰排序用） */
  touchedAt: number;
  /** 协作运行态（仅 collab 会话；任务 / 消息 / 状态 + 实时增量） */
  collab: CollabClientState | null;
}

/** 协作会话在客户端的现场：服务端快照 + 尚未收敛的流式文本 */
export interface CollabClientState {
  state: CollabState;
  /** agentId → 正在流式输出的文本（收到任务结果后清空） */
  liveText: Record<string, string>;
}

function applyCollabEvent(
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

const emptySlice = (): ConvSlice => ({
  messages: [],
  streaming: false,
  replaying: false,
  request: null,
  pendingConfirms: [],
  followupRequests: {},
  queuedMessages: [],
  loading: false,
  deleting: false,
  error: null,
  queuePausedReason: null,
  pendingSteers: [],
  retryNotice: null,
  reconnectNotice: null,
  droppedRound: null,
  loadGen: 0,
  scrollResetSeq: 0,
  touchedAt: Date.now(),
  collab: null,
});

/** slice 淘汰上限：在跑的必留，其余按 touchedAt 留最新的这几个 */
const SLICE_KEEP = 8;

// 渲染层的稳定空值：slice 不存在时派生字段返回它们，避免每次渲染新数组身份
export const NO_MESSAGES: AgentChatMessage[] = [];
export const NO_CONFIRMS: AgentConfirmRequest[] = [];
export const NO_QUEUE: QueuedMessage[] = [];
export const NO_STEERS: AgentChatMessage[] = [];
export const NO_FOLLOWUPS: Record<string, AskFollowupRequest> = {};

/**
 * 「开始新对话」页选中的 ACP agent 的档位快照（还没建会话，见 `ConversationSlice.draftAcp`）。
 *
 * 生命周期：选中 agent → `probeDraftAcp` 拿候选档位 → 用户挑 → 发送时建会话 →
 * 把 `mode` / `thought` 下发给这个会话 → 清空。
 */
export interface DraftAcpState {
  agentId: string;
  /** 探针在跑（pill 上转圈） */
  loading: boolean;
  /** 探针失败的原因（agent 起不来 / 超时）；pill 退化成「默认档」 */
  error: string | null;
  /** agent 广告的 Session Modes；没广告则 null */
  modes: AcpModesState | null;
  /** agent 广告的思考档；没广告则 null */
  thoughtLevel: AcpThoughtLevelState | null;
  /** 用户选中的模式 id；null = 跟随 agent 默认 */
  mode: string | null;
  /** 用户选中的思考档；null = 跟随 agent 默认 */
  thought: string | null;
}

export interface ConversationSlice {
  // ---------- 状态 ----------
  slices: Record<string, ConvSlice>;
  activeWorkspaceId: string | null;
  activeConversationId: string | null;
  /**
   * 本轮要用的模型 / 后端。打开会话时从它自己记住的配置恢复；`null` = 还没选
   * （界面显示「选择模型」，发送会被拦下并提示）。
   *
   * 持久化到会话目录的 `config.json`（见 setChatTarget / persistTarget）。刻意**不做
   * 「清单第一份」的自动预选**：配置 / agent 被删、模型下架时显示「选择模型」，
   * 让用户自己选，而不是替他挑一个从没选过的模型。
   */
  chatTarget: {
    backend: AgentBackend;
    configId?: string;
    /** mastra 下：这份配置里具体用哪个上游模型（`AiModelConfig.models` 的一项） */
    modelId?: string;
  } | null;
  /**
   * 当前会话**允许使用的 MCP server id 清单**（持久化在会话上，刷新还在）。
   *
   * 刻意**不挂在 `chatTarget` 下**：那东西语义是「用哪个模型 / agent」，MCP 是正交的
   * 另一根轴 —— 模型怎么选都照样可以给这个会话配 MCP 工具。
   *
   * 没有活动会话时（新任务页）这是一份**待定选择**：随会话创建一起落库。
   */
  mcpServerIds: string[];
  /**
   * 当前会话的**浏览器偏好**（总开关 + 来源，持久化在会话上，刷新还在）。
   *
   * `null` = 这个会话没单独设过 → 界面按全局默认（`defaultBrowserSettings`）显示，
   * 与 MCP 一样，没有活动会话时是一份**待定选择**，随会话创建一起落库。
   */
  browserSettings: BrowserSettings | null;
  /**
   * 「开始新对话」页选中的 ACP agent 的**档位快照**（还没有会话，所以不能挂在会话上）。
   *
   * 为什么需要：ACP 的模式 / 思考档是 agent 在 `session/new` 应答里广告的，平时存在
   * `conversation.acpModes` / `acpThoughtLevel` 上 —— 新任务页没有会话，那排 pill 就没数据。
   * 选中 agent 时先探一次（`probeAcpCapabilities`，一次性会话、问完收掉），候选档位与用户的
   * 选择临时放这里；会话建好后立刻把选中的档位下发（`setAcpAgentMode` / `setAcpThoughtLevel`），
   * 然后清空。`null` = 当前没选 ACP。
   */
  draftAcp: DraftAcpState | null;
  /** 正在跑一轮对话的会话 id 集合（侧栏转圈按会话跟踪；与当前打开哪个无关） */
  runningConversations: Record<string, true>;
  /**
   * 「用户明确要空态」的标记：`openConversation(null)`（点「新建会话」、删掉当前会话后
   * 落空态）置位，打开具体会话时清掉。
   *
   * 「恢复会话」的 effect 只看 `activeConversationId` 是不是空的 —— 跨工作区点
   * 「新建会话」时它正好是空的（刚清），effect 立刻按兜底逻辑把该工作区**最新一条会话**
   * 打开，表现出来就是「点新建会话却进了某个旧会话」。用它把「用户主动要空态」和
   * 「还没恢复过」区分开。
   */
  blankIntent: boolean;
  /** 切换命令执行权限（存本地；下一轮生效） */
  permissionMode: AiPermissionMode;
  /** confirm 审批超时（分钟；0 = 不超时）。随每轮请求带给服务端 */
  confirmTimeoutMin: number;
  /** 模型请求自动重试次数（0 = 不限制）。随每轮请求带给服务端 */
  maxRetries: number;
  /** 同一批工具调用的并发上限（1 = 串行）。随每轮请求带给服务端 */
  toolCallConcurrency: number;

  // ---------- slice 读写 ----------
  readSlice: (conversationId: string | null) => ConvSlice;
  writeSlice: (
    conversationId: string,
    patch: (s: ConvSlice) => ConvSlice,
  ) => void;
  dropSlice: (conversationId: string) => void;
  /** 现场淘汰：在跑的必留，其余按 touchedAt 留最新的 SLICE_KEEP 个 */
  pruneSlices: (keepId: string | null) => void;
  /** 断开连接 / 登出时清一切本地现场（slice + 队列持久化） */
  clearAllLocalState: () => void;

  // ---------- 会话 ----------
  markRunning: (conversationId: string, running: boolean) => void;
  persistTarget: (
    conversationId: string,
    target: {
      backend: AgentBackend;
      configId?: string;
      modelId?: string;
    } | null,
  ) => void;
  setChatTarget: (
    target: {
      backend: AgentBackend;
      configId?: string;
      modelId?: string;
    } | null,
  ) => void;
  /**
   * 新任务页选中 ACP agent 时探一次它的档位（模式 / 思考档）。
   *
   * 幂等：同一个 agent 已经探过（成功或失败）就直接返回，别每次点下拉都起一个进程。
   * 探针失败只写 `error`，不抛 —— 页面上退化成「默认档」，不挡用户发送。
   */
  probeDraftAcp: (agentId: string) => Promise<void>;
  /** 新任务页选模式（null = 跟随 agent 默认）；没有 draftAcp 时忽略 */
  setDraftAcpMode: (modeId: string | null) => void;
  /** 新任务页选思考档（null = 跟随 agent 默认）；没有 draftAcp 时忽略 */
  setDraftAcpThought: (value: string | null) => void;
  /** 清掉草稿态（切回内置 agent / 建完会话后调） */
  clearDraftAcp: () => void;
  /**
   * 设置当前会话允许使用的 MCP server 清单（全量覆盖，空 = 全不选）。
   * 有活动会话立刻持久化；没有（新任务页）则留作待定选择，随会话创建落库。
   */
  setMcpServerIds: (ids: string[]) => void;
  /**
   * 设置**当前会话**的浏览器偏好（总开关 / 来源）。传入的是**部分字段**，与当前值合并后
   * 整体落库（服务端的 target 契约是整体对象语义）。
   * 有活动会话立刻持久化；没有（新任务页）则留作待定选择，随会话创建落库。
   */
  setBrowserSettings: (patch: Partial<BrowserSettings>) => void;
  setPermissionMode: (mode: AiPermissionMode) => void;
  /**
   * 设置**当前 ACP 会话**的权限答复策略（`confirm` = 逐次问；`allow` = 应用层自动放行）。
   * 按会话持久化到 `config.json`；没有活动会话时什么都不做（新任务页没有会话可绑）。
   */
  setAcpPermissionMode: (mode: AcpPermissionMode) => void;
  setConfirmTimeoutMin: (minutes: number) => void;
  setMaxRetries: (value: number) => void;
  setToolCallConcurrency: (value: number) => void;
  loadMessages: (
    conversationId: string,
    opts?: { loadError?: boolean },
  ) => Promise<AgentConversation | null>;
  handleFrame: (
    conversationId: string,
    assistantId: string,
    frame: ChatStreamFrame,
  ) => void;
  /** 覆盖协作配置（画布拖拽 / 增删 Agent）；成功后就地更新会话清单里的那份 */
  saveCollabSettings: (settings: CollabSettings) => Promise<boolean>;
  /** 取消当前协作轮里某个正在跑的子任务 */
  cancelCollabTask: (taskId: string) => Promise<boolean>;
  attachRun: (conversationId: string) => Promise<boolean>;
  /**
   * 重接一条进行中的对话：用户点消息区「连接中断」条上的按钮、或页面从后台回来时调。
   * 内部就是 attachRun —— 查服务端有没有在跑的 run、复用现有占位消息、断线自动重接。
   */
  reconnectRun: (conversationId: string) => Promise<boolean>;
  /**
   * 对账一个「断线失败」的轮次：拉服务端权威历史，它确实存下了这一轮就用它替换本地
   * 那条网络错误（页面回前台 / 网络恢复时调）。返回 true = 换回来了。
   */
  reconcileDroppedRun: (conversationId: string) => Promise<boolean>;
  loadConversation: (conversationId: string) => Promise<void>;
  openConversation: (conversationId: string | null) => void;
  retryLoadMessages: () => void;
  /**
   * 重新加载一条 ACP 会话：**当场**再走一次 `session/load`，用 agent 侧回放**整体重建**
   * 本地消息列表。
   *
   * 与「重启会话」（`restartAcpSession`）的分工：重启只杀 agent 进程、视图一动不动，
   * 重连发生在下一条消息里（用途是让 agent 侧启动期读的配置生效）；本项是**把视图拉回来
   * 对齐** —— agent 侧会话在别处被改过、打开时回放只回来半截、视图与 agent 侧对不上时用它。
   *
   * 服务端**不需要新路由**：直接复用 `GET /api/acp/agents/:id/transcript` —— 那条路由
   * 就是 `session/load` 回放（内部先 teardown 旧进程，保证从干净进程 load）。
   *
   * 成功 `true`；缺 agent 侧会话 / 找不到工作区目录 / 回放失败 `false`（原因进 `error`）。
   */
  reloadAcpSession: (conversationId: string) => Promise<boolean>;
  /**
   * **重新加载这一条会话**（等价于「刷新页面 → 点开它」，只作用于它）。
   *
   * 两个入口都用它：消息里那条「⚠️ …」错误块下面的「重新加载」按钮，以及主区域标签
   * 右键菜单的「刷新」（对话标签走这条路，工具标签才走 `tab-reload` 的卸载重挂）。
   *
   * mastra 走服务端权威历史覆盖、ACP 走 `session/load` 回放（与刷新页面后打开同源）；
   * **正在生成时直接返回 `false`**（不做事），避免把流式现场盖掉。
   * 成功 `true`；失败 `false`（原因进 `error`，界面自己显示）。
   */
  reloadConversation: (conversationId: string) => Promise<boolean>;
  /**
   * 选中项目。`null` = **不选项目**（输入框下方那颗「未指定工作区」）—— 那只是界面上的
   * 临时状态，发送时服务端会给会话建一个临时工作区并绑上去（见 `newConversation`）。
   */
  selectWorkspace: (workspaceId: string | null, openNewest?: boolean) => void;
  /**
   * 建一条会话，返回新会话 id（失败 `null`，原因进 `error`）。
   *
   * `done` 是调用方给的「这次创建已经收尾」回调：**成功、失败都会调一次**，参数是
   * 新会话 id（失败为 `null`）。异步建会话的入口（`runRound` 的「发送即建会话」）靠它
   * 收掉「正在创建」的转圈 —— 从按键到会话真正可用的那段空窗，ACP 要起外部 agent
   * 进程 + `session/new`，几百毫秒到几秒，比内置模型那次往返明显得多。
   *
   * ⚠️ 在 `runRound` 里不要用 `await` 包着这份 Promise 去收尾：那要等整条建会话链路
   * 走完，而转圈的作用是「告诉用户点了有用」，越早熄越好。
   */
  newConversation: (
    workspaceId?: string,
    title?: string,
    target?: {
      backend: AgentBackend;
      configId?: string;
      modelId?: string;
      acpSessionId?: string;
      mcpServerIds?: string[];
      /** 多智能体协作：创建时一并落配置 */
      kind?: "collab";
      collab?: CollabSettings;
    },
    done?: (conversationId: string | null) => void,
  ) => Promise<string | null>;
  /**
   * 建一条「多智能体协作」会话（侧栏「多智能体协作」入口）：**不弹窗、不选模型**。
   *
   * 默认班子取 `defaultCollabSettings()`；主模型优先沿用上次发送用的内置模型
   * （`preferredTarget`），没有就留空 —— 用户在建好的会话里选，与空白页同一条规矩
   * （不替用户挑一个没选过的模型）。建好后由调用方的 `openConversation` 打开标签。
   */
  newCollabConversation: (workspaceId?: string) => Promise<string | null>;
  deleteConversation: (
    id: string,
  ) => Promise<{ ok: boolean; nextId: string | null }>;
  clearConversation: (id: string) => Promise<void>;
  /** 只删某一条消息（后面的消息保留） */
  deleteMessage: (messageId: string) => Promise<void>;
  deleteMessagesFrom: (messageId: string) => Promise<void>;
  /** 编辑并重发：先删掉该条及其后的消息，再当新消息发出去（返回值同 `send`） */
  resendMessage: (
    messageId: string,
    text: string,
    files?: UploadFileRef[],
    onStarted?: () => void,
  ) => Promise<boolean>;

  // ---------- 发一轮 ----------
  enqueueMessage: (text: string, files?: UploadFileRef[]) => void;
  removeQueuedMessage: (id: string) => void;
  updateQueuedMessage: (id: string, text: string) => void;
  /** 拖拽排序：把 `id` 这一条挪到 `beforeId` 前面（`beforeId` 为空 = 挪到最后） */
  moveQueuedMessage: (id: string, beforeId: string | null) => void;
  /** ↑↓ 按钮微调：`id` 这一条在队列里相对挪 `delta` 位（-1 = 更早发出） */
  moveQueuedMessageBy: (id: string, delta: number) => void;
  sendQueuedMessage: (id: string) => void;
  /** 清空待发送队列（含解除失败暂停标记） */
  clearQueuedMessages: () => void;
  /**
   * 会话分叉：fork 当前会话到某条消息（含），刷新列表并切到新会话。
   * `opts.worktreeIdentifier` 给了就先在会话所属项目下建 worktree（标识即目录名
   * `<项目>/.worktree/<标识>`，也是新分支名的一部分），再把分叉挂到新工作区上。
   */
  forkConversation: (
    upToMessageId: string,
    opts?: { worktreeIdentifier?: string; worktreeName?: string },
  ) => Promise<void>;
  /**
   * 把一条 ACP 会话的内容转成**内置 agent 会话**：现拉 agent 侧转录 → 洗成内置格式 →
   * 新建一条 mastra 会话（同工作区、带历史）→ 刷新列表并切过去。
   * 成功 `true`；拉不到转录 / 建会话失败 `false`（原因进 error）。
   *
   * `upToMessageId` 传了 = **「从某条消息起转为内置」**：历史只保留到该条（含）为止
   * （对应每条消息下方那颗按钮）；不传 = 整条会话全量转换（侧栏那一项）。
   *
   * `opts.worktreeIdentifier` 给了就先在**源会话所属**项目下建 worktree，再把新会话挂进
   * 那个新工作区（与 `forkConversation` 同款）；不给则与原会话同工作区。
   */
  convertAcpConversation: (
    conversationId: string,
    upToMessageId?: string,
    opts?: { worktreeIdentifier?: string; worktreeName?: string },
  ) => Promise<boolean>;
  pump: () => void;
  /**
   * 真正发起一轮（`true` = 确实开跑了；`false` = 没连上 / 没选模型 / 建会话失败被拦下）。
   * `onStarted` 见 `send` 的说明 —— 由它一路透传进来。
   */
  runRound: (
    text: string,
    files?: UploadFileRef[],
    onStarted?: () => void,
  ) => Promise<boolean>;
  /**
   * 带附件时允许空正文（files 非空即可发）；流式中 → 入队，本轮结束由泵自动发出。
   *
   * 返回 `true` = 这一轮**真的开跑了**（或已入队），`false` = 被本地守卫拦下、什么都没发。
   * 调用方（输入框）据此把草稿放回去 —— 拦下时本来就弹了错误提示，再把用户写的内容
   * 吃掉就更没道理了。
   *
   * `onStarted` 在「确认要发」的那一刻（乐观消息已落本地）回调一次：**草稿区里那些
   * 一次性资源（附件、引用）应该在这里才清**，而不是在提交那一刻 —— 提交时就清等于
   * 赌这一轮一定发得出去，赌输了用户连附件都得重新传一遍。
   */
  send: (
    text: string,
    files?: UploadFileRef[],
    onStarted?: () => void,
  ) => Promise<boolean>;
  /**
   * 运行中插话：活跃会话在跑 → 递服务端收件箱（agent 下一个工具步骤边界注入）；
   * 409 / 没在跑 → 回落普通发送。只有 mastra 会话支持（ACP 会话上服务端 400，
   * 这里把可用性判断留给命令面板的 `available`）。
   *
   * `files` 与 `text` 至少要有一个；附件随插话一起注入当前轮（回落普通发送时也带着）。
   */
  steer: (
    text: string,
    files?: UploadFileRef[],
    onStarted?: () => void,
  ) => Promise<boolean>;
  /** 撤回一条还没生效的插话（removed=false = 已消费；本地照移，等 user-injected 对账） */
  removeSteer: (messageId: string) => Promise<void>;
  /**
   * 重排插话（拖拽：把 `messageId` 挪到 `beforeId` 前面；`beforeId` 为空 = 挪到最后）。
   * 与队列的 `moveQueuedMessage` 同一套语义：本地立即生效（拖拽要跟手），
   * 服务端是**尽力而为**的补写。
   */
  moveSteer: (messageId: string, beforeId: string | null) => void;
  /** ↑↓ 按钮微调：`messageId` 这条相对挪 `delta` 位（-1 = 更早生效） */
  moveSteerBy: (messageId: string, delta: number) => void;
  /**
   * 立刻把一条还没发出去的插话发出去（行的 ➤）：与队列的 `sendQueuedMessage` 同款。
   *
   * 用户停止一轮（abort）后插话已经被服务端丢弃、这一轮也不在了，所以这里是
   * **以新一轮的普通消息发出去**（文本 + 附件一起）。会话进行中忽略（跑着时那颗钮禁用）。
   */
  sendSteer: (messageId: string) => void;
  stop: () => Promise<void>;
  /**
   * 停止**指定会话**当前正在跑的那一轮（不依赖「谁是当前会话」）。
   *
   * 与 `stop` 的分工：`stop` 只认 `activeConversationId`，用于「当前会话」的停止按钮；
   * 而批量关标签这类场景关掉的多半**不是**活动标签，用 `stop` 会停错会话 —— 那里必须用这个
   * id 版。关标签守卫（`ConversationTab`）就是拿它先停会话再放行关闭。
   */
  stopConversation: (conversationId: string) => Promise<void>;
  /**
   * 只停这一条 execute_command（工具卡头部那颗停止钮，命令在执行时命中它）。
   * 拿当前会话在跑那轮的 requestId + 该命令的 toolCallId 打
   * `POST /api/chat/command/stop`；服务端杀进程树，工具结果收尾成「（已中止）」，
   * Agent 同一回合继续。**不动整轮**（那叫 `stop`）。
   */
  stopCommand: (toolCallId: string) => Promise<void>;

  // ---------- 审批 / 提问 ----------
  resolveConfirm: (
    id: string,
    approved: boolean,
    optionId?: string,
  ) => Promise<void>;
  resolveFollowup: (
    toolCallId: string,
    answer: AskFollowupAnswer | null,
  ) => Promise<void>;
}

export const createConversationSlice: StateCreator<
  AgentStore,
  [],
  [],
  ConversationSlice
> = (set, get, api) => {
  // ---------- slice 读写助手（唯一的写入口；zustand 的 set 同步生效，get 永远最新） ----------

  const readSlice = (conversationId: string | null): ConvSlice =>
    (conversationId && get().slices[conversationId]) || emptySlice();

  /**
   * 写某个会话的现场：patch 拿旧现场返回新现场。从 `get()` 的最新值出发计算，
   * 同一帧多次写同会话链式正确。
   */
  const writeSlice = (
    conversationId: string,
    patch: (s: ConvSlice) => ConvSlice,
  ): void => {
    const next = patch(get().slices[conversationId] ?? emptySlice());
    set((state) => ({ slices: { ...state.slices, [conversationId]: next } }));
  };

  /** 整个丢掉一个会话的现场（删除会话 / 断开连接用） */
  const dropSlice = (conversationId: string): void => {
    if (!(conversationId in get().slices)) return;
    set((state) => {
      const next = { ...state.slices };
      delete next[conversationId];
      return { slices: next };
    });
  };

  const pruneSlices = (keepId: string | null): void => {
    const entries = Object.entries(get().slices);
    if (entries.length <= SLICE_KEEP) return;
    const keep = new Set<string>();
    if (keepId) keep.add(keepId);
    for (const [id, s] of entries) {
      if (s.streaming || s.request || get().runningConversations[id])
        keep.add(id);
    }
    const rest = entries
      .filter(([id]) => !keep.has(id))
      .sort((a, b) => b[1].touchedAt - a[1].touchedAt);
    for (const [id] of rest.slice(0, Math.max(0, SLICE_KEEP - keep.size)))
      keep.add(id);
    const next: Record<string, ConvSlice> = {};
    for (const [id, s] of entries) if (keep.has(id)) next[id] = s;
    set({ slices: next });
  };

  /** 一份模型配置下可选的模型清单（老数据没有 models 时退回单个 model） */
  const catalogOf = (config: { models: AiModelEntry[] }): string[] =>
    config.models.map((model) => model.id);

  /**
   * 这个目标现在还能不能用：
   * - mastra：配置还在，且 `modelId` 仍在这份配置的模型清单里；
   * - acp：agent 还在（模型值由 agent 自己广告，本地清单里查不到也放行）。
   *
   * 「配置在但记的那个模型下架了」**不算还活着** —— 界面据此显示「选择模型」，
   * 而不是替用户挑一个清单里的别的模型。
   */
  const isTargetAlive = (
    target:
      | { backend: AgentBackend; configId?: string; modelId?: string }
      | null
      | undefined,
  ): boolean => {
    if (!target?.configId) return false;
    const { models, acpAgents } = get();
    if (target.backend === "acp")
      return acpAgents.some((a) => a.id === target.configId);
    const config = models.find((m) => m.id === target.configId);
    if (!config || !target.modelId) return false;
    return catalogOf(config).includes(target.modelId);
  };

  /**
   * 从会话记录里取出「它自己记住的模型」并校验：配置 / ACP agent 被删、模型下架
   * 一律返回 null（界面显示「选择模型」）—— **绝不回退到清单第一个**，
   * 那会让用户看到一个自己从没选过的模型。
   */
  const targetFromConversation = (conversation?: {
    backend?: AgentBackend;
    configId?: string;
    modelId?: string;
  }): { backend: AgentBackend; configId: string; modelId?: string } | null => {
    if (!conversation?.backend || !conversation.configId) return null;
    const target = {
      backend: conversation.backend,
      configId: conversation.configId,
      ...(conversation.modelId ? { modelId: conversation.modelId } : {}),
    };
    return isTargetAlive(target) ? target : null;
  };

  /**
   * 新会话（空白页）的预选目标：只认「上次发送时用的模型」（localStorage，
   * 见 `lib/last-target.ts`）。没存过 / 校验不过就**什么都不选**，界面显示「选择模型」。
   *
   * **刻意排除 ACP**：ACP 的档位（模式 / 思考档）要起一次外部进程才问得到
   * （见 `probeDraftAcp`），而打开「开始新对话」页是高频动作 —— 预选 ACP 等于每次
   * 开新页都白起一个进程。用户真要 ACP 就在模型下拉里显式选，那时才探。
   * 上次用的是 ACP 会话时，空白页就什么都不预选。
   */
  const preferredTarget = (): {
    backend: AgentBackend;
    configId: string;
    modelId?: string;
  } | null => {
    const last = loadLastTarget();
    if (!last || last.backend === "acp") return null;
    return isTargetAlive(last) ? last : null;
  };

  /**
   * ACP 档位探针的进程内缓存：agentId → 探到的能力（或上次失败的原因）。
   *
   * ## 为什么需要
   *
   * 档位（模式 / 思考档）只有起一次 agent 进程问 `session/new` 才拿得到，一次几秒。
   * 原来只认 `draftAcp` 这一个槽位、且只判「同一个 agent 才复用」，所以**在几个外部
   * Agent 之间来回切每次都要重新转圈几秒**（用户报的就是这个：换一个 provider 就要
   * 重新加载模式数据）。缓存按 agentId 分开存，切回去是内存命中，pill 立刻就有数据。
   *
   * ## 边界
   *
   * - **成功的条目永久有效**（本次会话内）：agent 的档位清单来自它自己的命令行参数 /
   *   配置文件，改完本来就得重启它；真要重问有 `reloadModels` 那条路。
   * - **失败的条目有 TTL**：agent 起不来常常是暂时性的（命令刚装上、端口刚腾出来），
   *   永久记住失败会让用户被迫重开整个页面。
   * - **正在飞的条目复用同一个 Promise**：连点两次下拉不会起两个进程。
   * - 不落盘：档位跟进程 / 环境走，跨启动未必还成立。
   */
  const draftAcpCache = new Map<
    string,
    | { ok: true; value: AcpProbeResult }
    | { ok: false; reason: string; at: number }
    | Promise<void>
  >();
  /** 失败条目多久后允许自动重试（也是用户「再点一次」能触发重探的时间） */
  const DRAFT_ACP_FAIL_TTL_MS = 60_000;

  /**
   * 探一次 ACP agent 的档位（模式 / 思考档）—— 新任务页在**建会话之前**就要把 pill 画出来。
   *
   * 幂等且**跨 agent 缓存**（见 `draftAcpCache`）：探过的 agent 再切回来立刻出数据，
   * 不重新起进程；正在探的复用同一个请求。失败只写 `error`，界面退化成「默认档」，
   * 不挡发送；失败的条目过了 TTL 才会重试。
   */
  const probeDraftAcp = async (agentId: string): Promise<void> => {
    const current = get().draftAcp;
    const same = current?.agentId === agentId;
    /** 把探到的能力填进草稿槽（只在槽里还是这个 agent 时写，避免覆盖刚切走的那个） */
    const fill = (probe: AcpProbeResult): void => {
      set((state) =>
        state.draftAcp?.agentId === agentId
          ? {
              draftAcp: {
                ...state.draftAcp,
                loading: false,
                error: null,
                modes: probe.modes,
                thoughtLevel: probe.thoughtLevel,
              },
            }
          : state,
      );
    };

    const hit = draftAcpCache.get(agentId);
    if (hit && !(hit instanceof Promise)) {
      if (hit.ok) {
        // 命中：先把 pill 点亮，再让槽位对上这个 agent（换 agent 时清掉别的 agent 的选择）
        if (!same) {
          set({
            draftAcp: {
              agentId,
              loading: false,
              error: null,
              modes: hit.value.modes,
              thoughtLevel: hit.value.thoughtLevel,
              mode: null,
              thought: null,
            },
          });
        } else if (current.loading || current.error) {
          fill(hit.value);
        }
        return;
      }
      // 失败缓存还在 TTL 内：不重新起进程，直接把上次的原因摆出来
      if (Date.now() - hit.at < DRAFT_ACP_FAIL_TTL_MS) {
        if (!same) {
          set({
            draftAcp: {
              agentId,
              loading: false,
              error: hit.reason,
              modes: null,
              thoughtLevel: null,
              mode: null,
              thought: null,
            },
          });
        } else if (current.loading || !current.error) {
          set((state) =>
            state.draftAcp?.agentId === agentId
              ? {
                  draftAcp: {
                    ...state.draftAcp,
                    loading: false,
                    error: hit.reason,
                  },
                }
              : state,
          );
        }
        return;
      }
      draftAcpCache.delete(agentId);
    }
    // 已经在飞 / 槽里已经是这个 agent 的成功结果：不必重探
    if (hit instanceof Promise) return;
    if (same && !current.loading && !current.error) return;

    set({
      draftAcp: {
        agentId,
        loading: true,
        error: null,
        modes: same ? current.modes : null,
        thoughtLevel: same ? current.thoughtLevel : null,
        mode: same ? current.mode : null,
        thought: same ? current.thought : null,
      },
    });
    const api = get().getApi();
    if (!api) {
      draftAcpCache.set(agentId, {
        ok: false,
        reason: "未连接服务端",
        at: Date.now(),
      });
      set((state) =>
        state.draftAcp?.agentId === agentId
          ? {
              draftAcp: {
                ...state.draftAcp,
                loading: false,
                error: "未连接服务端",
              },
            }
          : state,
      );
      return;
    }
    /**
     * 把「这次探测」登记进缓存：成功存值、失败存原因 + 时间。同时在飞的 Promise 也占住
     * 槽位 —— 连点两次下拉时第二次直接返回，不重复起进程。
     */
    const run = (async (): Promise<void> => {
      try {
        const res = await api.probeAcpCapabilities(agentId);
        draftAcpCache.set(agentId, { ok: true, value: res });
        fill(res);
      } catch (err) {
        const reason = errorMessage(err);
        draftAcpCache.set(agentId, { ok: false, reason, at: Date.now() });
        set((state) =>
          state.draftAcp?.agentId === agentId
            ? {
                draftAcp: {
                  ...state.draftAcp,
                  loading: false,
                  error: reason,
                },
              }
            : state,
        );
      }
    })();
    draftAcpCache.set(agentId, run);
    await run;
  };

  /** 标记某个会话「在跑 / 跑完」：侧栏转圈的唯一真源 */
  const markRunning = (conversationId: string, running: boolean): void => {
    set((state) => {
      if (running === !!state.runningConversations[conversationId])
        return state;
      const next = { ...state.runningConversations };
      if (running) next[conversationId] = true;
      else delete next[conversationId];
      return { runningConversations: next };
    });
  };

  /**
   * 把模型选择持久化到会话（fire-and-forget：失败不打扰，刷新时以服务端为准）。
   * 同时同步本地列表项 —— 会话摘要里带着 backend / configId / modelId，打开会话时要用来恢复。
   */
  const persistTarget = (
    conversationId: string,
    target: {
      backend: AgentBackend;
      configId?: string;
      modelId?: string;
    } | null,
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api
      .setConversationTarget(
        conversationId,
        target
          ? {
              backend: target.backend,
              configId: target.configId ?? null,
              modelId: target.modelId ?? null,
            }
          : { backend: null, configId: null, modelId: null },
      )
      .then(() => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  backend: target?.backend,
                  configId: target?.configId,
                  modelId: target?.modelId,
                }
              : c,
          ),
        }));
      })
      .catch(() => undefined);
  };

  /**
   * 把「这个会话允许用哪些 MCP」持久化（fire-and-forget，与 persistTarget 同一套约定：
   * 失败不打扰，刷新时以服务端为准）。同时同步本地列表项 —— 会话摘要里带着 mcpServerIds，
   * 打开会话时要用来恢复。
   */
  const persistMcp = (conversationId: string, ids: string[]): void => {
    const api = get().getApi();
    if (!api) return;
    void api
      .setConversationTarget(conversationId, { mcpServerIds: ids })
      .then(() => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, mcpServerIds: ids } : c,
          ),
        }));
      })
      .catch(() => undefined);
  };

  /**
   * 把「这个会话的浏览器偏好」持久化（fire-and-forget，与 persistMcp 同一套约定：
   * 失败不打扰，刷新时以服务端为准）。同时同步本地列表项 —— 会话摘要里带着
   * `browserSettings`，切换会话 / 刷新后要用来恢复。
   *
   * 始终写**完整对象**（服务端 target 契约是整体语义）。
   */
  const persistBrowserSettings = (
    conversationId: string,
    settings: BrowserSettings,
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api
      .setConversationTarget(conversationId, { browserSettings: settings })
      .then(() => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, browserSettings: settings } : c,
          ),
        }));
      })
      .catch(() => undefined);
  };

  /** 拉某个会话的完整消息（列表接口刻意不带消息体）。结果写进**该会话自己的 slice** */
  const loadMessages = async (
    conversationId: string,
    opts?: {
      loadError?: boolean;
      /**
       * 「打开会话的首次装载」才传：消息到位与**复位落底**（`scrollResetSeq`）必须在
       * **同一次 writeSlice** 里落下去。
       *
       * 拆成两次（先写 messages、后 bump seq）会漏出一个中间帧：那一帧消息已经渲染、
       * resetKey 却没变，滚动容器不做同步落底，内容高度暴增就交给库的 ResizeObserver
       * 用 spring 接管 —— 观感是「切进长会话时从顶部平滑滚到底部」。而且这两次写入
       * 是否落在同一个 React 批里取决于调用链的 await 时序（mastra 与 acp 两条路径不同），
       * 于是出现了「有的会话滚、有的不滚」。
       *
       * 静默刷新 / 每轮收尾的权威回拉刻意**不传** —— 那几种情况不能把正在翻历史的
       * 用户拽到底部（见 `scrollResetSeq` 的注释）。
       */
      resetScroll?: boolean;
    },
  ): Promise<AgentConversation | null> => {
    const api = get().getApi();
    if (!api) return null;
    const gen = readSlice(conversationId).loadGen;
    get().setBusy(true);
    try {
      const conversation: AgentConversation =
        await api.getConversation(conversationId);
      // 唯一的过期条件是代次：期间这个会话已经开出了新一轮（runRound / attachRun 会
      // +1），本地正在流式攒的消息不能被服务端快照盖掉
      if (gen === readSlice(conversationId).loadGen) {
        /**
         * 权威历史里已经出现的插话，从「插入中 / 未发出」列表里划掉。
         *
         * 收尾兜底落盘时**复用插话自己的 id**（`drainSteerInbox` 传 `userMessageId`），
         * 所以「id 出现在历史里」= 它已经被服务端收下（作为普通消息），本地不该再留一份
         * —— 否则下一轮开跑时它会被转进待发送队列，等于**同一句话发两遍**。
         * 正常情况客户端早就按 `user-injected` 出列了，这里兜的是「断线恰好错过那批事件」。
         */
        const known = new Set(conversation.messages.map((m) => m.id));
        writeSlice(conversationId, (s) => ({
          ...s,
          messages: conversation.messages,
          ...(s.pendingSteers.some((m) => known.has(m.id))
            ? { pendingSteers: s.pendingSteers.filter((m) => !known.has(m.id)) }
            : {}),
          error: null,
          scrollResetSeq: opts?.resetScroll
            ? s.scrollResetSeq + 1
            : s.scrollResetSeq,
        }));
      }
      // 把服务端那份（含它记住的模型）回给调用方：打开会话时用它恢复，比列表快照新
      return conversation;
    } catch (err) {
      // 打开会话这条装载链路：失败归到消息列表的错误态（带重试），不污染底部通用错误条
      if (opts?.loadError) {
        writeSlice(conversationId, (s) => ({ ...s, error: errorMessage(err) }));
      } else {
        get().setError(errorMessage(err));
      }
      return null;
    } finally {
      get().setBusy(false);
      writeSlice(conversationId, (s) => ({ ...s, loading: false }));
    }
  };

  /**
   * 断线轮次的**对账**：这一轮在客户端看是失败了（`runRound` 渲染了「网络错误」），
   * 但服务端多半在断线期间把它跑完并落盘了 —— run 的生命周期不挂在客户端连接上。
   * 拉一次服务端权威历史：确实多出了这一轮的助手回复就用它盖掉本地那条错误。
   *
   * 息屏 / 休眠醒来时网络往往**刚**恢复，一次拉不到很正常，所以重试几次再放弃。
   *
   * 只在「服务端历史比这一轮开跑前更长、且末位是助手消息」时才采纳 —— 否则
   * （这一轮压根没开跑 / 落盘失败）保留本地渲染出来的错误，别拿一份旧历史把它擦成
   * 「什么都没发生过」。acp 会话没有权威历史可对（服务端历史恒为空），直接放弃。
   */
  const reconcileDroppedRound = async (
    conversationId: string,
  ): Promise<boolean> => {
    const api = get().getApi();
    if (!api) return false;
    const dropped = readSlice(conversationId).droppedRound;
    if (!dropped) return false;
    const convBackend = get().conversations.find(
      (c) => c.id === conversationId,
    )?.backend;
    if (convBackend === "acp") return false;
    // 采纳的判据要在同一次快照里成立：拿住代次，中途用户又开了一轮（代次 +1）就放弃
    const gen = readSlice(conversationId).loadGen;
    if (reconciling.has(conversationId)) return false;
    reconciling.add(conversationId);
    try {
      for (let i = 0; i < 4; i += 1) {
        try {
          const conversation: AgentConversation =
            await api.getConversation(conversationId);
          const live = readSlice(conversationId);
          const last = conversation.messages[conversation.messages.length - 1];
          if (
            gen === live.loadGen &&
            !live.streaming &&
            last?.role === "assistant" &&
            conversation.messages.length > dropped.baseCount
          ) {
            writeSlice(conversationId, (s) => ({
              ...s,
              messages: conversation.messages,
              droppedRound: null,
              error: null,
            }));
            return true;
          }
          return false;
        } catch {
          if (i < 3) await sleep(1000 * (i + 1));
        }
      }
      return false;
    } finally {
      reconciling.delete(conversationId);
    }
  };

  /**
   * 一帧 SSE → 界面状态。`conversationId` 是这一轮所属的会话（后台轮也写自己的
   * slice），`assistantId` 是这一轮要往里追加 part 的助手消息 id（`runRound` /
   * `attachRun` 创建的那条本地占位助手消息）。
   */
  const handleFrame = (
    conversationId: string,
    assistantId: string,
    frame: ChatStreamFrame,
  ): void => {
    if (frame.type === "start") {
      // 回放 / 服务端确认的 requestId 落回当前轮（stop 用它调 /api/chat/abort）
      writeSlice(conversationId, (s) => ({
        ...s,
        request: s.request ? { ...s.request, id: frame.requestId } : s.request,
      }));
      return;
    }
    // confirm 模式下要执行破坏性操作：服务端在此**停住等答复**，
    // 我们把它渲染成一张卡，用户点一下再 POST 回去
    if (frame.type === "confirm" && frame.confirm) {
      const confirm = frame.confirm;
      writeSlice(conversationId, (s) => ({
        ...s,
        pendingConfirms: s.pendingConfirms.some((c) => c.id === confirm.id)
          ? s.pendingConfirms
          : [...s.pendingConfirms, confirm],
      }));
      return;
    }
    if (frame.type === "confirm-resolved" && frame.confirmId) {
      // 别的标签页答复 / 整轮中止：把本地这张卡撤掉
      writeSlice(conversationId, (s) => ({
        ...s,
        pendingConfirms: s.pendingConfirms.filter(
          (c) => c.id !== frame.confirmId,
        ),
      }));
      return;
    }
    // ask_followup_question：把提问按 toolCallId 存起来，供工具调用卡片渲染；跳过 =
    // 「无问题」用于服务端把提问插到对话流正确位置，但不是待回答态，忽略即可
    if (frame.type === "ask-followup" && frame.followup) {
      const f = frame.followup;
      if (f.toolCallId) {
        writeSlice(conversationId, (s) => ({
          ...s,
          followupRequests: { ...s.followupRequests, [f.toolCallId]: f },
        }));
      }
      return;
    }
    if (frame.type === "ask-followup-resolved" && frame.followupId) {
      // 慢发布：把这条提问对应的栏位撤掉（无 toolCallId 时就按 id 清）
      writeSlice(conversationId, (s) => {
        const hit = Object.entries(s.followupRequests).find(
          ([, v]) => v.id === frame.followupId,
        );
        if (!hit) return s;
        const next = { ...s.followupRequests };
        delete next[hit[0]];
        return { ...s, followupRequests: next };
      });
      return;
    }
    if (frame.type === "replay-end") {
      /**
       * 这条连接的回放放完了：把「正在回放现场」撤掉，滚动跟随恢复成流式的平滑动画。
       *
       * 只写 `replaying`，**不碰 messages，也不动 `reconnectNotice`** ——「接上了」的
       * 提示仍在 `attachRun` 的帧回调里收到第一个帧时就撤（回放整批几毫秒就到，两个
       * 时机的可见差异可以忽略），收场统一由那一轮循环的收尾负责。
       *
       * `runRound` 那条初始 POST 也会收到这条帧（服务端对任何连接都先回放再直播），
       * 那时 `replaying` 本来就是 false，这里按「没在回放就不写」跳过，避免白白多一次
       * store 写入。
       */
      if (readSlice(conversationId).replaying) {
        writeSlice(conversationId, (s) => ({ ...s, replaying: false }));
      }
      return;
    }
    if (frame.type === "end") {
      // 一轮真的结束了（收尾统一在 runRound / attachRun 的收场逻辑里做）
      return;
    }
    if (frame.type !== "event" || !frame.event) return;
    const event = frame.event;
    // 项目管理工具的 UI 动作解释器(见 lib/tool-actions.ts):普通会话里说
    // 「打开 xx」「建个项目」也能驱动界面跳转 / 高亮;浏览器工具则据此弹出画面面板
    // (带上 conversationId,让收方只在「正看的这个会话」里动作)
    for (const action of uiActionsFromEvent(event, conversationId))
      dispatchProjectUiAction(action);
    // 上下文压缩是「通知」不是内容增量：不往消息列表里塞东西，
    // 只是告诉用户这一轮上下文被压过了（展示走 contextNotice，见 ChatPanel）。
    if (event.type === "context-compressed") {
      get().setContextNotice({
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        at: Date.now(),
        summarizedTurns: event.summarizedTurns,
        keptTurns: event.keptTurns,
      });
      return;
    }
    if (event.type === "retry") {
      // 重试 = 从头再跑这一轮：清掉这一次尝试已渲染的部分输出，并显示单条「第 N 次重试」。
      // 每次重试直接覆盖上一条（`retryNotice` 只有一份，屏幕上永远只留最新一次）。
      writeSlice(conversationId, (s) => ({
        ...s,
        retryNotice: { attempt: event.attempt, maxRetries: event.maxRetries },
        messages: s.messages.map((m) =>
          m.id === assistantId ? { ...m, parts: [] } : m,
        ),
      }));
      return;
    }
    // -----------------------------------------------------------------------
    // 多智能体协作：旁路事件，只更新 collab 现场，不碰主消息
    // -----------------------------------------------------------------------
    if (
      event.type === "collab-task" ||
      event.type === "collab-message" ||
      event.type === "collab-agent" ||
      event.type === "collab-delta" ||
      event.type === "collab-tool"
    ) {
      writeSlice(conversationId, (s) => {
        const base = s.collab ?? {
          state: {
            version: 1 as const,
            tasks: [],
            messages: [],
            statuses: {},
            updatedAt: Date.now(),
          },
          liveText: {},
        };
        const collab = applyCollabEvent(base, event);
        return { ...s, collab };
      });
      return;
    }
    if (event.type === "context-usage") {
      // 上下文占用快照（`used` / `size`）。两条来源都走这里、同一形状：
      // - **ACP agent** 上报（session/update 的 usage_update）——ACP 拿不到 finish.usage，
      //   圆环的数据只能走它；跨刷新保留的那份由**服务端**写进会话配置（见 chat-turn.ts
      //   的 setAcpContextUsage），客户端不重复这一步。
      // - **内置 agent（mastra）** 在每个工具步骤边界估算后推来 —— 圆环因此在一轮之内
      //   也持续更新，而不是只在 finish 时跳一下。
      // 都挂到**本轮 live 助手消息**上（`contextUsage`），圆环优先读它。
      // ⚠️ 悬垂时（没有 live 助手消息，如 attach 时该段已结束）静默跳过即可，
      //    不影响 finish 时那份权威的 `usage.contextTokens`。
      writeSlice(conversationId, (s) => {
        let liveIndex = -1;
        for (let i = s.messages.length - 1; i >= 0; i -= 1) {
          if (isSteerAssistant(s.messages[i], assistantId)) {
            liveIndex = i;
            break;
          }
        }
        if (liveIndex < 0) return s;
        return {
          ...s,
          messages: s.messages.map((message, i) =>
            i === liveIndex
              ? {
                  ...message,
                  contextUsage: { used: event.used, size: event.size },
                }
              : message,
          ),
        };
      });
      return;
    }
    if (event.type === "user-injected") {
      // 运行中插话被 agent 消费：把 live 助手消息「封口」，把这条 user 消息插到它
      // 后面，再开一条后继助手消息承接后续增量（折叠目标按「最后一条带该前缀的助手
      // 消息」解析 —— 见下方内容增量的落点）。
      //
      // ⚠️ 后继 id 走 contracts 的 `assistantSliceId()`，**服务端落盘用的是同一个推导**
      // （chat-turn 的 persistAssistant）—— 收尾拉权威历史覆盖本地现场时 id 不变，
      // 插话之后的正文才不会整棵重挂载。键是**这条插话消息的 id**（两端共享：服务端
      // POST /api/chat/steer 里生成，这里从事件里拿到），所以不依赖「前面切出了几段」。
      writeSlice(conversationId, (s) => {
        const injected = event.message;
        // 断线重连回放去重（帧日志里有这条 user-injected 时会重放）：消息已在就不再插
        if (s.messages.some((m) => m.id === injected.id))
          return {
            ...s,
            pendingSteers: s.pendingSteers.filter((m) => m.id !== injected.id),
          };
        // 消费即转正：从「插入中」列表出列（发送方那一端维护着它）
        if (s.pendingSteers.some((m) => m.id === injected.id)) {
          s = {
            ...s,
            pendingSteers: s.pendingSteers.filter((m) => m.id !== injected.id),
          };
        }
        let liveIndex = -1;
        for (let i = s.messages.length - 1; i >= 0; i -= 1) {
          const m = s.messages[i];
          if (isSteerAssistant(m, assistantId)) {
            liveIndex = i;
            break;
          }
        }
        if (liveIndex < 0) return s;
        const next = [...s.messages];
        next.splice(liveIndex + 1, 0, injected, {
          id: assistantSliceId(assistantId, injected.id),
          role: "assistant",
          parts: [],
          createdAt: Date.now(),
        });
        return { ...s, messages: next };
      });
      return;
    }
    writeSlice(conversationId, (s) => {
      // 折叠目标 = live 助手消息（原占位，或插话拆分出的最后一个 `-s` 后继）——
      // 插话之后到达的增量必须写进后继那条，否则正文会跑到插话上面去
      let liveIndex = -1;
      for (let i = s.messages.length - 1; i >= 0; i -= 1) {
        if (isSteerAssistant(s.messages[i], assistantId)) {
          liveIndex = i;
          break;
        }
      }
      if (liveIndex < 0) return s;
      return {
        ...s,
        // 走到这里的都是「内容增量 / 错误 / 结束」事件：说明重试后的新尝试已经开始产出内容
        // （或这一轮已结束）—— 把重试提示撤掉，只在重试等待的那一小段可见。
        retryNotice: null,
        messages: s.messages.map((message, i) =>
          i === liveIndex
            ? {
                ...message,
                parts: applyEvent(message.parts, event),
                // finish 带来的一轮用量统计：立刻展示（跑完还会拉一次服务端权威历史，把它落定）。
                // 服务端把 usage 挂在切片后的最后一段上，两边一致
                ...(event.type === "finish" && event.usage
                  ? { usage: event.usage }
                  : {}),
              }
            : message,
        ),
      };
    });
  };

  /**
   * 这个会话有没有在跑的服务端 run（**查不到一律算没有**：网络不通 / 401 / 5xx）。
   *
   * 多试几次再放弃（每次间隔 500ms）：调用点都在「连接刚断」的异常路径上，那时一次
   * `activeRun` 很可能只是同一个网络抖动，直接判「没在跑」会把还活着的 run 误判成结束。
   */
  const peekActiveRun = async (
    conversationId: string,
    tries = 3,
  ): Promise<ChatRunSummary | null> => {
    const api = get().getApi();
    if (!api) return null;
    for (let i = 0; i < tries; i += 1) {
      try {
        const { run } = await api.activeRun(conversationId);
        return run;
      } catch {
        if (i < tries - 1) await sleep(500 * (i + 1));
      }
    }
    return null;
  };

  /**
   * 这一轮收场：复位本地现场、拉服务端权威历史、把队列的下一条顶上来接着跑。
   * `runRound` 与 `attachRun`（含断线重接循环）共用同一套收场语义。
   */
  const settleRound = (conversationId: string, signal: AbortSignal): void => {
    writeSlice(conversationId, (s) => ({
      ...s,
      streaming: false,
      // 收场时一定不在回放里了（回放只在 attachRun 的循环内），兜底一并撤掉
      replaying: false,
      request: null,
      pendingConfirms: [],
      followupRequests: {},
      // ⚠️ **这里刻意不清 `pendingSteers`**：收件箱随 run 结束消失，但没被消费的插话不能
      // 跟着一起丢。绝大多数收场（被边界消费 / 收尾兜底）服务端都会广播 `user-injected`，
      // 客户端早已按事件出列；真正会残留的只有两种：**用户点了停止**（服务端 abort 时清箱
      // 丢弃，见 chat-turn 的 abort 监听）与断线丢了事件。这两种情况把条目留在列表里，
      // 用户才能用 ➤ 立刻发送 / ✕ 移除（见 `sendSteer`）；起下一轮时它们会自动转入待发送队列。
      retryNotice: null,
      reconnectNotice: null,
      // 这一轮有着落（收到 end / 服务端已落盘），没有待对账的断线轮次了
      droppedRound: null,
    }));
    markRunning(conversationId, false);
    // 服务端这时已经把整轮落盘了：拉权威历史覆盖本地回放出来的那份。
    // acp 例外：服务端历史恒为空，拉了会把刚回放完的现场擦掉 —— 本地这份就是全部
    const convBackend = get().conversations.find(
      (c) => c.id === conversationId,
    )?.backend;
    if (convBackend !== "acp") void loadMessages(conversationId);
    // 自然收尾（没被中止）：把队列里的下一条顶上来接着跑；用户点了停止则保留队列
    if (!signal.aborted && get().activeConversationId === conversationId)
      pump();
  };

  /**
   * 接回一条**正在服务端跑**的对话（刷新 / 断线重连 / 换端后恢复现场）。
   *
   * 与 `runRound` 的区别：这一轮早就跑起来了，这里只订阅（回放 + 直播），**不新开一轮**。
   * 返回 true = 确实接上了一条在跑的对话（调用方据此跳过「没在跑」的后续动作）。
   *
   * @param opts.requestId / opts.assistantId 断线续接（`runRound` 的连接断了之后转交过来）：
   *   直接复用已知的 requestId 与本地占位消息，省掉一次 activeRun 查询、也绝不新建空消息。
   */
  const saveCollabSettings = async (
    settings: CollabSettings,
  ): Promise<boolean> => {
    const conversationId = get().activeConversationId;
    const api = get().getApi();
    if (!conversationId || !api) return false;
    try {
      const updated = await api.saveCollabSettings(conversationId, settings);
      set({
        conversations: get().conversations.map((c) =>
          c.id === conversationId
            ? { ...c, kind: "collab", collab: updated.collab ?? settings }
            : c,
        ),
      });
      return true;
    } catch (err) {
      get().setError(errorMessage(err));
      return false;
    }
  };

  const cancelCollabTask = async (taskId: string): Promise<boolean> => {
    const conversationId = get().activeConversationId;
    const api = get().getApi();
    if (!conversationId || !api) return false;
    try {
      const result = await api.cancelCollabTask(conversationId, taskId);
      return result.ok;
    } catch (err) {
      get().setError(errorMessage(err));
      return false;
    }
  };

  const attachRun = async (
    conversationId: string,
    opts?: { requestId?: string; assistantId?: string },
  ): Promise<boolean> => {
    const api = get().getApi();
    if (!api || !conversationId) return false;
    const resume =
      opts?.requestId && opts.assistantId
        ? { requestId: opts.requestId, assistantId: opts.assistantId }
        : null;
    // 已经有个循环在接这条会话（自动重接的退避睡眠还没醒 / 正接着）：别重复接 ——
    // 多一条空占位消息是小事，`handleFrame` 是追加式的，回放帧追加两遍会让正文重复
    if (!resume && subscribing.has(conversationId)) return true;
    subscribing.add(conversationId);
    try {
      let requestId = resume?.requestId ?? "";
      /** `GET /api/chat/active` 探到的这条 run（resume 路径不探：调用方把 id 都给全了） */
      let probed: ChatRunSummary | null = null;
      if (!requestId) {
        try {
          const { run } = await api.activeRun(conversationId);
          if (!run) return false;
          requestId = run.requestId;
          probed = run;
        } catch (err) {
          get().setError(errorMessage(err));
          return false;
        }
      }

      /**
       * 占位消息：服务端落盘的历史里还没有这条助手消息，回放的帧要往它上面追加。
       * 本地已经挂着这一轮的占位（断线续接 / 断线重连）就**复用**，别再 push 一条空的 ——
       * 否则消息列表里会并排出现两条空助手消息。
       */
      const live = readSlice(conversationId);
      const reuseId =
        live.request?.assistantId &&
        live.messages.some((m) => m.id === live.request!.assistantId)
          ? live.request.assistantId
          : null;
      /**
       * id 优先级：本轮自己传的 > 本地已在的同轮占位 > **run 上记的**（发起那一轮的客户端
       * 递上来的）> 现生成。
       *
       * 第三档是「刷新页面 / 另一个标签页接手一条已经在跑的 run」：本地没有占位（历史里还
       * 没这条消息），只能问 run —— 服务端落盘用的就是它，占位沿用同一个 id，收尾换权威
       * 历史时这回放出来的正文才不会整棵重挂载。缺省（老客户端没传）退回自生成，行为同以前。
       */
      const assistantId =
        resume?.assistantId ??
        reuseId ??
        probed?.assistantMessageId ??
        nextLocalId("a");
      /**
       * 占位与否只看「本地**真的**有没有这条助手消息」，不看「调用方传没传 resume」。
       *
       * 曾经写的是 `!reuseId && !resume?.assistantId`，隐含假设「传了 resume 就一定已经有
       * 本地占位」—— 断线续接那条路成立，但**刷新页面**不成立：ACP 会话刷新时本地消息
       * 是空的（进程内快照还会把本轮助手消息摘掉，见 transcript 路由），于是占位不建、
       * 回放的帧在 `handleFrame` 里找不到落点（`liveIndex < 0` 直接返回），整轮正文被
       * 静默丢掉 —— 表现就是「跑到一半刷新，回复不见了，再刷也还是没有」。
       * 服务端那一轮照旧跑完并写进快照，只有刷新到「已跑完」那一刻才靠 `session/load` 补回来。
       */
      const needPlaceholder = !live.messages.some((m) => m.id === assistantId);
      writeSlice(conversationId, (s) => ({
        ...s,
        messages: needPlaceholder
          ? [
              ...s.messages,
              {
                id: assistantId,
                role: "assistant",
                parts: [],
                createdAt: Date.now(),
              },
            ]
          : s.messages,
        streaming: true,
        pendingConfirms: [],
        followupRequests: {},
        retryNotice: null,
        reconnectNotice: null,
        // 作废在途的消息加载：从现在起本地这份「回放现场」是真源
        loadGen: s.loadGen + 1,
        request: s.request
          ? { ...s.request, id: requestId, assistantId }
          : { id: requestId, controller: new AbortController(), assistantId },
      }));
      const controller = readSlice(conversationId).request!.controller;
      // 接回正在跑的会话：侧栏转圈要亮起来（哪怕这不是当前打开的会话）
      markRunning(conversationId, true);

      let attempt = 0;
      for (;;) {
        /**
         * 每次（重）接入前先把占位清空：回放是从帧日志**头部**开始的，清空后回放出来的
         * parts 与断线前完全一致（服务端 `compactFrames` 只合并不丢帧，见
         * `lib/server/chat-run.ts`）。不清就会把断线前那截又追加一遍，正文重复。
         */
        writeSlice(conversationId, (s) => ({
          ...s,
          // 插话拆分出的后继助手（`assistantSliceId()` 的形状，见 contracts）也是这一轮的
          // 占位：回放会从帧日志头部重建整轮（含 user-injected 的拆分），不清会把
          // 后继段里已有的 parts 又追加一遍
          messages: s.messages.map((m) =>
            isSteerAssistant(m, assistantId) ? { ...m, parts: [] } : m,
          ),
          /**
           * 从这一刻到 `replay-end` 帧之间就是「回放窗口」：内容先塌（上面的清空）
           * 后长（逐帧重建）。`MessageList` 据此把滚动跟随降级成瞬时贴底 —— 否则内容
           * 一长高，库的 spring 就带着视口从上面一路滚下来（用户实测反馈的「列表像在
           * 重新加载、一直从顶部往下滚」）。放在**清空的那一次写入**里，与清空同帧生效。
           */
          replaying: true,
        }));

        /**
         * 这一条连接的帧合批器（见 `lib/frame-batch.ts`）。
         *
         * ⚠️ **必须每次重连各建一个**：上一轮缓冲里的残留不能跨连接漏到下一轮 ——
         * 下一轮开头刚把这一轮的 parts 清空，漏一帧过去就是「回放重建完又被追加一遍」。
         */
        const batch = createFrameBatcher((frame) =>
          handleFrame(conversationId, assistantId, frame),
        );

        try {
          /**
           * 「真的接上了」的信号 = 收到第一个帧（回放从帧日志头部开始，第一帧一定是
           * start 帧）。这一刻就把「连接中断」提示撤掉 —— 以前只有整轮收尾
           * （`settleRound`）才清它，于是重连成功后那条提示会一直挂到本轮结束，
           * 观感就是「已经连上了，提示却不消失」，点「立即重连」也不管用。
           */
          let reconnected = false;
          await api.attachRun(
            requestId,
            (frame) => {
              if (!reconnected) {
                reconnected = true;
                writeSlice(conversationId, (s) =>
                  s.reconnectNotice ? { ...s, reconnectNotice: null } : s,
                );
              }
              batch.push(frame);
            },
            controller.signal,
          );
          // 流关了：先把缓冲里的尾巴落干净再收场，别让最后几帧等 16ms 的定时器
          batch.flush();
          // 流正常关闭 = 收到过 end 帧（服务端把已结束的 run 回放完也会直接 close）
          settleRound(conversationId, controller.signal);
          return true;
        } catch (err) {
          /*
           * 断线也要先把已收到的帧落干净：用户看到的应该是「停在这一刻」，
           * 而不是回退到几帧之前（缓冲里那些帧还没写进 store）。
           */
          batch.flush();
          // 用户点了「停止」（或睡眠期间点了）：这条流是我们自己断的，照常收场
          if (controller.signal.aborted) {
            settleRound(conversationId, controller.signal);
            return true;
          }
          const status = httpStatusOf(err);
          // 401：token 失效（api 层已顺手触发登出收场）。别重接 —— 越重越乱，
          // 也不写本地现场，`disconnect` 会把 slice 全清掉
          if (status === 401) {
            get().setError(errorMessage(err));
            return true;
          }
          /**
           * 404：run 已经结束并被清理（断线期间跑完了，或 retention 过了）。
           * 这一轮就是结束了 —— 照常收场拉权威历史。以前这里会抛成网络错误，
           * 把 `streaming` 永久留在 true、侧栏一直转圈，用户只能刷新页面。
           */
          if (status === 404) {
            settleRound(conversationId, controller.signal);
            return true;
          }
          /**
           * 其余就是**连接断了**（fetch reject / 流读到一半断），而服务端那轮大概率
           * 还在跑：run 的生命周期不挂在客户端连接上（POST /api/chat 一断，服务端照样
           * 把这一轮跑完并落盘，见 `app/api/chat/route.ts` 顶部）。页面切到后台
           * （标签页冻结 / 电脑休眠 / 网络切换）时 SSE 断得最勤，而这正是任务还在跑的时候。
           *
           * 确认它还活着就退避重接；确认不了（服务端也没这条 run 了）才收场。
           * 以前这里直接把错误抛成「网络错误」，用户只能刷新整页才能接回现场。
           */
          const alive = await peekActiveRun(conversationId);
          if (!alive || alive.requestId !== requestId) {
            settleRound(conversationId, controller.signal);
            return true;
          }
          attempt += 1;
          /**
           * 把**真实原因**打出来。
           *
           * 这条提示以前只报「断了」，排查时看不到到底为什么断（服务端断开 / 客户端帧处理
           * 抛错 / 桥的异常全都长得一样）。`readSseFrames` 已经把「帧处理异常」挡在连接之外
           * （见那里的注释），所以正常情况这里只该出现真正的传输错误；一旦又出现，日志里
           * 这一行就是线索。
           */
          console.warn(
            `[chat] 会话 ${conversationId} 的流断了（第 ${attempt} 次重连，status=${status ?? "无"}）：`,
            err,
          );
          writeSlice(conversationId, (s) => ({
            ...s,
            reconnectNotice: { attempt },
          }));
          await sleepReconnect(conversationId, attempt);
        }
      }
    } finally {
      subscribing.delete(conversationId);
    }
  };

  /**
   * 等会话清单第一次成功落地（`conversationsLoaded` 置位；workspaces 与它同一次
   * refresh() 写入，到位即同时到位）。
   *
   * 刷新后的深链走「乐观打开」：清单还没到，深链 effect 就先 openConversation 了。
   * 此时 loadConversation 里的 convMeta / workspaces 查找全是空 —— ACP 的 transcript
   * 回放会被静默跳过（界面就是一个空会话，观感即「消息全没了，成了新会话」），
   * chatTarget 也恢复不了。清单到位后这些查找才有意义。
   *
   * 超时兜底：服务端一直不可达时直接放行，流程按「清单拉不到」的原样收场
   * （loadMessages 已经写过错误态，界面上有重试按钮）。
   */
  const waitConversationsLoaded = (): Promise<void> => {
    if (get().conversationsLoaded) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(finish, 15_000);
      const unsubscribe = api.subscribe((state) => {
        if (state.conversationsLoaded) finish();
      });
    });
  };

  /**
   * 打开会话后的历史装载：mastra 拉服务端落盘存档 + acp 走 agent 侧 `session/load` 回放。
   * 从 `openConversation` 抽出，便于「加载失败 → 重试」复用同一段逻辑（重试不能再走
   * openConversation 的 id 去重早退）。失败统一写 slice 的 error，由消息列表展示错误 + 重试。
   */
  const loadConversation = async (conversationId: string): Promise<void> => {
    // 用户在装载期间自己改过选择时，收尾的恢复块不能再拿服务端那份盖回去（比对引用即可）
    const targetBefore = get().chatTarget;
    // 拉服务端落盘的权威历史（mastra）；acp 服务端历史恒为空，这里只是走个过场
    // resetScroll：首次装载，消息写入与复位落底同帧（见 loadMessages 的 opts 注释）
    const fetched = await loadMessages(conversationId, {
      loadError: true,
      resetScroll: true,
    });
    // 乐观打开（刷新后的深链）时清单多半还没到：先等它落地，再查 convMeta。
    // loadMessages 收尾已把「装载中」撤掉，等清单 + 回放的这段窗口里重新亮起，
    // 免得界面是一片无提示的空白；清单已到的常规路径（点侧栏 / 重试）瞬间放行。
    if (!get().conversationsLoaded) {
      writeSlice(conversationId, (s) => ({ ...s, loading: true }));
      await waitConversationsLoaded();
    }
    // 协作会话：任务 / 消息状态在独立的 collab.json，随打开一起拉（失败不挡主历史）
    if (
      (fetched ?? get().conversations.find((c) => c.id === conversationId))
        ?.kind === "collab"
    ) {
      const api = get().getApi();
      if (api) {
        try {
          const { collab } = await api.getCollabState(conversationId);
          if (get().activeConversationId === conversationId) {
            writeSlice(conversationId, (s) => ({
              ...s,
              collab: { state: collab, liveText: {} },
            }));
          }
        } catch (err) {
          console.warn("[collab] 运行态装载失败：", err);
        }
      }
    }
    // acp 会话：消息在 agent 侧，用 session/load 回放重建视图（不落盘，刷新后重放）
    const convMeta = get().conversations.find((c) => c.id === conversationId);
    let resumedActive = false;
    if (
      convMeta?.backend === "acp" &&
      get().activeConversationId === conversationId
    ) {
      /**
       * ⚠️ 先看这一轮是不是还在跑。
       *
       * 跑动中刷新**不能**走 session/load：服务端回放入口的第一件事是 teardown 同 key
       * 的 ACP 进程，正在等 nextUpdate 的 ActiveSession 会以 `ACP connection closed`
       * 失败（用户看到的就是这条报错）。正确恢复方式是「进程内视图快照 + attach 帧日志」：
       * 快照给出已完成的轮次与本轮用户消息，attach 从帧日志头部回放当前助手消息并接回直播。
       */
      const activeRun = await peekActiveRun(conversationId);
      if (activeRun) {
        writeSlice(conversationId, (s) => ({ ...s, loading: true }));
        try {
          const api = get().getApi();
          // 有 active run 时服务端只读内存快照，不会碰 agent 进程；sessionId / cwd
          // 这时可以不齐（会话刚新建、还没绑定 session）—— 服务端按 conversationId 判断。
          if (api && convMeta.configId) {
            const cwd = get().workspaces.find(
              (w) => w.id === convMeta.workspaceId,
            )?.path;
            try {
              const { messages: snapshot } = await api.getAcpTranscript(
                convMeta.configId,
                conversationId,
                convMeta.acpSessionId ?? "",
                cwd ?? "",
              );
              if (
                get().activeConversationId === conversationId &&
                readSlice(conversationId).messages.length === 0
              ) {
                writeSlice(conversationId, (s) => ({
                  ...s,
                  messages: snapshot,
                  scrollResetSeq: s.scrollResetSeq + 1,
                }));
              }
            } catch {
              // 快照拉不到不该挡住 attach：帧日志仍然能恢复当前这一轮
            }
          }
          resumedActive = await attachRun(
            conversationId,
            activeRun.assistantMessageId
              ? {
                  requestId: activeRun.requestId,
                  assistantId: activeRun.assistantMessageId,
                }
              : undefined,
          );
        } finally {
          writeSlice(conversationId, (s) => ({ ...s, loading: false }));
        }
      }
    }
    if (
      !resumedActive &&
      convMeta?.backend === "acp" &&
      convMeta.acpSessionId &&
      convMeta.configId &&
      get().activeConversationId === conversationId
    ) {
      const cwd = get().workspaces.find(
        (w) => w.id === convMeta.workspaceId,
      )?.path;
      if (cwd) {
        // loadMessages 收尾已把「装载中」撤掉，回放又要一个往返 —— 这段窗口里界面
        // 只是一片空白。重新亮起装载标记，回放结束（成功 / 失败）再撤。
        writeSlice(conversationId, (s) => ({ ...s, loading: true }));
        try {
          const api = get().getApi();
          const { messages: replayed } = await api!.getAcpTranscript(
            convMeta.configId,
            conversationId,
            convMeta.acpSessionId,
            cwd,
          );
          // 回放期间用户可能已经发出了新一轮（本地已有消息）或切走了会话：都不覆盖
          if (
            replayed.length > 0 &&
            get().activeConversationId === conversationId &&
            readSlice(conversationId).messages.length === 0
          ) {
            // 回放出来的消息与复位落底同一次写入（同 loadMessages 的 resetScroll，别拆两帧）
            writeSlice(conversationId, (s) => ({
              ...s,
              messages: replayed,
              scrollResetSeq: s.scrollResetSeq + 1,
            }));
          }
        } catch (err) {
          // 回放失败（agent 不支持 load / 会话失效 / OpenCode 服务故障）：写错误态，
          // 让消息列表展示错误 + 重试，而不是静默吞掉变成「历史丢了」
          writeSlice(conversationId, (s) => ({
            ...s,
            error: errorMessage(err),
          }));
        } finally {
          writeSlice(conversationId, (s) => ({ ...s, loading: false }));
        }
      }
    }
    /*
     * 收尾：撤掉「装载中」，并兜底再复位一次落底。
     *
     * 消息本身的写入已经各自带上了 resetScroll（mastra 走 loadMessages、acp 走回放那块），
     * 这里的 bump 只为覆盖「压根没有消息可写」的窗口 —— 比如等会话清单期间用户就切走了、
     * 或回放没跑（缺 cwd / 非当前会话）。空会话落底本来就无副作用。
     */
    writeSlice(conversationId, (s) => ({
      ...s,
      scrollResetSeq: s.scrollResetSeq + 1,
      loading: false,
    }));
    /**
     * 恢复这个会话记住的模型。以 loadMessages 刚拿到的**会话详情**为准（比列表快照新，
     * 不会因为「切换模型的落盘还没回来」而回退成旧值）；拉失败时退回列表里那份。
     * 两个前提缺一不可：
     * - 还是当前打开的会话（等清单的窗口里用户可能已经切走）；
     * - 装载期间用户没自己改过选择（chatTarget 引用变了就不再覆盖）。
     * 校验不过（配置 / agent 被删、模型下架）就恢复成 null → 界面显示「选择模型」。
     */
    if (
      get().activeConversationId === conversationId &&
      get().chatTarget === targetBefore
    ) {
      const stored =
        fetched ?? get().conversations.find((c) => c.id === conversationId);
      set({
        chatTarget: targetFromConversation(stored ?? undefined),
        // 同理恢复这个会话选中的 MCP（没存过 = 全不选）
        mcpServerIds: stored?.mcpServerIds ?? [],
        // 浏览器偏好同理：以服务端那份为准（别的端可能改过；没存过 = null）
        browserSettings: stored?.browserSettings ?? null,
      });
    }
    // 本地没人订着这条会话、但服务端还挂着 run（刷新 / 断线重连 / 换端回来）：
    // 接回去回放现场继续看直播。接上了就到此为止 —— 收尾（拉权威历史 / 续队列）
    // 由 attachRun 的收场负责
    if (!get().runningConversations[conversationId]) {
      const attached = await attachRun(conversationId);
      if (attached) return;
    }
    // 本会话没在跑但有排队消息：依次发出（刷新后也能续上；被停掉的那轮结束后同样接着跑）
    if (!get().runningConversations[conversationId]) pump();
  };

  /**
   * 队列泵：当前会话没在跑且队列非空时，弹出第一条开新一轮（runRound 收尾时也会再调它，
   * 形成「一条接一条」的链式执行）。切换走 / 正在跑 / 队列空都不动。
   */
  const pump = (): void => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    if (get().runningConversations[conversationId]) return;
    const queue = readSlice(conversationId).queuedMessages;
    const next = queue[0];
    if (!next) return;
    // 有下一条要发：失败暂停的标记就地解除（继续执行 = 用户拍板过了）
    writeSlice(conversationId, (s) => ({ ...s, queuePausedReason: null }));
    patchQueue(conversationId, queue.slice(1));
    void get().runRound(next.text, next.files);
  };

  /**
   * 读服务端上的队列（权威）。返回 null = 拉不到（未连接 / 离线 / 报错），
   * 调用方据此继续用本地缓存 —— 队列降级成「只在本地用」，不弹错误。
   */
  const fetchQueue = async (
    conversationId: string,
  ): Promise<QueuedMessage[] | null> => {
    const api = get().getApi();
    if (!api) return null;
    try {
      const { items } = await api.getConversationQueue(conversationId);
      return items;
    } catch {
      return null;
    }
  };

  /**
   * 把队列同步到服务端（**尽力而为**：失败只留本地缓存，绝不打断界面）。
   *
   * 每次变更都整份写（PATCH 是全量覆盖语义）—— 队列很短（几条短文本）、变更都是
   * 人肉触发的（加 / 删 / 编辑 / 拖完放手），不值得为它做 debounce 或增量协议。
   * 缓存在**本函数调用之前**就落好了，所以这里失败也只是「不跨端」，队列不丢。
   */
  const syncQueueToServer = (
    conversationId: string,
    items: QueuedMessage[],
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api.setConversationQueue(conversationId, items).catch(() => {
      // 服务端不可用（未连接 / 离线 / 5xx）：缓存已落好，静默即可
    });
  };

  /**
   * 把插话的顺序同步到服务端（**尽力而为**，与 `syncQueueToServer` 同一立场）。
   *
   * 与队列的差别：插话收件箱只活在服务端的活跃 run 上（没有 localStorage 那一层），
   * 所以失败（未连接 / 409 本轮已结束）时**保留本地的乐观顺序**即可 —— 真已经结束的话，
   * 这些插话马上会被 `user-injected` 转正出列，本轮没结束的下一帧也仍以服务端为准对齐。
   * 拖拽是 hover 即改、一次拖动会调很多次，但收件箱很短（几条短文本），不值得做 debounce。
   */
  const syncSteerOrder = (
    conversationId: string,
    items: AgentChatMessage[],
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api
      .reorderSteers(
        conversationId,
        items.map((m) => m.id),
      )
      .catch(() => {});
  };

  /**
   * 改某个会话的队列：内存 slice + localStorage 缓存 + 服务端**三处一起落**。
   *
   * 顺序是先本地后服务端：本地立即可见（拖拽排序要跟手），服务端是尽力而为的
   * 补写（失败就只留本地缓存，见上面那个 helper 的说明）。
   */
  const patchQueue = (conversationId: string, next: QueuedMessage[]): void => {
    writeSlice(conversationId, (s) => ({ ...s, queuedMessages: next }));
    saveQueue(conversationId, next);
    syncQueueToServer(conversationId, next);
  };

  /**
   * 本地守卫：这一轮的**目标**（模型配置 / ACP agent）现在还能不能用。
   *
   * 不能用就**就地报错并把悬空的目标清掉**（界面上那颗 pill 因此回到「选择模型」），返回
   * `false`。**绝不回退到清单第一个** —— 那会替用户发出一个他从来没选过的模型。
   *
   * 两个调用点，对「早」的要求不同，所以抽成函数：
   * - `runRound` 在开跑前问（拦住才不会留下一条绑着死目标的空会话）；
   * - `resendMessage` 在**删历史之前**问 —— 编辑重发是先删后发，晚一步用户就白丢一段历史。
   */
  const guardTarget = (): boolean => {
    if (isTargetAlive(get().chatTarget)) return true;
    // 悬空的目标顺手清掉（本来就是 null 时不必 set）
    if (get().chatTarget) set({ chatTarget: null });
    get().setError("请先在输入框上方选择模型（原来的配置或模型可能已被删除）");
    return false;
  };

  /**
   * 真正发起一轮对话（不含「进行中则入队」的判断）：把用户消息 + 空助手消息落本地、
   * 开 SSE、收流。本轮自然收尾后，把队列里的下一条顶上来接着跑。
   *
   * 返回 `true` = 这一轮**真的开跑了**；`false` = 还没发出去就被拦下（没连上 / 没选模型 /
   * 建会话失败）。调用方（`sendQueuedMessage` / `sendSteer`）据此把已经摘掉的条目放回去 ——
   * 拦下的那几种情况本来就同时给了错误提示，再把用户写的内容吃掉就更没道理了。
   */
  const runRound = async (
    text: string,
    files?: UploadFileRef[],
    onStarted?: () => void,
  ): Promise<boolean> => {
    const api = get().getApi();
    if (!api) return false;
    const trimmed = text.trim();
    if (!trimmed && !(files && files.length > 0)) return false;

    /**
     * 发之前先确认目标还成立（见 `guardTarget`）。校验必须放在建会话之前，否则会留下
     * 一条绑着死目标的空会话。
     */
    if (!guardTarget()) return false;

    let conversationId = get().activeConversationId;
    if (!conversationId) {
      // 「开始新对话」页发送即建会话：会话类型在创建时就按当前选中的目标定死 ——
      // 选的是 ACP agent（或其模型）就是 acp 会话（agent 从此绑定、acpSessionId 后续回填），
      // 选的是 AI 模型（或默认）就是内置 agent 会话。类型落库后不能再换，模型可换。
      const { chatTarget } = get();
      /**
       * 建会话这段空窗要让输入框看得见（发送钮转圈）：ACP 要起外部 agent 进程 +
       * `session/new` 才拿得到会话，几秒钟界面毫无反应，用户会以为没点上而反复点。
       *
       * ⚠️ 用 `done` 回调收尾，**不能用 `finally` 把 `await` 包起来** —— `newConversation`
       * 建完会话还要下发 ACP 档位（又一次进程往返），而这一刻界面已经从空态页切进会话、
       * 用户消息也快落屏了，再转圈就是「转得比实际久」。
       */
      set({ creatingConversation: true });
      try {
        conversationId = await get().newConversation(
          undefined,
          undefined,
          chatTarget
            ? {
                backend: chatTarget.backend,
                ...(chatTarget.configId ? { configId: chatTarget.configId } : {}),
                ...(chatTarget.modelId ? { modelId: chatTarget.modelId } : {}),
              }
            : undefined,
          () => set({ creatingConversation: false }),
        );
      } catch (err) {
        // `newConversation` 自己兜了错，理论到不了这里；真到了也别把转圈留在屏幕上
        set({ creatingConversation: false });
        throw err;
      }
      if (!conversationId) return false;
    }

    const userMessage: AgentChatMessage = {
      id: nextLocalId("u"),
      role: "user",
      // files 在前、text 在后（与服务端落盘同一份 buildUserParts，两端形状才不会漂）
      parts: buildUserParts(trimmed, files),
      createdAt: Date.now(),
    };
    const assistantId = nextLocalId("a");
    const controller = new AbortController();
    const {
      chatTarget,
      permissionMode,
      confirmTimeoutMin,
      maxRetries,
      toolCallConcurrency,
    } = get();
    // 记下「上次使用的模型」（新会话预选用它），并把这次真正发出去的选择写回会话目录
    // （`config.json`）—— 「用某个模型发消息就更新这个配置的值」。
    if (chatTarget?.configId) {
      saveLastTarget({
        backend: chatTarget.backend,
        configId: chatTarget.configId,
        ...(chatTarget.modelId ? { modelId: chatTarget.modelId } : {}),
      });
      persistTarget(conversationId, chatTarget);
    }
    // 用户消息 + 空助手消息落进**这个会话自己的现场**；从现在起它就是真源
    // 对账基准：这一轮开跑前本地有多少条消息（断线失败后拿它判断服务端有没有存下这一轮）
    const baseCount = readSlice(conversationId).messages.length;
    /**
     * 新一轮开跑时，把上一轮**遗留的插话**转入待发送队列（见 settleRound 的说明：
     * 只有「用户点了停止」与「断线丢了事件」会留下来）。它们已经不在服务端收件箱里，
     * 继续挂在「插入中」列表只会撒谎 —— 那里写着「下个步骤边界生效」，而这一轮它们
     * 根本不会被注入。转入队列则内容不丢，且队列本来就有 ➤ 立刻发送 / 编辑 / 删除。
     */
    const straySteers = readSlice(conversationId).pendingSteers;
    writeSlice(conversationId, (s) => ({
      ...s,
      messages: [
        ...s.messages,
        userMessage,
        {
          id: assistantId,
          role: "assistant",
          parts: [],
          createdAt: Date.now(),
        },
      ],
      /**
       * 自己发的消息**必须立刻出现在底部**（用户要求）：bump 一下 scrollResetSeq，
       * 让 Conversation 在本次 commit 的 layout 阶段直接落底，顺带把跟随状态重新打开。
       */
      scrollResetSeq: s.scrollResetSeq + 1,
      streaming: true,
      // 新一轮是全新开跑（不是回放）：万一上一轮的回放窗口没收干净，这里一并复位
      replaying: false,
      // 新一轮开始时清掉上一轮残留的审批卡片（上一轮的审批已随落盘的消息给过结论）
      pendingConfirms: [],
      followupRequests: {},
      retryNotice: null,
      // 新一轮开跑：上一轮遗留的待对账断线轮次作废（这一轮的代次已经 +1，对账自然也不会采纳）
      droppedRound: null,
      // 作废在途的消息加载：从现在起本地消息就是真源（流式帧在往里追加）
      loadGen: s.loadGen + 1,
      // 上轮遗留的插话已转交队列（下面 patchQueue），这里一并从「插入中」摘掉
      ...(straySteers.length > 0 ? { pendingSteers: [] } : {}),
      request: { id: "", controller, assistantId },
    }));
    if (straySteers.length > 0) {
      const adopted: QueuedMessage[] = straySteers.map((message) => {
        const files = fileRefsOfParts(message.parts);
        return {
          id: nextLocalId("q"),
          text: textOf(message),
          createdAt: message.createdAt,
          ...(files.length > 0 ? { files } : {}),
        };
      });
      patchQueue(conversationId, [
        ...readSlice(conversationId).queuedMessages,
        ...adopted,
      ]);
    }
    /**
     * 走到这里就是**确定要发**了：乐观消息已落进本地现场，后面只剩「服务端接不接受」
     * （那属于这一轮的成败，不再是「没发出去」）。草稿区的一次性资源（附件 / 引用）
     * 就是在这里清的 —— 早于这里清等于赌，赌输了用户得把文件重传一遍（见 `send` 的
     * `onStarted` 说明）。
     */
    onStarted?.();
    get().setError(null);
    /** 这一轮是不是「没能开跑」（服务端也没起过 run / 被拒 / 连不上）—— 决定收尾要不要拉权威历史 */
    let failed = false;
    /** 连接断了但服务端那轮还在跑：已经转交 attachRun 续接，收场归它管 */
    let handedOff = false;
    // 这一轮开跑：侧栏在它的会话上转圈（之后切到别的会话也不挪窝）
    markRunning(conversationId, true);
    // 初始页选好的模型：上面建会话时已作为 target 一并落库，这里无需再 PATCH

    /**
     * 这一轮的帧合批器（见 `lib/frame-batch.ts`）：把逐 token 的 delta 攒到一个动画帧
     * 再一次性落进 store，避免「一 token 一次整树渲染」。
     */
    const batch = createFrameBatcher((frame) =>
      handleFrame(conversationId, assistantId, frame),
    );

    try {
      const requestId = await api.streamChat(
        {
          conversationId,
          text: trimmed,
          /**
           * 这一轮两条消息的 id **由客户端定、服务端沿用**（见 `ChatRequest` 的两个 id 字段）：
           * 收尾时 `loadMessages` 会用服务端权威历史覆盖本地现场，id 一致 React 才不会把
           * 刚跑完这一轮的子树整棵重挂载（观感是「消息列表跳一下 / 图片重走骨架」）。
           */
          userMessageId: userMessage.id,
          assistantMessageId: assistantId,
          // 附件：先经 /api/uploads 上传拿到的引用，服务端转成 file parts 落盘
          ...(files && files.length > 0 ? { files } : {}),
          permissionMode,
          // 审批超时（毫秒）：0 = 不超时；服务端按这个值等用户答复
          confirmTimeoutMs:
            confirmTimeoutMin > 0 ? Math.round(confirmTimeoutMin * 60000) : 0,
          // 模型请求自动重试次数（0 = 不限制）：服务端据此在可重试的请求错误（网络 / 空响应）上重试
          maxRetries,
          // 同一批 tool-call 的并发上限：模型一次返回一大批工具调用时，服务端按这个数排队
          toolCallConcurrency,
          // 选了 ACP agent 就走外部进程（configId 此时是 ACP agent id）
          ...(chatTarget
            ? {
                backend: chatTarget.backend,
                ...(chatTarget.configId
                  ? { configId: chatTarget.configId }
                  : {}),
                // 一份配置带多个模型时，告诉服务端这一轮用哪个
                ...(chatTarget.modelId ? { modelId: chatTarget.modelId } : {}),
              }
            : {}),
        },
        (frame: ChatStreamFrame) => batch.push(frame),
        controller.signal,
      );
      // 流关了：先把缓冲里的尾巴落干净，再写 requestId（收场紧接着会读消息列表）
      batch.flush();
      writeSlice(conversationId, (s) => ({
        ...s,
        request: s.request ? { ...s.request, id: requestId } : s.request,
      }));
    } catch (err) {
      // 断线也要先把已收到的帧落干净：停在「最后一帧」而不是回退几帧
      batch.flush();
      /**
       * ⚠️ 这一轮**没能开跑**时，错误也走消息流，**不再弹输入框上方那条横幅**（用户要求）。
       * 刻意复用 `applyEvent` 的 `error` 事件 —— `⚠️ ` 前缀与 part 形状只在
       * `lib/parts.ts` 里定义一次。服务端对「配置没弄好」这类失败会自己落一条同样的
       * 助手消息（刷新后还在）；连不上服务端时它落不了盘，但本地这条至少能立刻看到。
       */
      if (!controller.signal.aborted) {
        /**
         * 连接断了 ≠ 这一轮没跑。run 的生命周期不挂在客户端连接上（POST /api/chat 一断，
         * 服务端照样把这一轮跑完并落盘，见 `app/api/chat/route.ts` 顶部）—— 页面切到后台
         * （标签页冻结 / 电脑休眠 / 网络切换）时断的正是这条 SSE。
         *
         * 先查一眼：服务端还挂着这条 run 就**转交 attachRun 续接**（复用现在这条占位消息，
         * 断线它会自动重接），而不是把半截现场标成失败。以前这里直接渲染「网络错误」并
         * 复位现场，用户只能刷新整页才能把这一轮接回来。
         */
        const alive = await peekActiveRun(conversationId);
        if (alive) {
          handedOff = true;
          await attachRun(conversationId, {
            requestId: alive.requestId,
            assistantId,
          });
        } else {
          failed = true;
          const message = errorMessage(err);
          /**
           * 先把错误渲染出来（马上能看到发生了什么），同时**记下待对账**：服务端那轮
           * 很可能在断线期间跑完并落盘了（`peekActiveRun` 查不到只说明「现在没有在跑的
           * run」—— 它刚结束、或已经被 retention 清掉，两种都查不到）。对账会用服务端
           * 权威历史把这条错误换成真正的回复，不用刷新页面。
           */
          writeSlice(conversationId, (s) => ({
            ...s,
            droppedRound: { baseCount },
            messages: s.messages.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    parts: applyEvent(m.parts, { type: "error", message }),
                  }
                : m,
            ),
          }));
        }
      }
    } finally {
      // 这一轮已经被接回去了（断线续接）：收场归 attachRun —— 这里复位 streaming /
      // 拉历史 / 顶队列都会把刚接上的现场打乱。
      // ⚠️ 在 finally 里 `return true`（而不是裸 `return`）既保住了「这一轮确实开跑了」的
      // 语义，也保留原来那个副作用：finally 里的 return 会吞掉在途异常（调用方是
      // `void runRound(...)`，抛出去就是 unhandledrejection）。
      if (handedOff) return true;
      // 这一会话的现场复位（streaming / 当前轮 / 审批卡 / 提问表都是它自己的）
      writeSlice(conversationId, (s) => ({
        ...s,
        streaming: false,
        replaying: false,
        request: null,
        pendingConfirms: [],
        followupRequests: {},
        retryNotice: null,
      }));
      markRunning(conversationId, false);
      // 标题 / 消息数 / 排序都变了，收流后同步一次列表
      try {
        set({ conversations: await api.listConversations() });
      } catch {
        // 列表刷新失败不影响本轮结果
      }
      /**
       * 用服务端落盘的权威历史覆盖本地（本地是流式期间临时攒的）。
       *
       * ⚠️ **失败的这一轮不能直接拉**：服务端可能压根没存下这条错误（5xx / 连不上），
       * 拉回来只会把刚渲染出来的错误又擦掉。改走对账（`reconcileDroppedRound`）：
       * 它只在服务端**确实多存了这一轮的助手回复**时才采纳，否则保留本地的错误。
       * acp 会话的消息不落本地（服务端历史恒为空）：本地这份就是它的全部展示。
       */
      if (failed) {
        void reconcileDroppedRound(conversationId);
      } else {
        const convBackend = get().conversations.find(
          (c) => c.id === conversationId,
        )?.backend;
        if (convBackend !== "acp") void loadMessages(conversationId);
      }
      // 自然收尾（没被中止、也没失败）：把队列里的下一条顶上来接着跑；
      // 用户点了停止（aborted）则保留队列，等他之后手动再发时一并续上
      if (
        !controller.signal.aborted &&
        !failed &&
        get().activeConversationId === conversationId
      ) {
        pump();
      } else if (
        failed &&
        readSlice(conversationId).queuedMessages.length > 0
      ) {
        // 失败停链（spec §3）：不自动发下一条（防坏配置把整个队列烧完），队列保留，
        // 头部显式提示「已暂停」+ 一键继续 / 清空 —— 现状是静默卡住，用户只能猜
        writeSlice(conversationId, (s) => ({
          ...s,
          queuePausedReason: "failed",
        }));
      }
    }
    // 走到这里 = 这一轮**确实发出去了**（跑完了 / 断了但由 attachRun 接上 / 落成错误）
    return true;
  };

  /**
   * 删消息（「仅删本条」与「本条及其后的全部」共用）：删服务端 → 回拉消息区。
   * 调用方负责选好 id、做过守卫；这里只干删除 + 以服务端为准同步界面。
   *
   * `mode = 'from'` 走**一次**请求（`api.deleteMessagesFrom`）：早先是逐条 `deleteMessage`
   * 循环，N 条消息 = N 次往返 + N 次整份会话落盘，长历史下要好几秒且界面毫无反应
   * （用户报过「很慢、还能继续点别的消息」）。删除接口本来就回传会话列表，也不再单独拉一次。
   *
   * `deleting` 标记覆盖整个窗口（删除 + 回拉），消息区据此显示进度并暂时不收点击。
   */
  const removeMessages = async (
    conversationId: string,
    messageId: string,
    mode: "single" | "from",
  ): Promise<void> => {
    const api = get().getApi();
    if (!api) return;
    let failed: unknown = null;
    writeSlice(conversationId, (s) => ({ ...s, deleting: true }));
    try {
      const conversations =
        mode === "from"
          ? await api.deleteMessagesFrom(conversationId, messageId)
          : await api.deleteMessage(conversationId, messageId);
      set({ conversations });
    } catch (err) {
      // 「这条已经不在」不算失败：上一轮失败时本地消息用的是临时 id（`nextLocalId`），
      // 服务端落盘的是另一套时间戳 id，查无此条属正常。照样回拉真源把界面拉回来。
      if (errorMessage(err) !== "消息不存在") failed = err;
    }
    try {
      // 无论删完还是报错，都以服务端为准回拉一遍（半截删除也要把真源拉回界面）
      await loadMessages(conversationId);
    } finally {
      // 成功 / 失败都必须撤掉标记，否则消息区会一直卡在「正在删除」且点不动
      writeSlice(conversationId, (s) => ({ ...s, deleting: false }));
    }
    if (failed) get().setError(errorMessage(failed));
  };

  return {
    // ---------- 状态 ----------
    slices: {},
    activeWorkspaceId: loadActiveWorkspaceId(),
    activeConversationId: null,
    chatTarget: null,
    mcpServerIds: [],
    browserSettings: null,
    draftAcp: null,
    runningConversations: {},
    blankIntent: false,
    permissionMode: loadPermissionMode(),
    confirmTimeoutMin: loadConfirmTimeout(),
    maxRetries: loadMaxRetries(),
    toolCallConcurrency: loadToolCallConcurrency(),

    // ---------- slice 读写 ----------
    readSlice,
    writeSlice,
    dropSlice,
    pruneSlices,
    clearAllLocalState: () => {
      clearAllQueues();
      set({ slices: {} });
    },

    // ---------- 会话 ----------
    markRunning,
    persistTarget,
    setChatTarget: (target) => {
      set({ chatTarget: target });
      const conversationId = get().activeConversationId;
      if (conversationId) {
        persistTarget(conversationId, target);
        return;
      }
      /**
       * 新任务页（还没有会话）：切到 ACP 就顺手探一次档位（pill 要有数据），
       * 切回内置 agent 就把草稿清掉。已有会话时不探 —— 会话自己带着
       * `acpModes` / `acpThoughtLevel`，再探一次纯属白起一个进程。
       *
       * 只换**同一个 agent 的模型**（`acp:<id>:<model>`）不重探：档位是 agent 级的，
       * 与挑哪个模型无关；重探还会把槽位里已经选好的模式 / 思考档清空（用户挑完
       * 模式再换模型是很自然的顺序）。不同 agent 才清空 —— 别把 A 的档位挂给 B。
       */
      if (
        target?.backend === "acp" &&
        target.configId &&
        get().draftAcp?.agentId === target.configId
      )
        return;
      if (target?.backend === "acp" && target.configId)
        void probeDraftAcp(target.configId);
      else if (get().draftAcp) set({ draftAcp: null });
    },
    probeDraftAcp,
    setDraftAcpMode: (modeId) => {
      set((state) =>
        state.draftAcp
          ? { draftAcp: { ...state.draftAcp, mode: modeId } }
          : state,
      );
    },
    setDraftAcpThought: (value) => {
      set((state) =>
        state.draftAcp
          ? { draftAcp: { ...state.draftAcp, thought: value } }
          : state,
      );
    },
    clearDraftAcp: () => {
      if (get().draftAcp) set({ draftAcp: null });
    },
    setMcpServerIds: (ids) => {
      set({ mcpServerIds: ids });
      const conversationId = get().activeConversationId;
      if (conversationId) persistMcp(conversationId, ids);
    },
    setBrowserSettings: (patch) => {
      // 与当前值合并：调用方只给要改的那一项（如只翻总开关），再整体落库
      const current =
        get().browserSettings ??
        get().defaultBrowserSettings ??
        DEFAULT_BROWSER_SETTINGS;
      const next: BrowserSettings = { ...current, ...patch };
      set({ browserSettings: next });
      const conversationId = get().activeConversationId;
      if (conversationId) persistBrowserSettings(conversationId, next);
    },
    setPermissionMode: (mode) => {
      savePermissionMode(mode);
      set({ permissionMode: mode });
      /**
       * 运行中的轮也要立刻改活档：工具集一轮建一次，闸门靠 `getPermissionMode` 现取 ——
       * 服务端那次 POST 改的就是这一轮 run 上的字段，改完**下一次工具调用**就按新档裁决，
       * 不必等下一轮。没有在跑的轮就什么都不做（下一轮自然带上新档）。
       */
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      const requestId = readSlice(conversationId).request?.id;
      const api = get().getApi();
      if (!requestId || !api) return;
      // 幂等：run 已结束 = 空成功，静默即可（不值得为它弹错误）
      void api.setChatPermission(requestId, mode).catch(() => undefined);
    },
    setAcpPermissionMode: (mode) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      // 乐观更新会话列表（权限 pill 读的是会话对象），失败回滚；服务端标脏后推权威快照
      const prev = get().conversations.find(
        (c) => c.id === conversationId,
      )?.acpPermissionMode;
      const apply = (value: AcpPermissionMode | undefined): void =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  acpPermissionMode: value === "allow" ? "allow" : undefined,
                }
              : c,
          ),
        }));
      apply(mode);
      const api = get().getApi();
      if (!api) return;
      void api
        .setConversationTarget(conversationId, {
          acpPermissionMode: mode === "allow" ? "allow" : null,
        })
        .catch(() => apply(prev));
    },
    setConfirmTimeoutMin: (minutes) => {
      const value =
        Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
      saveConfirmTimeout(value);
      set({ confirmTimeoutMin: value });
    },
    setMaxRetries: (value) => {
      const next = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
      saveMaxRetries(next);
      set({ maxRetries: next });
    },
    setToolCallConcurrency: (value) => {
      const next = resolveToolCallConcurrency(value);
      saveToolCallConcurrency(next);
      set({ toolCallConcurrency: next });
    },
    loadMessages,
    handleFrame,
    saveCollabSettings,
    cancelCollabTask,
    attachRun,
    /**
     * 重接一条进行中的对话：用户点消息区「连接中断」条上的按钮、或页面从后台回来时调。
     * 内部就是 attachRun —— 查服务端有没有在跑的 run、复用现有占位消息、断线自动重接。
     *
     * 已经在重接中（退避睡眠还没醒）时，把那个睡眠**提前唤醒**：退避 sleep 一醒循环
     * 立刻重试，等于 "立即重连" 真的立即。以前做不到这一点 —— attachRun 对「正在接」
     * 的会话直接去重早退，按钮点下去石沉大海。
     */
    reconnectRun: (conversationId: string) => {
      reconnectNudges.get(conversationId)?.();
      return attachRun(conversationId);
    },
    /**
     * 对账一个「断线失败」的轮次：拉服务端权威历史，它确实存下了这一轮就用它替换本地
     * 那条网络错误。页面回前台 / 网络恢复时调（那时网络才刚通，第一次往往拉不到）。
     */
    reconcileDroppedRun: (conversationId: string) =>
      reconcileDroppedRound(conversationId),
    loadConversation,
    openConversation: (conversationId) => {
      // 已是当前会话：什么都不做（重复打开只会白白重拉，界面闪一下）
      if (conversationId && conversationId === get().activeConversationId)
        return;
      // 空态 = 用户的明确意图（「新建会话」/ 删除后落空态）：记下来挡住兜底恢复
      set({
        activeConversationId: conversationId,
        blankIntent: conversationId === null,
      });
      // 记住现场：下次启动直接回到这个会话（它自己记着选的模型）
      saveActiveConversationId(conversationId);
      if (!conversationId) {
        // 回到「开始新对话」页：预选清单第一份**有可用模型**的配置（具体的配置 + 模型，
        // 下拉里显示真实名字）—— 不继承上一个会话的选择，也不存在「默认」概念。
        // 各会话的现场都留在各自的 slice 里，切回来原样还在 —— 不清任何东西。
        // MCP 待定选择照样清空：新会话建出来时会带上，残留会让新会话凭空多出几个 MCP。
        // 浏览器偏好同理：清成「未设」（null）= 按全局默认显示
        // ACP 草稿档位一并清掉：那是上一个新任务页的临时选择，留着会让下一个新会话凭空带上
        set({
          chatTarget: preferredTarget(),
          mcpServerIds: [],
          browserSettings: null,
          draftAcp: null,
        });
        return;
      }
      const existing = get().slices[conversationId];
      // 恢复这个会话记住的模型（配置 / 模型被删就是 null → 界面显示「选择模型」，
      // 不继承别的会话的选择）。列表可能还没刷到最新，装载收尾会用会话详情再校正一次。
      const stored = get().conversations.find((c) => c.id === conversationId);
      set({
        chatTarget: targetFromConversation(stored),
        // MCP 选择也按会话各自记（没存过 = 全不选）
        mcpServerIds: stored?.mcpServerIds ?? [],
        // 浏览器偏好也按会话各自记（没存过 = null → 界面按全局默认显示）
        browserSettings: stored?.browserSettings ?? null,
      });
      /**
       * 定时任务跑出来的会话（`unseen`）：**点开即算看过**。
       *
       * 本地先乐观清掉（红点立刻消失、侧栏不用等一个来回），服务端顺手落标记；
       * fire-and-forget —— 这颗红点晚消失几毫秒没关系，但请求失败绝不能挡住打开会话。
       * 应答是整份清单，直接覆盖（与归档 / 重命名同一条用法）。
       *
       * 只在这一处清：所有入口（侧栏行、定时任务管理页、深链、搜索结果）最终都走
       * `openConversation`，别在各处再抄一遍。
       */
      if (stored?.unseen) {
        const api = get().getApi();
        set({
          conversations: get().conversations.map((c) =>
            c.id === conversationId ? { ...c, unseen: undefined } : c,
          ),
        });
        void api
          ?.markConversationSeen(conversationId)
          .then((list) => set({ conversations: list }))
          .catch(() => undefined);
      }
      if (existing) {
        /**
         * 现场还在内存里：**直接切过去**。切走期间这轮的 SSE 帧一直落在它自己的
         * slice 上，这里看到的就是最新直播 —— 不清空、不重拉、不需要 attach。
         * （resetKey 里带会话 id，切换本身就会让消息区复位落底。）
         *
         * 后台再静默刷一遍历史兜底（别的端可能改过这个会话）：在跑 / 装载中都不刷
         * —— 在跑时流式帧才是真源，装载中时原装载链路自己会写。
         */
        writeSlice(conversationId, (s) => ({
          ...s,
          touchedAt: Date.now(),
          scrollResetSeq: s.scrollResetSeq + 1,
        }));
        // 后台再静默刷一遍历史兜底（别的端可能改过这个会话）。
        // ⚠️ acp 例外：服务端历史恒为空，拉了会把内存里那份 transcript 回放**擦成空会话**
        //（切换走再切回来消息全没就是这个）—— 与 settleRound / runRound 收尾的豁免同一套
        // 道理：本地这份就是 ACP 会话的全部展示
        if (!existing.streaming && !existing.loading) {
          const convBackend = get().conversations.find(
            (c) => c.id === conversationId,
          )?.backend;
          if (convBackend !== "acp") void loadMessages(conversationId);
        }
        if (
          !get().runningConversations[conversationId] &&
          !existing.loading &&
          !existing.streaming
        ) {
          pump();
        }
        pruneSlices(conversationId);
        return;
      }
      /**
       * 现场不在（首次打开 / 刷新后）：亮起「装载中」并走完整装载链路。装载窗口里
       * 消息区显示装载中而不是旧内容 —— 这个窗口若挂着别的会话的列表，用户在上面
       * 删除 / 编辑，拿的是旧消息 id 配新会话 id，服务端对不上就报错（实测踩过的坑）。
       */
      /** localStorage 缓存先顶上：服务端那份要等一个往返，不能让它拖住首帧 */
      const cached = loadQueue(conversationId);
      writeSlice(conversationId, (s) => ({
        ...s,
        touchedAt: Date.now(),
        loading: true,
        error: null,
        // 先铺本地缓存（顺序可能与服务端不同：排序是跨端的，服务端那份才是权威）
        queuedMessages: cached,
      }));
      void loadConversation(conversationId);
      /**
       * 队列的权威在服务端（拖拽排序要跨端一致），但拉它得一个来回 ——
       * 所以本地缓存先顶上、后台拉回来**无感替换**。
       *
       * 身份守卫：这一个来回里用户可能已经改了队列（加 / 删 / 拖），那份改动不能被
       * 这趟晚到的应答盖掉。判据是「slice 里躺的还是我刚铺上的那个数组」（引用相等）
       * —— 只有 patchQueue 才会换掉这个引用。用户切走 / slice 被淘汰时引用也变了，
       * 同样不会覆盖（那时更不该覆盖）。
       */
      void (async () => {
        const remote = await fetchQueue(conversationId);
        if (!remote) return;
        if (get().activeConversationId !== conversationId) return;
        if (readSlice(conversationId).queuedMessages !== cached) return;
        // 只写切片 + 缓存，不回写服务端（这份数据本来就来自它）
        writeSlice(conversationId, (s) => ({ ...s, queuedMessages: remote }));
        saveQueue(conversationId, remote);
      })();
      pruneSlices(conversationId);
    },
    retryLoadMessages: () => {
      const id = get().activeConversationId;
      if (!id) return;
      writeSlice(id, (s) => ({
        ...s,
        loading: true,
        error: null,
        messages: [],
      }));
      void loadConversation(id);
    },
    /**
     * 重新加载一条 ACP 会话（见接口上的注释）。刻意**不复用 `loadConversation`**：
     * 那段 ACP 回放要求「当前就是这条会话」且「本地还没有消息」才写入 —— 后者是为
     * 首次打开准备的（不能盖掉用户刚发出的内容），而本项是用户主动要求的**覆盖式重建**，
     * 两条路径的写入策略正相反，合成一个带 flag 的 helper 只会把两套语义搅在一起。
     *
     * 回放为空就写成空：用户点这一项的含义就是「以 agent 侧为准重来一遍」，
     * 那边没有内容就是真的没有 —— 不像 `convertAcpConversation` 那样把「空」当失败
     * （它要造新会话，空会话没有意义；这里只是重建视图，空视图是诚实的结果）。
     */
    reloadAcpSession: async (conversationId) => {
      const api = get().getApi();
      const conv = get().conversations.find((c) => c.id === conversationId);
      if (!api || !conv || conv.backend !== "acp") return false;
      // 亮起装载标记：消息区显示「装载中」而不是旧内容（重载本来就是「整份换掉」），
      // 顺带清掉上一次遗留的错误态（与 retryLoadMessages 同一套起手式）
      writeSlice(conversationId, (s) => ({ ...s, loading: true, error: null }));

      /**
       * 「重新加载」也先看有没有在跑。跑动中只能从进程内快照 + 帧日志恢复：
       * session/load 会 teardown 正在跑的 ACP 进程（`ACP connection closed`）。
       */
      const activeRun = await peekActiveRun(conversationId);
      if (activeRun) {
        let attached = false;
        try {
          if (conv.configId) {
            const activeCwd = get().workspaces.find(
              (w) => w.id === conv.workspaceId,
            )?.path;
            try {
              const { messages } = await api.getAcpTranscript(
                conv.configId,
                conversationId,
                conv.acpSessionId ?? "",
                activeCwd ?? "",
              );
              // 快照为空（这份内存视图没建起来）时保留本地现场，别把用户已经看到的
              // 历史擦成空；非空才按「重新加载 = 整份换掉」覆盖。
              if (messages.length > 0) {
                writeSlice(conversationId, (s) => ({
                  ...s,
                  messages,
                  scrollResetSeq: s.scrollResetSeq + 1,
                }));
              }
            } catch {
              // 快照不可用不挡 attach：当前这一轮仍可由帧日志重建
            }
          }
          attached = await attachRun(
            conversationId,
            activeRun.assistantMessageId
              ? {
                  requestId: activeRun.requestId,
                  assistantId: activeRun.assistantMessageId,
                }
              : undefined,
          );
        } finally {
          writeSlice(conversationId, (s) => ({ ...s, loading: false }));
        }
        if (attached) return true;
        // attach 没接上（刚结束 / 连接失败）：继续走下面的 idle 重建
        writeSlice(conversationId, (s) => ({ ...s, loading: true, error: null }));
      }

      if (!conv.configId || !conv.acpSessionId) {
        writeSlice(conversationId, (s) => ({ ...s, loading: false }));
        get().setError("这条会话没有 agent 侧会话，重新加载不了");
        return false;
      }
      const cwd = get().workspaces.find((w) => w.id === conv.workspaceId)?.path;
      if (!cwd) {
        writeSlice(conversationId, (s) => ({ ...s, loading: false }));
        get().setError("找不到这条会话的工作区目录，重新加载不了");
        return false;
      }
      try {
        const { messages } = await api.getAcpTranscript(
          conv.configId,
          conversationId,
          conv.acpSessionId,
          cwd,
        );
        // 整体覆盖 + 复位落底同一次写入（同 loadMessages 的 resetScroll，别拆两帧）
        writeSlice(conversationId, (s) => ({
          ...s,
          messages,
          scrollResetSeq: s.scrollResetSeq + 1,
        }));
        return true;
      } catch (err) {
        // 回放失败（agent 不支持 load / 会话失效 / OpenCode 服务故障）：本地那份**原样留着**
        // （没覆盖过），原因走全局 error 弹 toast —— 与 convertAcpConversation 同一套收场
        get().setError(errorMessage(err));
        return false;
      } finally {
        writeSlice(conversationId, (s) => ({ ...s, loading: false }));
      }
    },
    /**
     * **重新加载这一条会话**：等价于「刷新页面 → 点开这个会话」，但只作用于它，不动别的
     * 标签、也不重挂 React 树（终端 / 面板现场都还在）。
     *
     * 两条路按后端分（与刷新页面后打开会话**完全同源**）：
     * - **mastra**：拉服务端落盘的权威历史（`loadMessages`，覆盖式）。断线时本地渲染的
     *   那条「⚠️ 网络错误」会被真正的回复顶掉 —— 那正是用户刷新整页想达到的效果；
     * - **ACP**：消息在 agent 侧，只有 `session/load` 回放能重建（`reloadAcpSession`）。
     *
     * ⚠️ **正在跑就拒绝**：`loadMessages` 的过期判据是「代次」，本轮已经开跑时代次没变，
     * 服务端快照会把正在流式攒的现场整段盖掉（等于把直播掐了）。调用方（错误块那颗按钮）
     * 也据此禁用。
     */
    reloadConversation: async (conversationId) => {
      if (readSlice(conversationId).streaming) return false;
      const conv = get().conversations.find((c) => c.id === conversationId);
      if (conv?.backend === "acp") return get().reloadAcpSession(conversationId);
      const fetched = await loadMessages(conversationId, {
        loadError: true,
        resetScroll: true,
      });
      return fetched !== null;
    },
    selectWorkspace: (workspaceId, openNewest = true) => {
      // `null` = 不选项目（界面上的临时状态，见接口注释）：落盘一个 null，
      // 下次启动回到「没选」而不是被拽回第一个项目
      set({ activeWorkspaceId: workspaceId });
      saveActiveWorkspaceId(workspaceId);
      if (!openNewest) return;
      const newest = get().conversations.find(
        (c) => c.workspaceId === workspaceId,
      );
      get().openConversation(newest?.id ?? null);
    },
    newConversation: async (workspaceId, title, target, done) => {
      /**
       * `done` 只调一次（成功 / 失败都要调，见接口注释）。`settle` 收成幂等：早退的几条
       * 分支都从同一个出口走，漏一条就等于「转圈永远不停」。
       */
      let settled = false;
      const settle = (conversationId: string | null): string | null => {
        if (!settled) {
          settled = true;
          done?.(conversationId);
        }
        return conversationId;
      };
      const api = get().getApi();
      if (!api) return settle(null);
      /**
       * `wid` 为空 = 用户没选项目（输入框下方那颗「未指定工作区」）。**不是错误**：
       * 服务端会当场建一个临时工作区（目录 `<数据目录>/conversations/<会话 id>`）再建会话，
       * 返回的 `created.workspaceId` 就是它 —— 会话永远绑在真实工作区上。
       */
      const wid = workspaceId ?? get().activeWorkspaceId;
      /**
       * 目录不在了就别建：服务端 `POST /api/conversations` 也有同一道校验（那才是真拦），
       * 但它的错误要等一个往返才回来；这里先拦一道，让**所有入口**（侧栏「新建会话」按钮 /
       * 命令面板 / 快捷键 / 空白页写回）都在同一处拿到同一句人话。
       * 标记是服务端巡检的结论（见 `AgentWorkspace.dirMissing`），可能慢半拍 —— 所以别把它
       * 当成唯一防线。
       */
      const ws = wid ? get().workspaces.find((w) => w.id === wid) : undefined;
      if (ws?.dirMissing) {
        get().setError(
          `工作区目录不存在：${ws.path}（可能已被删除或移动），无法新建会话`,
        );
        return settle(null);
      }
      try {
        const clean = title?.trim();
        // 新任务页上选好的 MCP 是**待定选择**：跟着会话一起落库，否则用户白选。
        // `target` 里已显式带了 mcpServerIds 时以它为准（调用方更清楚）。
        const mcpServerIds = target?.mcpServerIds ?? get().mcpServerIds;
        // 新任务页上设好的浏览器偏好也是**待定选择**：跟着会话一起落库
        const browserSettings = get().browserSettings;
        const created = await api.createConversation({
          // 缺省 = 服务端建临时工作区（见 api.createConversation 的注释）
          ...(wid ? { workspaceId: wid } : {}),
          ...(clean ? { title: clean } : {}),
          ...(target ?? {}),
          ...(mcpServerIds.length ? { mcpServerIds } : {}),
          ...(browserSettings ? { browserSettings } : {}),
        });
        set((state) => ({ conversations: [created, ...state.conversations] }));
        // 没选项目：服务端刚建了个临时工作区 —— 清单不刷新的话顶栏 / 侧栏认不出它
        if (!wid) set({ workspaces: await api.listWorkspaces() });
        set({
          activeWorkspaceId: created.workspaceId,
          activeConversationId: created.id,
        });
        // 新会话也是「当前现场」，下次启动回到它
        saveActiveWorkspaceId(created.workspaceId);
        saveActiveConversationId(created.id);
        // 创建时就定了后端 / 模型：本地 chatTarget 同步上，第一轮就按它发
        if (target?.backend) {
          set({
            chatTarget: {
              backend: target.backend,
              ...(target.configId ? { configId: target.configId } : {}),
              ...(target.modelId ? { modelId: target.modelId } : {}),
            },
          });
        }
        /**
         * 新任务页选好的 ACP 档位：会话一建好就下发。agent 侧 `session/new` 给的默认档
         * 未必是用户选的那个，而这一轮马上就要发 —— 等下一轮再补就是「第一轮按错的档跑」。
         * 失败不挡发送：pill 会显示回滚后的真实档，用户能看见。
         */
        const draft = get().draftAcp;
        if (
          created.backend === "acp" &&
          draft &&
          draft.agentId === created.configId
        ) {
          if (draft.mode)
            await get().setAcpAgentMode(draft.agentId, created.id, draft.mode);
          if (draft.thought)
            await get().setAcpThoughtLevel(
              draft.agentId,
              created.id,
              draft.thought,
            );
        }
        if (get().draftAcp) set({ draftAcp: null });
        // 会话已经建好、界面立刻就能用：档位下发在上面（要等 agent 应答），那几百毫秒
        // 不该继续转圈 —— 用户已经从「空态页」切进会话里了
        return settle(created.id);
      } catch (err) {
        get().setError(errorMessage(err));
        return settle(null);
      }
    },
    newCollabConversation: async (workspaceId) => {
      const preferred = preferredTarget();
      return get().newConversation(workspaceId, undefined, {
        backend: "mastra",
        ...(preferred
          ? { configId: preferred.configId, modelId: preferred.modelId }
          : {}),
        kind: "collab",
        collab: defaultCollabSettings(),
      });
    },
    deleteConversation: async (id) => {
      const api = get().getApi();
      if (!api) return { ok: false, nextId: null };
      try {
        const rest = await api.deleteConversation(id);
        set({ conversations: rest });
        // 本地现场与队列一并清掉（不论删的是不是当前会话）
        dropSlice(id);
        saveQueue(id, []);
        if (get().activeConversationId !== id)
          return { ok: true, nextId: null };
        const wsId = get().conversations.find((c) => c.id === id)?.workspaceId;
        const next = wsId
          ? (rest.find((c) => c.workspaceId === wsId)?.id ?? null)
          : null;
        get().openConversation(next);
        return { ok: true, nextId: next };
      } catch (err) {
        get().setError(errorMessage(err));
        return { ok: false, nextId: null };
      }
    },
    clearConversation: async (id) => {
      const api = get().getApi();
      if (!api) return;
      try {
        set({ conversations: await api.clearConversation(id) });
        if (get().slices[id]) writeSlice(id, (s) => ({ ...s, messages: [] }));
      } catch (err) {
        get().setError(errorMessage(err));
      }
    },
    deleteMessage: async (messageId) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      const slice = readSlice(conversationId);
      // 这个会话自己正在跑就不许删（别的会话在跑不妨碍）——删除会动服务端消息，与流式写冲突
      if (slice.streaming || get().runningConversations[conversationId]) return;
      // 已经有一个删除在飞：两个删除的「删完回拉」会互相盖。界面上也点了（消息区不收点击），
      // 这里是兜底（多面板 / 快捷键等别的入口）
      if (slice.deleting) return;
      // 不在列表里（历史重拉 / 刚被删过）：别拿野 id 去删
      if (!slice.messages.some((m) => m.id === messageId)) return;
      await removeMessages(conversationId, messageId, "single");
    },
    deleteMessagesFrom: async (messageId) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      const slice = readSlice(conversationId);
      // 这个会话自己正在跑就不许删（别的会话在跑不妨碍）——删除会动服务端消息，与流式写冲突
      if (slice.streaming || get().runningConversations[conversationId]) return;
      if (slice.deleting) return;
      // 本地先确认这条还在（历史重拉 / 刚被删过时不拿野 id 去打服务端）
      if (!slice.messages.some((m) => m.id === messageId)) return;
      await removeMessages(conversationId, messageId, "from");
    },
    resendMessage: async (messageId, text, files, onStarted) => {
      /**
       * ⚠️ 编辑重发是**先删历史、再发**：目标失效（没选模型 / 配置被删 / 模型下架）时
       * 必须在删之前拦下 —— 否则用户既发不出去、又平白丢了那段历史，比「草稿被吃掉」
       * 严重得多。`guardTarget` 正好就是这个判据，这里问得比 `runRound` 更早。
       *
       * 剩下的失败点（服务端 400 / 连不上）仍落在删之后：编辑重发本来就有「以这条为
       * 起点重来」的语义，那种情况靠 `send` 回传 `false` 让输入框把草稿还回去。
       */
      if (!guardTarget()) return false;
      // 已经有一个删除在飞（另一个入口刚点的）：别在它上面再叠一次「删 + 发」——
      // 那样两条回拉会互相盖，历史可能停在错的那一份
      if (readSlice(get().activeConversationId).deleting) return false;
      await get().deleteMessagesFrom(messageId);
      return get().send(text, files, onStarted);
    },

    // ---------- 发一轮 ----------
    enqueueMessage: (text, files) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      const item: QueuedMessage = {
        id: nextLocalId("q"),
        text,
        createdAt: Date.now(),
        ...(files && files.length > 0 ? { files } : {}),
      };
      patchQueue(conversationId, [
        ...readSlice(conversationId).queuedMessages,
        item,
      ]);
    },
    removeQueuedMessage: (id) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      patchQueue(
        conversationId,
        readSlice(conversationId).queuedMessages.filter((m) => m.id !== id),
      );
    },
    updateQueuedMessage: (id, text) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      patchQueue(
        conversationId,
        readSlice(conversationId).queuedMessages.map((m) =>
          m.id === id ? { ...m, text } : m,
        ),
      );
    },
    /**
     * 拖拽排序：把 `id` 这一条**挪到 `beforeId` 前面**（`beforeId` 为空 = 挪到最后）。
     *
     * 为什么收两个 id 而不是整个数组：拖拽时 react-dnd 的 `hover` 会连续触发，
     * 组件闭包里攥着的数组那时可能是旧的，让它自己算好下标再传过来等于按错的基准
     * 插。下标一律由这里从**最新的**队列里算。
     */
    moveQueuedMessage: (id, beforeId) => {
      const conversationId = get().activeConversationId;
      if (!conversationId || id === beforeId) return;
      const queue = readSlice(conversationId).queuedMessages;
      const from = queue.findIndex((m) => m.id === id);
      if (from < 0) return;
      const next = queue.slice();
      const [moved] = next.splice(from, 1);
      // 目标可能也被移走了：从**移完之后**的数组里找它的新位置
      const to = beforeId ? next.findIndex((m) => m.id === beforeId) : -1;
      next.splice(to < 0 ? next.length : to, 0, moved);
      patchQueue(conversationId, next);
    },
    /**
     * ↑ / ↓ 按钮微调（触屏设备拖不动，见 ChatPanel 的 QueuedRow）：`id` 这一条在队列里
     * 相对移动 `delta` 位（-1 = 往前提一位 = 更早发出）。越界（已是第一条 / 最后一条）不动。
     *
     * 为什么不复用 `moveQueuedMessage`：那是「挪到某一条前面」的语义，而「往下挪一位」
     * 得拿后一条反过来调它（`move(next.id, id)`），读起来反直觉。下标照样由这里从最新队列算。
     */
    moveQueuedMessageBy: (id, delta) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      const queue = readSlice(conversationId).queuedMessages;
      const from = queue.findIndex((m) => m.id === id);
      if (from < 0) return;
      const to = from + delta;
      if (to < 0 || to >= queue.length) return;
      const next = queue.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      patchQueue(conversationId, next);
    },
    sendQueuedMessage: (id) => {
      const conversationId = get().activeConversationId;
      if (!conversationId || get().runningConversations[conversationId]) return;
      const queue = readSlice(conversationId).queuedMessages;
      const item = queue.find((m) => m.id === id);
      if (!item) return;
      // 手动拍板要发：失败暂停的标记解除
      writeSlice(conversationId, (s) => ({ ...s, queuePausedReason: null }));
      patchQueue(
        conversationId,
        queue.filter((m) => m.id !== id),
      );
      void get()
        .runRound(item.text, item.files)
        .then((started) => {
          // 没能开跑（没选模型 / 没连上…）：这条不能就这么没了 —— 放回队列末尾
          if (!started) {
            patchQueue(conversationId, [
              ...readSlice(conversationId).queuedMessages,
              item,
            ]);
          }
        });
    },
    /**
     * 立刻发送一条还没发出去的插话（行的 ➤）：与 `sendQueuedMessage` 同款 ——
     * 只有本轮不在跑时才可点（跑着时那颗钮是禁用的），把这条从「插入中」列表摘掉，
     * 再**按普通消息起新一轮**（文本 + 附件一起带走）。
     *
     * 为什么不是「让它立刻在边界生效」：收件箱只活在活跃 run 上。能点到这颗钮就说明
     * 那一轮已经结束了（用户停止 / 报错 / 断线），服务端早没有这条插话了 —— 此时唯一
     * 有意义的动作就是把它当新消息发出去。剩下的遗留条目会在 `runRound` 里转入待发送队列。
     */
    sendSteer: (messageId) => {
      const conversationId = get().activeConversationId;
      if (!conversationId || get().runningConversations[conversationId]) return;
      const item = readSlice(conversationId).pendingSteers.find(
        (m) => m.id === messageId,
      );
      if (!item) return;
      const text = textOf(item);
      const files = fileRefsOfParts(item.parts);
      if (!text && files.length === 0) return;
      writeSlice(conversationId, (s) => ({
        ...s,
        pendingSteers: s.pendingSteers.filter((m) => m.id !== messageId),
      }));
      void get()
        .runRound(text, files)
        .then((started) => {
          // 没能开跑（没选模型 / 没连上…）：把它放回列表，别让用户刚写的话凭空消失
          if (!started) {
            writeSlice(conversationId, (s) => ({
              ...s,
              pendingSteers: [...s.pendingSteers, item],
            }));
          }
        });
    },
    /** 清空待发送队列（一并解除失败暂停的标记；服务端那份同步覆盖为空） */
    clearQueuedMessages: () => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      writeSlice(conversationId, (s) => ({ ...s, queuePausedReason: null }));
      patchQueue(conversationId, []);
    },
    removeSteer: async (messageId) => {
      const conversationId = get().activeConversationId;
      const api = get().getApi();
      if (!api || !conversationId) return;
      try {
        await api.removeSteer(conversationId, messageId);
      } catch {
        // 409（刚好跑完）/ 网络错误：本地照移 —— 收件箱是真源，后续 user-injected
        // 不来就说明确实没消费，消息也不在了
      }
      writeSlice(conversationId, (s) => ({
        ...s,
        pendingSteers: s.pendingSteers.filter((m) => m.id !== messageId),
      }));
    },
    /**
     * 重排插话：把 `messageId` 挪到 `beforeId` 前面（`beforeId` 为空 = 挪到最后）。
     *
     * 与队列的 `moveQueuedMessage` 同款：下标一律从**最新的**数组里算 —— 拖拽时 react-dnd
     * 的 `hover` 会连续触发，组件闭包里攥着的数组那时可能是旧的，让它自己算等于按错基准插。
     */
    moveSteer: (messageId, beforeId) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      const list = readSlice(conversationId).pendingSteers;
      const from = list.findIndex((m) => m.id === messageId);
      if (from < 0) return;
      const next = list.slice();
      const [moved] = next.splice(from, 1);
      // 目标可能也被移走了：从**移完之后**的数组里找它的新位置
      const to = beforeId ? next.findIndex((m) => m.id === beforeId) : -1;
      next.splice(to < 0 ? next.length : to, 0, moved);
      writeSlice(conversationId, (s) => ({ ...s, pendingSteers: next }));
      syncSteerOrder(conversationId, next);
    },
    /**
     * ↑ / ↓ 按钮微调（触屏拖不动，见 ChatPanel 的 SortableRow）：这条相对挪 `delta` 位
     * （-1 = 往前提一位 = 更早生效）。越界（已是第一条 / 最后一条）不动。
     */
    moveSteerBy: (messageId, delta) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      const list = readSlice(conversationId).pendingSteers;
      const from = list.findIndex((m) => m.id === messageId);
      if (from < 0) return;
      const to = from + delta;
      if (to < 0 || to >= list.length) return;
      const next = list.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      writeSlice(conversationId, (s) => ({ ...s, pendingSteers: next }));
      syncSteerOrder(conversationId, next);
    },
    /**
     * 会话分叉（「从此签出」）：fork 当前会话到某条消息（含），刷新列表并**切到新会话**
     * （走 openConversation 的装载链路）。失败（运行中 409 / ACP / 消息不存在）只提示。
     */
    forkConversation: async (upToMessageId, opts) => {
      const conversationId = get().activeConversationId;
      const api = get().getApi();
      if (!api || !conversationId) return;
      try {
        let targetWorkspaceId: string | undefined;
        if (opts?.worktreeIdentifier) {
          // 先建 worktree 项目（校验/落库都在服务端 createWorktree），再把分叉挂进去
          const source = get().conversations.find(
            (c) => c.id === conversationId,
          );
          if (!source) return;
          const workspace = await api.createWorktree(source.workspaceId, {
            identifier: opts.worktreeIdentifier,
            ...(opts.worktreeName?.trim()
              ? { name: opts.worktreeName.trim() }
              : {}),
          });
          targetWorkspaceId = workspace.id;
          set({ workspaces: await api.listWorkspaces() });
        }
        const { conversation } = await api.forkConversation(
          conversationId,
          upToMessageId,
          targetWorkspaceId,
        );
        set({ conversations: await api.listConversations() });
        // 分叉进了新工作区就一并切过去（侧栏要落在 worktree 项目树上看得到它）
        if (targetWorkspaceId) get().selectWorkspace(targetWorkspaceId);
        await get().openConversation(conversation.id);
      } catch (err) {
        get().setError(errorMessage(err));
        throw err;
      }
    },
    /**
     * ACP 会话 → 内置 Agent 会话（侧栏会话行「更多」里的一项）。
     *
     * 三步：拉转录（agent 侧 `session/load` 回放）→ 洗成内置格式 → 建一条 mastra 会话。
     * **不新增服务端路由**：`POST /api/conversations` 本来就收 `{ backend, messages }`，
     * 且对 mastra 后端不做任何特判（历史直接进 `domain.saveConversation`）。
     *
     * ⚠️ 转录必须**现拉**：acp 会话的本地 `messages` 恒为空（历史在 agent 侧）。
     * 拉不回来（agent 没广告 load / session 失效 / 找不到工作区目录）就明确失败 ——
     * 别造一条空会话骗用户。
     *
     * ⚠️ 收尾必须把模型选择摆到**内置**那一档：新会话落库时没带 configId / modelId
     * （与「新建任务」同一起点），`openConversation` 会把 chatTarget 恢复成 null；
     * 不补的话用户停在「选择模型」很别扭，更糟的是 —— 若 chatTarget 里还留着**那条 ACP
     * 会话**的值，下一轮就会带着 acp 后端发出去（服务端按输入的后端判分支）。
     * 用 `preferredTarget()`（= 上次真正发过的**内置**模型，刻意排除 ACP）兜一下；
     * 没有就保持 null 让用户自己选 —— 与空白页同一条规矩，绝不替他挑一个没选过的模型。
     */
    convertAcpConversation: async (conversationId, upToMessageId, opts) => {
      const api = get().getApi();
      const conv = get().conversations.find((c) => c.id === conversationId);
      if (!api || !conv || conv.backend !== "acp") return false;
      // 运行中拉转录会 teardown 正在跑的 ACP 进程：等这一轮结束再转，别把现场打断
      if (await peekActiveRun(conversationId)) {
        get().setError("这一轮还在运行，结束后再转换");
        return false;
      }
      if (!conv.configId || !conv.acpSessionId) {
        get().setError("这条会话没有可回放的 agent 侧会话，转不了");
        return false;
      }
      const cwd = get().workspaces.find((w) => w.id === conv.workspaceId)?.path;
      if (!cwd) {
        get().setError("找不到这条会话的工作区目录，转不了");
        return false;
      }
      try {
        const { messages } = await api.getAcpTranscript(
          conv.configId,
          conversationId,
          conv.acpSessionId,
          cwd,
        );
        // 回放回来是空的（会话本来就空 / agent 不给内容）：造一条空会话没有任何意义，
        // 说清原因收场。注意这**不等于**「拉失败」—— 那种情况 getAcpTranscript 会抛。
        if (messages.length === 0) {
          get().setError("agent 侧没有可回放的内容，这条会话转不了");
          return false;
        }
        // 「从某条消息起转换」：只保留到该条（含）为止。回放 id 是 `u-replay-N` /
        // `a-replay-N`（每次按同一顺序回放，id 稳定），所以优先按 id 找终点；
        // 找不到（刚发出、agent 侧还没 load 出来）就退回**本地列表的位置**截断 ——
        // 本地那份与回放同源、前缀对齐，按位置切一样准。
        let history = messages;
        if (upToMessageId) {
          let endIndex = messages.findIndex((m) => m.id === upToMessageId);
          if (endIndex < 0) {
            endIndex = readSlice(conversationId).messages.findIndex(
              (m) => m.id === upToMessageId,
            );
          }
          // 终点都不认识：宁可显式失败，也别悄悄转出「比用户点的那条更长 / 更短」的历史
          if (endIndex < 0) {
            get().setError("找不到这条消息，转不了");
            return false;
          }
          history = messages.slice(0, endIndex + 1);
        }
        // worktree 模式：先在**源会话所属**项目下建工作树（与 forkConversation 同一套），
        // 新会话随后挂进去 —— 原项目一行代码不动
        let targetWorkspaceId = conv.workspaceId;
        if (opts?.worktreeIdentifier) {
          const workspace = await api.createWorktree(conv.workspaceId, {
            identifier: opts.worktreeIdentifier,
            ...(opts.worktreeName?.trim()
              ? { name: opts.worktreeName.trim() }
              : {}),
          });
          targetWorkspaceId = workspace.id;
          set({ workspaces: await api.listWorkspaces() });
        }
        const created = await api.createConversation({
          workspaceId: targetWorkspaceId,
          title: `${conv.title.trim() || "未命名会话"}（内置 Agent）`,
          backend: "mastra",
          // 转换产物整份作为新会话的历史（服务端整体写入）
          messages: toBuiltinHistory(history),
        });
        set({ conversations: await api.listConversations() });
        // 侧栏可能在别的项目下点的这一项：新会话属于**目标**工作区，先切过去再打开，
        // 否则打开后侧栏停在别的项目树里、看不见它
        if (get().activeWorkspaceId !== targetWorkspaceId)
          get().selectWorkspace(targetWorkspaceId);
        await get().openConversation(created.id);
        // 见方法头注释：把模型选择摆回内置那一档（没有上次用过的内置模型就留 null）
        set({ chatTarget: preferredTarget() });
        return true;
      } catch (err) {
        get().setError(errorMessage(err));
        return false;
      }
    },
    pump,
    runRound,
    send: async (text, files, onStarted) => {
      const trimmed = text.trim();
      if (!trimmed && !(files && files.length > 0)) return false;
      const conversationId = get().activeConversationId;
      // 当前会话正在跑 → 入队等待；否则立即开新一轮
      if (conversationId && get().runningConversations[conversationId]) {
        get().enqueueMessage(trimmed, files);
        // 入队也是「发出去了」：内容已经落进界面上看得见的「待发送」列表，没被吃掉
        onStarted?.();
        return true;
      }
      /**
       * 兜底熄转圈：`runRound` 的每条出口都已收（建会话的 `done` / 守卫早退），这里
       * 再加一层 —— 转圈卡住比不转更糟（按钮一直不可点 = 输入框废了），宁可多熄一次。
       */
      try {
        return await runRound(trimmed, files, onStarted);
      } finally {
        if (get().creatingConversation) set({ creatingConversation: false });
      }
    },
    /**
     * 运行中插话（steer）：活跃会话在跑 → 递给服务端收件箱（agent 下一个工具步骤
     * 边界注入当前轮，**附件一起注入**）；409（刚好跑完了）或没在跑 → 回落普通发送
     * —— 空闲时插话语义上就是发消息，附件照带，零损失。其余错误（网络 / 400）原样上抛提示。
     */
    steer: async (text, files, onStarted) => {
      const trimmed = text.trim();
      const sendable = files ?? [];
      // 只带附件不写字也放行（与 send / enqueueMessage 同一口径）
      if (!trimmed && sendable.length === 0) return false;
      const conversationId = get().activeConversationId;
      if (conversationId && get().runningConversations[conversationId]) {
        const api = get().getApi();
        if (api) {
          try {
            const { message } = await api.steer(
              conversationId,
              trimmed,
              sendable,
            );
            // 立刻出现在「插入中」列表（agent 消费时会随 user-injected 事件转正出列）
            writeSlice(conversationId, (s) => ({
              ...s,
              pendingSteers: [...s.pendingSteers, message],
            }));
            // 已经进了收件箱 = 发出去了（界面上看得见这条「插入中」）
            onStarted?.();
            return true;
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
              // 恰好跑完了：按普通消息发送（见方法注释）
            } else {
              get().setError(errorMessage(err));
              return false;
            }
          }
        }
      }
      // 回落普通发送：附件照带（空闲插话 ≡ 发消息，图不能丢在这一步）
      return runRound(trimmed, sendable, onStarted);
    },
    stop: async () => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      await get().stopConversation(conversationId);
    },

    stopConversation: async (conversationId: string) => {
      const current = readSlice(conversationId).request;
      if (!current) return;
      const api = get().getApi();
      // 先让服务端停下 Agent 循环，再断开 HTTP（顺序反了会留下孤儿循环）。
      // 服务端在 abort 时会把正等着的审批按拒绝解开（否则工具会卡到超时）
      if (current.id) await api?.abort(current.id).catch(() => undefined);
      current.controller.abort();
      writeSlice(conversationId, (s) => ({
        ...s,
        streaming: false,
        replaying: false,
        request: null,
        pendingConfirms: [],
        followupRequests: {},
        // ⚠️ 不清 `pendingSteers`（与 settleRound 同理）：服务端 abort 会把收件箱清空，
        // 这些插话已经不可能生效，但**内容是用户刚写的**，留在列表里让他能 ➤ 立刻发送
        // 或 ✕ 丢弃；直接清掉就等于把人写的东西弄没了。
        retryNotice: null,
      }));
      markRunning(conversationId, false);
    },

    stopCommand: async (toolCallId: string) => {
      const conversationId = get().activeConversationId;
      if (!conversationId) return;
      const current = readSlice(conversationId).request;
      // 没有在跑的轮 = 无从停（按钮本来也不该出现：没有 request.id）
      if (!current?.id) return;
      const api = get().getApi();
      // 幂等：没命中（命令已结束）就是空成功，静默即可 —— 不值得为它弹错误
      await api?.stopCommand(current.id, toolCallId).catch(() => undefined);
    },

    // ---------- 审批 / 提问 ----------
    resolveConfirm: async (id, approved, optionId) => {
      // 乐观撤掉本会话的卡片（审批卡只在活跃会话渲染，撤的就是当前 slice 那张）
      const conversationId = get().activeConversationId;
      if (conversationId) {
        writeSlice(conversationId, (s) => ({
          ...s,
          pendingConfirms: s.pendingConfirms.filter((c) => c.id !== id),
        }));
      }
      const api = get().getApi();
      if (!api) return;
      try {
        const { resolved } = await api.resolveConfirm(id, approved, optionId);
        if (!resolved) {
          get().setError(
            "这条审批已失效（可能超时或已在别处答复过），Agent 会按「拒绝」继续",
          );
        }
      } catch (err) {
        get().setError(errorMessage(err));
      }
    },
    resolveFollowup: async (toolCallId, answer) => {
      const conversationId = get().activeConversationId;
      const req = conversationId
        ? readSlice(conversationId).followupRequests[toolCallId]
        : undefined;
      if (req && conversationId) {
        // 乐观撤掉活跃会话的这张提问卡（提问卡只在活跃会话渲染）
        writeSlice(conversationId, (s) => {
          if (!(toolCallId in s.followupRequests)) return s;
          const next = { ...s.followupRequests };
          delete next[toolCallId];
          return { ...s, followupRequests: next };
        });
      }
      const api = get().getApi();
      if (!api || !req) return;
      try {
        const { resolved } = await api.resolveFollowup(req.id, answer);
        if (!resolved) {
          get().setError(
            "这个提问已失效（可能超时或已在别处答复过），Agent 会按「跳过」继续",
          );
        }
      } catch (err) {
        get().setError(errorMessage(err));
      }
    },
  };
};
