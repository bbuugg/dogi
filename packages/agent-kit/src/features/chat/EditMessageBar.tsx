// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { Pencil, X } from "lucide-react";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/**
 * 编辑重发的提示条：渲染在输入框卡片内（`header` 槽位），排在待发送队列上面。
 *
 * 为什么要这条：点「编辑并重发」原来只是把文本灌进输入框，输入框和平时一模一样 ——
 * 用户分不清「这是我新写的一句」还是「我在改上面那条」。而重发会**删掉本条及其后的全部
 * 消息**（误发不可逆），所以必须把「在编辑哪条 + 会连带删掉什么」摆在眼前：
 * - 标题写明是编辑、并说明重发会删掉后续；
 * - 引原文（用户改过草稿后仍能认出是哪条），空消息兜底成占位文案；
 * - 取消钮退出编辑态（顺带清掉输入框里的草稿，见 `ChatPanelInner` 的 `cancelEdit`）。
 */
export function EditMessageBar({
  text,
  onCancel,
}: {
  text: string;
  onCancel?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-start gap-2 border-b border-border bg-muted/40 px-3 py-2">
      <Pencil className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">
          {t("编辑消息 · 重发将删除本条及其后的消息")}
        </div>
        <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {text || t("（空消息）")}
        </p>
      </div>
      <button
        type="button"
        title={t("取消编辑")}
        aria-label={t("取消编辑")}
        onClick={onCancel}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
