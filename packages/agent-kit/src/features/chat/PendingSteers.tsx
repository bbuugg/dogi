// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { Zap } from "lucide-react";
import { type ReactNode } from "react";
import { supportsTouch } from "@fizz/agent-kit/shared/lib/supports-touch";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@fizz/ui/tooltip";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { type AgentChatMessage } from "@fizz/contracts/types";
import { SteerRow } from "@fizz/agent-kit/features/chat/SteerRow";
import { LIST_HEIGHT_CLASS } from "@fizz/agent-kit/features/chat/queue-list";

/**
 * 插入中（steer）的插话：POST 成功到 agent 消费之间挂在收件箱里，这里可视化出来。
 *
 * 每条可编辑（✎，与队列编辑同款：写回输入框 + 移出收件箱，见 `onEditSteer`）、**可排序**
 * （与队列同一套 `SortableRow`：抓左侧把手拖 —— 顺序就是边界消费顺序）、
 * 本轮停下来之后还能 **➤ 立刻发送**（见 `sendSteer`）或 ✕ 移除。
 *
 * agent 在下一个工具步骤边界消费时，消息经 `user-injected` 事件转正进会话流、从这里出列。
 * ⚠️ 所以「插入中」这个标题只在**本轮在跑**时成立；本轮已结束（用户停止 / 失败）时服务端
 * 收件箱已经没了，列表改叫「未发出」——留在这里的是没生效的插话，等用户处置。
 */
export function PendingSteers({
  app,
  onEdit,
}: {
  app: AgentApp;
  /** 点「编辑」：把整条交给调用方（写回输入框 + 撤回收件箱 + 记编辑态）；不传则不渲染 ✎ */
  onEdit?: (item: AgentChatMessage) => void;
}): ReactNode {
  const t = useT();
  const items = app.pendingSteers;
  if (items.length === 0) return null;
  // 排序能力判定与队列一致：触屏上 HTML5 拖拽起不动，那些设备由把手自己扛指针事件（见 SortableRow）
  const canTouch = supportsTouch();
  // 头部文案随「本轮是否在跑」切换，与队列同一套做法：跑着 = 会在边界生效；
  // 没跑 = 这些插话已经不会再生效（服务端收件箱随 run 消失），只能立刻发出去或移除
  const running = app.streaming;
  return (
    <div className="flex flex-col border-b border-border px-3 py-2">
      <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Zap className="size-3.5" />
            <span className="min-w-0 flex-1">
              {running
                ? t("插入中 · {count} 条（下个步骤边界生效，agent 正在跑的这一轮内）", { count: items.length })
                : t("未发出 · {count} 条（本轮已结束，可挑一条立刻发出去）", { count: items.length })}
            </span>
            <span className="shrink-0">{t("拖动左侧把手可调整顺序")}</span>
          </span>
      {/* 固定高度 + 内部滚动：与队列列表同一套尺寸，条数再多也不顶高输入框 */}
      <div
        className={cn(
          LIST_HEIGHT_CLASS,
          "overflow-y-auto overscroll-contain pr-0.5",
        )}
      >
        {items.map((item) => (
          <SteerRow
            key={item.id}
            item={item}
            canTouch={canTouch}
            running={running}
            app={app}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  );
}
