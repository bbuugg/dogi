// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@fizz/ui/button";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/**
 * 会话历史加载失败（内置 拉存档 / acp session/load 回放）：消息列表处展示错误 + 重试。
 * 不再像以前那样静默吞掉变成「历史丢了」—— 把 agent 侧（OpenCode 等）报的错亮出来，
 * 让用户一键重试。重试只是重跑同一段装载逻辑，不再走 openConversation 的 id 去重早退。
 */
export function MessagesLoadError({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  const t = useT();
  const [retrying, setRetrying] = useState(false);
  const retry = (): void => {
    setRetrying(true);
    // 重试会先点亮 loading；无论成败都在下一帧把按钮复位
    void Promise.resolve(onRetry()).finally(() => setRetrying(false));
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
        <AlertTriangle className="size-9 text-destructive/70" />
        <div className="text-sm font-medium">{t("会话加载失败")}</div>
        <div className="text-xs leading-5 text-muted-foreground break-words">
          {error}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={retry}
          disabled={retrying}
        >
          {retrying ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RotateCcw className="size-4" />
          )}
          {t("重试")}
        </Button>
      </div>
    </div>
  );
}
