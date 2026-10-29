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
  const { get, api, readSlice, writeSlice } = ctx;

  return {
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
}
