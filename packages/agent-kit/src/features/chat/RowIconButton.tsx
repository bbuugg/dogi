// 从 `ChatPanel.tsx` 抽出（原文件太大，按「一块视图一个文件」拆开）。
import { type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@fizz/ui/tooltip";

/**
 * 待发送列表（队列 / 插话）行里的图标按钮：外观照旧（半透明小图标，hover 所在行才变亮），
 * 提示从原生 `title` 换成设计系统的 Tooltip（`./ui/tooltip`，Provider 挂在外壳 AppShell 上）。
 *
 * 为什么不用原生 `title`：
 * 1. Chrome 要悬停满一秒才冒字，而队列按钮只有十七八个像素，鼠标一晃就过去，形同虚设；
 *    应用别处（侧栏 / 面板 / 消息操作栏）全是秒出的 Radix 提示，队列慢一截显得像坏了；
 * 2. 禁用态的按钮浏览器不派发指针事件，原生 title 在禁用按钮上干脆不显示 ——
 *    「对话进行中，本轮结束后会自动发送」这句话偏偏只在禁用态说，最该看见时反而没有。
 *
 * 第 2 条对 Radix 一样成立（hover 不到禁用元素），所以禁用时外面套一层 span 当提示的
 * 挂载点：span 照常收指针事件，`inline-flex shrink-0` 占的格子和原来按钮一致。
 */
export function RowIconButton({
  tip,
  onClick,
  disabled = false,
  label,
  className,
  children,
}: {
  /** 悬停提示 */
  tip: string;
  onClick: () => void;
  /** 禁用（到头 / 到尾的 ↑↓、对话进行中的「现在发」） */
  disabled?: boolean;
  /** 读屏标签（原生 title 撤了，可访问性别跟着丢） */
  label: string;
  className?: string;
  children: ReactNode;
}): ReactNode {
  const button = (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
      className={className}
    >
      {children}
    </button>
  );
  // 禁用按钮上把 trigger 挪到包裹的 span（见上面注释第 2 条）
  const trigger = disabled ? (
    <span className="inline-flex shrink-0">{button}</span>
  ) : (
    button
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}
