// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fizz/ui/dialog";
import { useT } from "@fizz/agent-kit/shared/lib/language";

/**
 * 待发送列表里的正文只显示一行：探「是不是真的溢出了」—— 只有溢出才让正文可点、
 * 弹出全文 Dialog。短消息也弹窗纯属噪音。
 *
 * 两个坑：
 * - 用 **callback ref** 而不是 effect + 普通 ref：溢出态一翻转，正文的渲染分支可能变
 *   （React 眼中父类型变了 → `<p>` 卸载重挂），挂在旧节点上的 ResizeObserver
 *   会一直观察一个已离开文档的元素，从此再也不更新。
 * - ResizeObserver 只看盒子尺寸，而 `truncate` 把宽度锁死一行：文本变了（高度
 *   没变）不会触发它，所以另有一个 `[text]` effect 兜底重探。
 */
function useTextClamped(text: string): {
  /** 挂到正文 `<p>` 上的 callback ref（节点换了就在新节点上重建观察） */
  ref: (el: HTMLParagraphElement | null) => void;
  clamped: boolean;
} {
  const elRef = useRef<HTMLParagraphElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [clamped, setClamped] = useState(false);
  const check = useCallback((): void => {
    const el = elRef.current;
    if (!el) return;
    // 两个轴都要看：这两张列表的正文早先是 `line-clamp-3`（高溢出），后来改成**一行
    // `truncate`**（宽溢出）。只探高度的话一行截断永远判成「没截断」。
    // 2px 容差：亚像素 rounding 下溢出量可能只有 1。
    const overflowY = el.scrollHeight - el.clientHeight > 2;
    const overflowX = el.scrollWidth - el.clientWidth > 2;
    setClamped(overflowY || overflowX);
  }, []);
  const ref = useCallback(
    (el: HTMLParagraphElement | null) => {
      elRef.current = el;
      roRef.current?.disconnect();
      roRef.current = null;
      if (!el) return;
      check();
      const ro = new ResizeObserver(check);
      ro.observe(el);
      roRef.current = ro;
    },
    [check],
  );
  useEffect(() => {
    check();
  }, [text, check]);
  useEffect(() => () => roRef.current?.disconnect(), []);
  return { ref, clamped };
}

/**
 * 待发送列表里的正文：默认一行截断；**溢出时点击正文弹 Dialog 看全文**。
 *
 * 不再就地展开：两张列表的容器是固定高度 + 内部滚动，展开会把相邻条目挤走；
 * 手机上也没有 hover，Tooltip 指望不上。Dialog 阅读区独立滚动，不会顶高输入框。
 */
export function ExpandableRowText({
  text,
  className,
}: {
  text: string;
  /** 字号 / 颜色由调用方给（队列是 `text-sm`，插话是 `text-xs`） */
  className?: string;
}) {
  const t = useT();
  const { ref, clamped } = useTextClamped(text);
  const [open, setOpen] = useState(false);
  return (
    <>
      <p
        ref={ref}
        // 与聊天正文同性质的内容，要能选中
        data-selectable
        role={clamped ? "button" : undefined}
        tabIndex={clamped ? 0 : undefined}
        onClick={clamped ? () => setOpen(true) : undefined}
        onKeyDown={
          clamped
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setOpen(true);
                }
              }
            : undefined
        }
        className={cn(
          "min-w-0 flex-1 truncate",
          clamped && "cursor-pointer hover:text-foreground",
          className,
        )}
      >
        {text}
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("消息内容")}</DialogTitle>
          </DialogHeader>
          <div
            data-selectable
            className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words text-sm"
          >
            {text}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
