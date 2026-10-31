/**
 * action 层：targets。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 *
 * ## 为什么每个 setter 都带 `scope`
 *
 * 模型 / 思考强度 / MCP / 浏览器偏好这四项在 store 上是**单份**的（焦点会话的现场）。
 * 单标签时"焦点即视图"没问题，但主区域分屏时两个标签同时可见 —— 不带作用域的写会把
 * 非焦点标签的操作记到焦点会话上（用户报的「点一下标签两个 composer 的模型同步」）。
 *
 * `scope` 约定（全 store 统一）：
 * - 不传 → 旧行为，作用于 `activeConversationId`；
 * - `null` → 明确"新对话页"，只写草稿态，不落任何会话；
 * - 会话 id → 作用于那个会话：焦点会话仍同步全局那份（保持"下拉即所见"），非焦点
 *   会话只改它自己的清单项 + 落盘。
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
  const { set, get, probeDraftAcp, scopedSettingsOf, resolveConvId, isFocus, persistTarget, persistReasoningEffort, persistMcp, persistBrowserSettings } = ctx;

  /**
   * 这次写的是哪个会话，以及要不要同时改 store 上那份全局现场。
   *
   * `focus = false`（只可能出现在非焦点会话）时**绝不能** `set({ chatTarget })`：
   * 那份全局现场属于焦点标签，改了就等于把 A 标签刚选的东西挪到 B 上。
   */
  const resolveScope = (
    scope?: string | null,
  ): { conversationId: string | null; focus: boolean } => {
    const conversationId = resolveConvId(scope);
    // 草稿页（没有会话）也算「焦点」：那时全场只有它一块视图
    return { conversationId, focus: !conversationId || isFocus(conversationId) };
  };

  /** 浏览器偏好的合并基线：草稿页 / 焦点会话用全局那份，其余按该会话落盘的配置 */
  const browserBase = (
    focus: boolean,
    conversationId: string | null,
  ): BrowserSettings =>
    (focus
      ? get().browserSettings
      : conversationId
        ? scopedSettingsOf(conversationId).browserSettings
        : null) ??
    get().defaultBrowserSettings ??
    DEFAULT_BROWSER_SETTINGS;

  return {
    setReasoningEffort: (effort, scope) => {
      const { conversationId, focus } = resolveScope(scope);
      if (focus) set({ reasoningEffort: effort });
      if (conversationId) persistReasoningEffort(conversationId, effort);
    },
    setChatTarget: (target, scope) => {
      const { conversationId, focus } = resolveScope(scope);
      if (focus) set({ chatTarget: target });
      if (conversationId) {
        // persist* 会先乐观改清单：非焦点标签的下拉 / pill 立刻生效，不用等往返
        persistTarget(conversationId, target);
        // 已有会话就到这儿 —— 下面那段是"新对话页"才需要的草稿态处理
        if (!focus) return;
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
    setMcpServerIds: (ids, scope) => {
      const { conversationId, focus } = resolveScope(scope);
      if (focus) set({ mcpServerIds: ids });
      if (conversationId) persistMcp(conversationId, ids);
    },
    setBrowserSettings: (patch, scope) => {
      // 与当前值合并：调用方只给要改的那一项（如只翻总开关），再整体落库
      const { conversationId, focus } = resolveScope(scope);
      const next: BrowserSettings = {
        ...browserBase(focus, conversationId),
        ...patch,
      };
      if (focus) set({ browserSettings: next });
      if (conversationId) persistBrowserSettings(conversationId, next);
    },
  };
}
