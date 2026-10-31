/**
 * 消息级操作：依赖流式运行时（删完要按服务端那份重新拉），所以排在 run-loop 之后。
 */
import { errorMessage } from "@fizz/agent-kit/shared/lib/stores/shared";
import type { ConvRun } from "./context";

export function createMessageOps(ctx: ConvRun) {
  const { set, get, api, writeSlice, loadMessages } = ctx;

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
    removeMessages,
  };
}
