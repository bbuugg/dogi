// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { Check, Loader2, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fizz/ui/dropdown-menu";
import { CHAT_ICON_PILL, CHAT_PILL } from "@fizz/agent-kit/features/chat/composer";
import { IconTip } from "@fizz/agent-kit/shared/components/IconTip";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/**
 * acp 会话的「思考档」pill（**只有 pi 风格**才显示，摆在模型选择器之后）。
 *
 * `pi` 用 configOptions 的 `thought_level` 表达思考档（不是 Session Modes），数据同样来自
 * 会话配置（`conversation.acpThoughtLevel`）；切换走 `setAcpThoughtLevel`
 * （`session/set_config_option`）。没有思考档就整个不渲染。
 */
export function AcpThoughtLevelSelect({ app }: { app: AgentApp }) {
  const t = useT();
  const [switching, setSwitching] = useState(false);
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  /** 新任务页：档位来自探测的 `draftAcp`，选择先记草稿、建会话时下发（同 `AcpModePill`） */
  const draft =
    !conversation && app.chatTarget?.backend === "acp" ? app.draftAcp : null;
  const agentId =
    conversation?.backend === "acp" ? conversation.configId : draft?.agentId;
  const agent = agentId
    ? app.acpAgents.find((a) => a.id === agentId)
    : undefined;
  const thought =
    conversation?.acpThoughtLevel ?? draft?.thoughtLevel ?? undefined;
  // 同 `AcpModePill`：占位挂在「数据还没回来」上（不是 loading）—— 缓存命中时切回来
  // 第一帧就有档位，pill 原地不动，不会闪一下转圈
  const isPi = agent?.type === "pi";
  if (isPi && !draft && !thought) return null;
  if (isPi && draft && !thought) {
    return (
      <IconTip label={t("正在读取这个外部 Agent 的思考档…")}>
        <button type="button" disabled className={CHAT_ICON_PILL} aria-busy>
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        </button>
      </IconTip>
    );
  }
  if (!agent || agent.type !== "pi" || !thought || !thought.options.length)
    return null;
  const currentValue = (draft ? draft.thought : null) ?? thought.current;
  const current = thought.options.find((o) => o.value === currentValue);

  const select = async (value: string): Promise<void> => {
    if (switching) return;
    if (!conversation) {
      app.setDraftAcpThought(value);
      return;
    }
    setSwitching(true);
    const res = await app.setAcpThoughtLevel(agent.id, conversation.id, value);
    setSwitching(false);
    if (!res.ok) toast.error(t("切换思考档失败：{error}", { error: res.error ?? t("未知错误") }));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={CHAT_PILL}
          aria-label={t("思考档：{name}", { name: current?.name ?? t("默认") })}
          title={t("思考档：{name}（由外部 Agent 提供，session/set_config_option 切换）", { name: current?.name ?? t("默认") })}
        >
          {switching ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{current?.name ?? t("思考档")}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        className="min-w-56"
      >
        {thought.options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            title={option.description ?? option.name}
            onSelect={() => void select(option.value)}
          >
            <span className="truncate">{option.name}</span>
            {option.value === currentValue && (
              <Check className="ml-auto size-3.5" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
