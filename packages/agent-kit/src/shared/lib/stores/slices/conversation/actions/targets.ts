/**
 * action 层：targets。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import {
  DEFAULT_BROWSER_SETTINGS,
  type BrowserSettings,
} from "@fizz/contracts";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createTargetsActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "setReasoningEffort" | "setChatTarget" | "setDraftAcpMode" | "setDraftAcpThought" | "clearDraftAcp" | "setMcpServerIds" | "setBrowserSettings"
> {
  const { set, get, probeDraftAcp, persistTarget, persistReasoningEffort, persistMcp, persistBrowserSettings } = ctx;

  return {
    setReasoningEffort: (effort) => {
      set({ reasoningEffort: effort });
      const conversationId = get().activeConversationId;
      if (conversationId) persistReasoningEffort(conversationId, effort);
    },
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
  };
}
