/**
 * action 层：approvals。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import { errorMessage } from "@fizz/agent-kit/shared/lib/stores/shared";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createApprovalsActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "resolveConfirm" | "resolveFollowup"
> {
  const { get, api, readSlice, writeSlice, resolveConvId } = ctx;

  return {
    // ---------- 审批 / 提问 ----------
    resolveConfirm: async (id, approved, optionId, scope) => {
      /**
       * 乐观撤掉**本会话**的卡片。分屏时审批卡可能出现在非焦点标签上（每个标签都渲染
       * 自己那条会话的 `pendingConfirms`），按活跃会话撤会撤空、卡片留在屏幕上不消失。
       */
      const conversationId = resolveConvId(scope);
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
    resolveFollowup: async (toolCallId, answer, scope) => {
      // 与审批同一立场：按本标签的会话取题、撤卡（分屏时非焦点标签也会渲染提问卡）
      const conversationId = resolveConvId(scope);
      const req = conversationId
        ? readSlice(conversationId).followupRequests[toolCallId]
        : undefined;
      if (req && conversationId) {
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
}
