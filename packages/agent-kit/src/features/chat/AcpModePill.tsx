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
import { CHAT_ICON_PILL } from "@fizz/agent-kit/features/chat/composer";
import { IconTip } from "@fizz/agent-kit/shared/components/IconTip";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/**
 * acp 会话的「模式」pill（**只有 opencode 风格**才显示，摆在模型选择器之后）。
 *
 * 数据来自**会话配置**（`conversation.acpModes`）：agent 广告的模式（规范 Session Modes
 * 或 configOptions 的 `category:'mode'`，opencode 是后者 = build / plan），服务端写回会话；
 * 不再像以前那样自己拉接口（进程没起来时拉不到、且与「agent 没有模式」分不清）。
 * 切换走 `setAcpAgentMode`（按通道走 `session/set_mode` 或 `session/set_config_option`），
 * store 乐观更新会话、失败回滚；服务端持久化后经 WS 推回权威快照。
 *
 * ⚠️ 它**不是**内置 agent 那种「权限档」：ACP 没有运行时可设的权限等级，模式语义全由 agent
 * 定义（opencode 的 plan = 禁编辑工具；权限策略在它自己的配置文件里）。所以这里叫中性的「模式」，
 * 名字 / 描述原样用 agent 给的。
 *
 * 语义由**设置里的 agent 类型**决定（见 `AcpAgentType`）：opencode 显示模式 pill；
 * pi 的思考档在 configOptions 里（见 `AcpThoughtLevelSelect`）；generic 不显示任何模式 UI。
 * 没有模式就整个不渲染 —— **不做中性 pill**。
 */
export function AcpModePill({ app }: { app: AgentApp }) {
  const t = useT();
  const [switching, setSwitching] = useState(false);
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  /**
   * 新任务页（还没有会话）：档位来自**探测**（`draftAcp`），选择先记在草稿上，
   * 会话建好时由 `newConversation` 统一下发 —— 没有会话可读，只能先问 agent。
   */
  const draft =
    !conversation && app.chatTarget?.backend === "acp" ? app.draftAcp : null;
  const agentId =
    conversation?.backend === "acp" ? conversation.configId : draft?.agentId;
  const agent = agentId
    ? app.acpAgents.find((a) => a.id === agentId)
    : undefined;
  const modes = conversation?.acpModes ?? draft?.modes ?? undefined;
  const currentId = (draft ? draft.mode : null) ?? modes?.current ?? null;
  const isOpencode = agent?.type === "opencode";
  /**
   * ⚠️ 占位必须挂在「数据还没回来」而不是「探针在跑」上：`probeDraftAcp` 切到**别的
   * agent** 时会先把 `modes` 清空、`loading` 置真（正确：旧 agent 的档位不能顶着新
   * agent 的名字显示）。但如果只在 loading 时占位，切回来的那一下数据虽已在内存
   * （`draftAcpCache`，秒回），`loading` 仍会闪一帧真 -> 空 -> 真，pill 跟着闪。
   * 挂到 `modes` 上：缓存命中时第一帧就有数据、pill 原地不变；真没数据才转圈。
   * 也就顺带盖住「切走再切回同一个 agent、探针还在飞」那种空窗。
   */
  if (isOpencode && !draft && !modes) return null;
  if (isOpencode && draft && !modes) {
    return (
      <IconTip label={t("正在读取这个外部 Agent 的模式…")}>
        <button type="button" disabled className={CHAT_ICON_PILL} aria-busy>
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        </button>
      </IconTip>
    );
  }
  if (
    !agent ||
    agent.type !== "opencode" ||
    !modes ||
    !modes.available.length
  ) {
    return null;
  }
  const currentMode = modes.available.find((m) => m.id === currentId);

  const select = async (modeId: string): Promise<void> => {
    if (switching) return;
    // 还没有会话：只记在草稿上（建会话时下发）
    if (!conversation) {
      app.setDraftAcpMode(modeId);
      return;
    }
    setSwitching(true);
    const res = await app.setAcpAgentMode(agent.id, conversation.id, modeId);
    setSwitching(false);
    if (!res.ok) toast.error(t("切换权限档失败：{error}", { error: res.error ?? t("未知错误") }));
  };

  return (
    <DropdownMenu>
      <IconTip
        label={
          currentMode
            ? t("模式：{name}（由外部 Agent 提供，可切换）", { name: currentMode.name ?? currentMode.id })
            : t("模式（由外部 Agent 提供，可切换）")
        }
      >
        <DropdownMenuTrigger asChild>
          {/* 触发器只放图标（与权限 pill 同款）：档位名由 agent 自定义，进下拉看打勾 + tooltip */}
          <button
            type="button"
            className={CHAT_ICON_PILL}
            aria-label={currentMode ? t("模式：{name}", { name: currentMode.name ?? currentMode.id }) : t("模式")}
          >
            {switching ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </button>
        </DropdownMenuTrigger>
      </IconTip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="min-w-56"
      >
        {modes.available.map((mode) => (
          <DropdownMenuItem
            key={mode.id}
            title={mode.description ?? mode.name ?? mode.id}
            onSelect={() => void select(mode.id)}
          >
            <span className="truncate">{mode.name ?? mode.id}</span>
            {mode.id === currentId && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
