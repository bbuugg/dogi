/**
 * action 层：local-state。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import { clearAllQueues } from "../storage";
import { emptyDraftSettings } from "../state";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createLocalStateActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "clearAllLocalState"
> {
  const { set } = ctx;

  return {
    clearAllLocalState: () => {
      clearAllQueues();
      // 草稿页那份待定选择（模型 / MCP / 浏览器偏好）也要复位：登出后换个账号进来，
      // 草稿页不该还挂着上一个人选的模型
      set({ slices: {}, draftSettings: emptyDraftSettings() });
    },

  };
}
