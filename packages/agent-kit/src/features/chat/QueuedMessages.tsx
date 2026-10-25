// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { Clock } from "lucide-react";
import { useCallback } from "react";
import { useConfirm } from "@fizz/agent-kit/shared/components/ConfirmProvider";
import { supportsTouch } from "@fizz/agent-kit/shared/lib/supports-touch";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { type QueuedMessage } from "@fizz/contracts/types";
import { QueuedRow } from "@fizz/agent-kit/features/chat/QueuedRow";
import { LIST_HEIGHT_CLASS } from "@fizz/agent-kit/features/chat/queue-list";

export function QueuedMessages({
  app,
  onEdit,
}: {
  app: AgentApp;
  /** 点「编辑」：把这条（文本 + 附件）写回输入框，由调用方负责移出队列 */
  onEdit: (item: QueuedMessage) => void;
}) {
  const t = useT();
  const items = app.queuedMessages;
  const running = app.streaming;
  // 触屏上 HTML5 拖拽起不动：那些设备改由把手自己扛指针事件（见 QueuedRow / SortableRow）
  const canTouch = supportsTouch();
  const confirm = useConfirm();
  /**
   * 「清空队列」也要二次确认：它一次丢掉**全部**未发送的消息（含附件），且不可撤销 ——
   * 恰恰是那排里最容易误点的一个按钮（就挨着「继续发下一条」）。
   */
  const onClear = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t("清空队列里的 {count} 条消息？", { count: items.length }),
      description: t("这些都还没发出去，清空后就没了。"),
      confirmLabel: t("清空"),
      destructive: true,
    });
    if (ok) app.clearQueuedMessages();
  }, [app, confirm, items.length]);
  /**
   * ⚠️ 这个提前返回**必须放在所有 Hook 之后**。
   *
   * 之前它写在 `useConfirm` / `useCallback` 之前：队列从 0 条变 1 条时，这次渲染
   * 突然比上一次多跑了两个 Hook，React 直接抛 "Rendered more hooks than during the
   * previous render"；反过来删掉最后一条 / 点「编辑」把它移出队列时又少跑两个 Hook，
   * 抛 "Rendered fewer hooks than expected"。两者都没有 ErrorBoundary 兜底 ——
   * 整个应用白屏，刷新后队列已有数据、Hook 数从首帧就稳定，于是「刷新就正常」。
   * 功能上「没消息就什么都不渲染」不变，只是把返回挪到 Hook 后面。
   */
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col border-b border-border px-3 py-2">
      {/* 队列是干什么的：常显只留一句短的，完整语义放悬停提示（见下面 TooltipContent） */}
      <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5" />
        <span className="min-w-0 flex-1">{t("待发送 · {count} 条", { count: items.length })}</span>
      </span>
      {/* 失败停链提示（spec §3）：上一轮失败后队列静默停住没人知道，这里把状态
        挑明，并把「继续 / 清空」两个决定递到用户手边 */}
      {app.queuePausedReason === "failed" && (
        <div className="mb-1 flex items-center gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <span className="min-w-0 flex-1 truncate">{t("上轮失败，队列已暂停")}</span>
          <button
            type="button"
            disabled={running}
            onClick={() => app.pump()}
            className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("继续发下一条")}
          </button>
          <button
            type="button"
            onClick={() => void onClear()}
            className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-destructive/15"
          >
            {t("清空队列")}
          </button>
        </div>
      )}
      {/*
        固定高度 + 内部滚动：条数再多也不顶高输入框。
        `overscroll-contain`：滚到边界时别把页面 / 消息列表一起牵着滚（手机上很明显）。
      */}
      <div
        className={cn(
          LIST_HEIGHT_CLASS,
          "overflow-y-auto overscroll-contain pr-0.5",
        )}
      >
        {items.map((item) => (
          <QueuedRow
            key={item.id}
            item={item}
            running={running}
            canTouch={canTouch}
            app={app}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  );
}
