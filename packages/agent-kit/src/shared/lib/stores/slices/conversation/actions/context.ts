/**
 * action 层：上下文压缩。叶子层 —— 只经 `get()` 互调 action，内部助手一律从 ctx 拿。
 *
 * ## 为什么这两个从 `CoreSlice` 搬过来
 *
 * 它们看着像「全局杂项」（一个提示条、一个转圈标志），实际都**绑定在某一条会话**上：
 * 压缩的是那条会话的上下文，提示说的是那条会话发生了什么。住在全局的结果是分屏时
 * A 标签压缩，B 标签跟着闪提示、圆环跟着转 —— 与「模型 pill 一起变」同一个根因
 * （「焦点会话的现场」冒充全局）。现在它们是 `ConvSlice` 的字段，一人一份。
 */
import type { ContextNotice, ConversationSlice } from "../types";
import type { ConvInternals } from "../internals/context";

/** 提示条挂多久：它是「刚刚发生了什么」，不该一直占着位置 */
const NOTICE_TTL_MS = 8000;

export function createContextActions(
  ctx: ConvInternals,
): Pick<ConversationSlice, "setContextNotice" | "compressContextNow"> {
  const { set, get, readSlice, writeSlice, resolveConvId } = ctx;

  /**
   * 每条会话一个自动消失的定时器。用 Map 而不是一个变量：分屏时两条会话的提示条
   * 各有各的倒计时，后一条不该把前一条的定时器清掉。
   */
  const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearNoticeTimer = (conversationId: string): void => {
    const pending = noticeTimers.get(conversationId);
    if (!pending) return;
    clearTimeout(pending);
    noticeTimers.delete(conversationId);
  };

  return {
    setContextNotice: (notice, scope) => {
      const conversationId = resolveConvId(scope);
      // 没有会话（新对话页）就没有「谁的上下文」，不记
      if (!conversationId) return;
      writeSlice(conversationId, (s) => ({ ...s, contextNotice: notice }));
      clearNoticeTimer(conversationId);
      if (!notice) return;
      noticeTimers.set(
        conversationId,
        setTimeout(() => {
          noticeTimers.delete(conversationId);
          writeSlice(conversationId, (s) => ({ ...s, contextNotice: null }));
        }, NOTICE_TTL_MS),
      );
    },

    compressContextNow: async (scope) => {
      const conversationId = resolveConvId(scope);
      if (!conversationId) return { ok: false, reason: "没有打开的会话" };
      if (readSlice(conversationId).contextCompressing)
        return { ok: false, reason: "压缩正在进行中" };
      const api = get().getApi();
      if (!api) return { ok: false, reason: "还没有连接到服务端" };
      writeSlice(conversationId, (s) => ({ ...s, contextCompressing: true }));
      try {
        /**
         * 压缩过程与自动压缩共用同一套 SSE 事件：`handleFrame` 收到
         * `context-compaction-*` 后会在会话末尾渲染同一个折叠块（没有 assistantId =
         * 不绑定到某条助手消息；见 `MessageList` 的 trailing compaction）。
         */
        const res = await api.compressContext(conversationId, (event) => {
          get().handleFrame(conversationId, "", {
            type: "event",
            requestId: "",
            event,
          });
        });
        if (res.ok && res.summary) {
          // 本地先同步检查点（即时反馈）；WS 的标脏推送随后会带同一份真值
          const summary = res.summary;
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === conversationId ? { ...c, contextSummary: summary } : c,
            ),
          }));
          return { ok: true };
        }
        // 没有可压缩的部分：把可能已经冒出来的流式块收掉
        get().handleFrame(conversationId, "", { type: "end", requestId: "" });
        return { ok: false, reason: res.reason ?? "压缩未执行" };
      } catch (err) {
        // 摘要失败 / 中止：不留下半份流式文档（检查点也不会落）
        get().handleFrame(conversationId, "", { type: "end", requestId: "" });
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      } finally {
        writeSlice(conversationId, (s) => ({ ...s, contextCompressing: false }));
      }
    },
  };
}

/** 提示条刚出现时的形状由 SSE 帧给出，这里只做一次类型导出方便 UI 侧引用 */
export type { ContextNotice };
