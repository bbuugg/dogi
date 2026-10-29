/**
 * 各层工厂之间传递的上下文类型。
 *
 * 分层（依赖只能从上往下，没有回边）：
 *   deps        store 的 set / get / api
 *   core        不依赖流式运行时的助手（slice 读写、模型目标、持久化、队列同步）
 *   run-loop    互递归的流式运行时（接流 / 收帧 / 跑一轮 / 对账）—— 只能整块留着
 *   messages    依赖流式运行时的消息级操作
 *   actions     暴露给 UI 的 action（叶子层，internals 不会反过来调它）
 *
 * 类型全用 `import type`，运行时不会产生循环依赖。
 */
import type { StateCreator } from "zustand";
import type { AgentStore } from "@fizz/agent-kit/shared/lib/stores/agent-store";
import type { ConversationSlice } from "../types";
import type { createConversationCore } from "./core";
import type { createConversationRunLoop } from "./run-loop";
import type { createMessageOps } from "./messages";

type ConvSliceCreator = StateCreator<AgentStore, [], [], ConversationSlice>;

/** store 的三件套 */
export type ConvDeps = {
  set: Parameters<ConvSliceCreator>[0];
  get: Parameters<ConvSliceCreator>[1];
  api: Parameters<ConvSliceCreator>[2];
};

/** deps + 基础助手 */
export type ConvCore = ConvDeps & ReturnType<typeof createConversationCore>;

/** deps + 基础助手 + 流式运行时 */
export type ConvRun = ConvCore & ReturnType<typeof createConversationRunLoop>;

/** action 层能看到的全部内部能力 */
export type ConvInternals = ConvRun & ReturnType<typeof createMessageOps>;
