// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { Paperclip, Pencil, SendHorizontal, X } from "lucide-react";
import { useCallback } from "react";
import { useConfirm } from "@fizz/agent-kit/shared/components/ConfirmProvider";
import { fileRefsOfParts } from "@fizz/agent-kit/shared/lib/attachments";
import { textOf } from "@fizz/agent-kit/shared/lib/parts";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { SortableRow } from "@fizz/agent-kit/shared/components/SortableRow";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { type AgentChatMessage } from "@fizz/contracts/types";
import { ExpandableRowText } from "@fizz/agent-kit/features/chat/ExpandableRowText";
import { RowIconButton } from "@fizz/agent-kit/features/chat/RowIconButton";

/**
 * 插话列表的拖拽类型：与队列**刻意分开** —— 两种东西的排序意义不同（队列决定「本轮结束后
 * 依次发」的顺序，插话决定「下一个工具步骤边界谁先被消费」），跨列表拖拽没有语义，
 * 靠类型隔离让两张列表互不接受对方的拖拽。
 */
const STEER_ITEM_TYPE = "pending-steer";
/**
 * 插话（「插入中」）列表的一条：排序与按钮都与队列行**同一套**（同一个 `SortableRow`、
 * 同一个 `RowIconButton`）—— ➀ 立刻发送（跑着时禁用，与队列同规则）、✎ 编辑写回输入框、
 * ✕ 移除。
 *
 * ➤ 的用处是「本轮已经结束（停止 / 报错）时把这条当新一轮发出去」：跑着时它的去处是
 * 「下个边界生效」，没有「立刻」这回事，所以那时禁用。
 *
 * 附件标识：插话也带附件（见 `SteerInput.files`），只有附件、没写文字的插话否则会显示成一句空话。
 */
export function SteerRow({
  item,
  canTouch,
  running,
  app,
  onEdit,
}: {
  item: AgentChatMessage;
  /** 触屏设备：HTML5 拖拽起不动，改由把手自己扛 */
  canTouch: boolean;
  /** 本轮是否在跑（➤ 立刻发送只在停下来的那一轮才有意义） */
  running: boolean;
  app: AgentApp;
  onEdit?: (item: AgentChatMessage) => void;
}) {
  const t = useT();
  const fileCount = fileRefsOfParts(item.parts).length;
  const body = textOf(item) || (fileCount > 0 ? t("（仅附件）") : t("（空消息）"));
  /** 移除前二次确认（同队列删除）：移除 = 这条既不会在边界注入、也不会被发出去，误点即丢 */
  const confirm = useConfirm();
  const onRemove = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t("移除这条插话？"),
      description: (
        <span className="whitespace-pre-wrap break-words">{body}</span>
      ),
      confirmLabel: t("移除"),
      destructive: true,
    });
    if (ok) await app.removeSteer(item.id);
  }, [app, body, confirm, item.id]);
  return (
    <SortableRow
      id={item.id}
      dragType={STEER_ITEM_TYPE}
      canTouch={canTouch}
      moveTo={(draggedId, beforeId) => app.moveSteer(draggedId, beforeId)}
    >
      <ExpandableRowText text={body} className="text-xs text-foreground" />
      {fileCount > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
          title={t("这条插话带了 {count} 个附件，会在边界与文字一起注入", { count: fileCount })}
        >
          <Paperclip className="size-3" />
          {fileCount}
        </span>
      ) : null}
      {/* ➤ 立刻发送：与队列同一颗钮、同一套禁用规则 —— 跑着时禁用（跑着时它的去处是
                「下个边界生效」，没有「立刻」这回事），停下来了才轮到它把这条当新一轮发出去 */}
      <RowIconButton
        onClick={() => app.sendSteer(item.id)}
        disabled={running}
        tip={
          running
            ? t("对话进行中：会在下个工具步骤边界注入当前轮")
            : t("立刻发送这一条（作为新一轮的普通消息）")
        }
        label={t("立刻发送这一条")}
        className={cn(
          "shrink-0 rounded p-1 transition-colors",
          running
            ? "cursor-not-allowed text-muted-foreground/50"
            : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        )}
      >
        <SendHorizontal className="size-3.5" />
      </RowIconButton>
      {onEdit ? (
        <RowIconButton
          onClick={() => onEdit(item)}
          tip={t("编辑并写回输入框（附件一起回显）")}
          label={t("编辑这条插话")}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <Pencil className="size-3.5" />
        </RowIconButton>
      ) : null}
      <RowIconButton
        onClick={() => void onRemove()}
        tip={t("移除（还没生效：不再发给 agent，也不再发出去）")}
        label={t("移除这条插话")}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="size-3.5" />
      </RowIconButton>
    </SortableRow>
  );
}
