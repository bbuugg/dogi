/**
 * action 层：local-state。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import { clearAllQueues } from "../storage";
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
      set({ slices: {} });
    },

  };
}
