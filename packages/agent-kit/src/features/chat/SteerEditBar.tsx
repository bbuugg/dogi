// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { X, Zap } from "lucide-react";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/**
 * 编辑插话的提示条：结构与 `EditMessageBar` 同款，语义不同 —— 点 ✎ 时这条插话**已经
 * 移出收件箱**（agent 看不到了），发送后走 `steer` 重新插回当前轮（跑完则回落普通发送）。
 */
export function SteerEditBar({
  text,
  onCancel,
}: {
  text: string;
  onCancel?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-start gap-2 border-b border-border bg-muted/40 px-3 py-2">
      <Zap className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">
          {t("编辑插话 · 发送后重新插回当前轮")}
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
