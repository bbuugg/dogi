/**
 * action 层：queue。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import type { QueuedMessage } from "@fizz/contracts/types";
import { textOf } from "@fizz/agent-kit/shared/lib/parts";
import { fileRefsOfParts } from "@fizz/agent-kit/shared/lib/attachments";
import { nextLocalId } from "@fizz/agent-kit/shared/lib/stores/shared";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createQueueActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "enqueueMessage" | "removeQueuedMessage" | "updateQueuedMessage" | "moveQueuedMessage" | "moveQueuedMessageBy" | "sendQueuedMessage" | "sendSteer" | "clearQueuedMessages" | "removeSteer" | "moveSteer" | "moveSteerBy"
> {
  const { get, api, readSlice, writeSlice, syncSteerOrder, patchQueue, runRound } = ctx;

  return {
    // ---------- 发一轮 ----------
    enqueueMessage: (text, files, scope) => {
      // 分屏时排队也要排到本标签的会话：`send` 会把本标签的会话 id 传进来
      const conversationId = scope === undefined ? get().activeConversationId : scope;
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
  };
}
