// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@fizz/ui/select";
import { CHAT_ICON_PILL } from "@fizz/agent-kit/features/chat/composer";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/** ACP 权限答复档的中文名（pill 的 tooltip / aria 用） */
const ACP_PERMISSION_LABELS = {
  confirm: "确认（逐次询问）",
  allow: "完全放行（不再询问）",
} as const;

/**
 * ACP 会话的「权限答复」pill（复用内置权限 pill 的位置与外观；**两档**）。
 *
 * - **确认**（缺省）：agent 每次发 `session/request_permission` 都弹确认卡，由你挑；
 * - **完全放行**：服务端在应用层直接替用户答复「允许」（挑 agent 给的 allow_always →
 *   allow_once），确认卡根本不会出现。
 *
 * 按**会话**记住（存会话配置，换会话要重选）。一轮运行中切换也有效：服务端在每次
 * `session/request_permission` 到来时现取会话当前的模式，所以切到「完全放行」后
 * **本轮后续**的权限请求就不再弹卡（已经挂起等答复的那一张除外）。
 * ⚠️ ACP 没有运行时可设的「权限等级」：agent 自己配成 `deny` 时它根本不发请求，放宽无从谈起
 * —— `allow` 只是把它的 **ask** 变成放行。
 */
export function AcpPermissionPill({ app }: { app: AgentApp }) {
  const t = useT();
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  if (!conversation || conversation.backend !== "acp") return null;
  const mode: "confirm" | "allow" =
    conversation.acpPermissionMode === "allow" ? "allow" : "confirm";
  return (
    <Select
      value={mode}
      onValueChange={(v) => app.setAcpPermissionMode(v as "confirm" | "allow")}
    >
      <SelectTrigger
        className={CHAT_ICON_PILL}
        icon={false}
        aria-label={t("权限答复：{label}", { label: t(ACP_PERMISSION_LABELS[mode]) })}
      >
        {/* mx-auto 居中：SelectTrigger 自带 justify-between，单个子元素会被顶到左边 */}
        <span className="mx-auto flex items-center">
          {mode === "allow" ? (
            <ShieldAlert className="size-3.5 text-amber-600 dark:text-amber-500" />
          ) : (
            <ShieldCheck className="size-3.5 text-muted-foreground" />
          )}
        </span>
      </SelectTrigger>
      <SelectContent position="popper" side="top" align="start" sideOffset={6}>
        <SelectItem value="confirm">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="size-3.5 text-muted-foreground" />
            <span>{t("确认（逐次询问）")}</span>
          </span>
        </SelectItem>
        <SelectItem value="allow">
          <span className="flex items-center gap-1.5">
            <ShieldAlert className="size-3.5 text-amber-600 dark:text-amber-500" />
            <span>{t("完全放行（不再询问）")}</span>
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
