"use client";

import { Badge } from "@fizz/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@fizz/ui/collapsible";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import type { ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  CopyIcon,
  Square,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { Button } from "@fizz/ui/button";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, useState } from "react";
import { CodeBlock } from "@fizz/agent-kit/shared/ai-elements/code-block";
import { Tooltip, TooltipContent, TooltipTrigger } from "@fizz/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fizz/ui/dialog";
import { useIsMobile } from "@fizz/agent-kit/shared/hooks/useIsMobile";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("not-prose my-1 w-full rounded-md", className)}
    {...props}
  />
);

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart["type"];
  state: ToolUIPart["state"];
  /** 头部明细（命令 / 主入参等）：紧跟工具名截断显示，悬停 Tooltip 立即看全文 */
  detail?: string;
  /**
   * 停掉这次工具调用（工具在飞的时候给的回调）：传了就渲染一颗停止钮，排在触发行右侧。
   *
   * ⚠️ 按钮**必须与 CollapsibleTrigger 平级**、不能塞进触发器里 ——
   * `input-available`（正在跑）时触发器是 `disabled` 的，塞进去按钮点不动。
   */
  onStop?: () => void;
  /** 停止钮文案（缺省「停止」） */
  stopLabel?: string;
  className?: string;
};

/**
 * 工具调用是否可以展开 —— 跑出结果（成功 / 失败 / 被拒绝）的当然可以；
 * **入参流式生成中**也放行：那时候卡片上正铺着「正在写的内容」（半截入参抠出来的文本），
 * 不给展开入口就什么都看不见了。
 *
 * 原来「未结束就不给点开」的顾虑是「展开一片没有输出的空壳」，而流式期内容区是
 * 实打实有东西的，不适用 —— 其余未结束状态（审批中 / 已答复 / 已收到完整入参但还没结果）
 * 照旧不给展开入口。
 */
const isSettled = (state: ToolUIPart["state"]) =>
  state === "output-available" ||
  state === "output-error" ||
  state === "output-denied" ||
  state === "input-streaming";

const getStatusBadge = (status: ToolUIPart["state"]) => {
  const labels: Record<ToolUIPart["state"], string> = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "approval-requested": "Awaiting Approval",
    "approval-responded": "Responded",
    "output-available": "Completed",
    "output-error": "Error",
    "output-denied": "Denied",
  };

  const icons: Record<ToolUIPart["state"], ReactNode> = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
    "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
    "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
    "output-error": <XCircleIcon className="size-4 text-red-600" />,
    "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  };

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {labels[status]}
    </Badge>
  );
};

/**
 * 明细的全文弹窗（触屏 / 窄窗口共用）。
 *
 * 触屏上 Radix Tooltip 永远打不开（没有 hover），所以明细本身在头部行里就能点，
 * 点开是能选中、能复制的全文弹窗；命令仍然紧跟在工具名后面，不再被挪到下一行。
 */
function DetailDialog({
  title,
  detail,
  open,
  onOpenChange,
}: {
  title?: string;
  detail: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tr = useT();
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    // 剪贴板可能不可用（非安全上下文 / 无权限）：弹窗里的文字仍可手动选中复制，不额外报错
    void navigator.clipboard.writeText(detail).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => undefined
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? tr("完整内容")}</DialogTitle>
          <DialogDescription>
            {tr("这次调用的完整内容（列表里被截断了），可选中或用下方按钮复制。")}
          </DialogDescription>
        </DialogHeader>
        <pre
          // 全局默认禁选（styles.css 的白名单制）：这块是要拿去复制 / 贴给别人的，显式放开
          data-selectable
          className="max-h-[60vh] overflow-auto rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap break-all"
        >
          {detail}
        </pre>
        <Button
          size="sm"
          variant="outline"
          className="w-fit justify-self-end"
          onClick={copy}
        >
          {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          {copied ? tr("已复制") : tr("复制")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  detail,
  onStop,
  stopLabel,
  ...props
}: ToolHeaderProps) => {
  const tr = useT();
  // 还没跑出结果（input-available / 审批中）时不给展开入口：箭头不渲染，
  // 触发器一并禁用（不然用户还能点开一个没有输出的空壳）。
  // 例外是 input-streaming（入参正在生成，内容区有真东西），判据见 isSettled。
  // 跑完之后由 Card 侧受控的 open 照旧只由用户点开。
  const settled = isSettled(state);
  /**
   * 触屏：明细仍紧跟工具名，但改成可点（点开全文弹窗，见 `DetailDialog`）；
   * 桌面端留在触发行里、悬停出 Tooltip。
   */
  const touch = useIsMobile();
  const [detailOpen, setDetailOpen] = useState(false);
  // inline-flex 而非 w-full justify-between：触发区只占内容宽度，箭头贴着标题文本，
  // 不被推到整行最右端。展开 = 箭头朝下，收起 = 朝右。
  //
  // ⚠️ 这里的 `group` 不能删：箭头的 `group-data-[state=open]:rotate-90` 要有祖先同时带
  // `group` 类和 `data-state` 才生效。Radix 的 Trigger 自己就带 `data-state`，
  // 所以把 `group` 挂在触发器上是最小范围的做法 —— 之前没有 `group`，箭头就永远朝右。
  //
  // 颜色 / 字重与 ReasoningTrigger（「思考了几秒」行）同一口径：整行 text-muted-foreground、
  // 常规字重，hover 整体提亮 —— 图标和标题都不带自己的颜色类，靠继承跟随 hover 变化。
  //
  // 明细（detail）用 min-w-0 truncate：工具名 shrink-0 不缩，空间不够时先截断明细，
  // 全文走 Tooltip（原生 title 要悬停一秒才出，这里 100ms）。
  // 头部外壳：触发行 + 可选的停止钮（平级，见 ToolHeaderProps.onStop 的说明）。
  /*
   * ⚠️ **不要**给触发器加原生 `disabled`：按钮一旦 disabled，浏览器会吞掉它内部所有
   * 子元素的 click —— 触屏上「点明细看完整命令」在 pending / 完成时能用、执行中却点不动
   * （`input-available` 正好是 !settled）。这里改成 aria-disabled + 自己吞掉点击：
   * `preventDefault()` 会让 Radix 的 composeEventHandlers 跳过 toggle
   * （见 @radix-ui/primitive），明细自己的 onClick 里 stopPropagation 不受影响。
   */
  const trigger = (
    <CollapsibleTrigger
      className={cn(
        "group flex min-w-0 max-w-full flex-col items-start gap-1 rounded-md text-left text-muted-foreground transition-colors hover:text-foreground",
        !settled && "cursor-default hover:text-muted-foreground",
        className
      )}
      {...props}
      aria-disabled={!settled}
      tabIndex={settled ? undefined : -1}
      onClick={(event) => {
        if (!settled) event.preventDefault();
      }}
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-2">
        <WrenchIcon className="size-4 shrink-0" />
        <span className="shrink-0 text-sm">
          {title ?? type.split("-").slice(1).join("-")}
        </span>
        {detail &&
          (touch ? (
            // 触屏没有 hover：明细仍在工具名后面，点它开全文弹窗。
            // 阻止冒泡，否则会同时触发卡片展开 / 收起。
            <span
              role="button"
              tabIndex={0}
              title={detail}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDetailOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                setDetailOpen(true);
              }}
              className="min-w-0 cursor-pointer truncate font-mono text-xs transition-colors hover:text-foreground"
            >
              {detail}
            </span>
          ) : (
            <Tooltip delayDuration={100}>
              <TooltipTrigger asChild>
                <span className="min-w-0 truncate font-mono text-xs">{detail}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[28rem] break-words">{detail}</TooltipContent>
            </Tooltip>
          ))}
        {getStatusBadge(state)}
        {settled && (
          <ChevronRightIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        )}
      </span>
    </CollapsibleTrigger>
  );
  const head = !onStop ? (
    trigger
  ) : (
    <div className="flex max-w-full items-center gap-2">
      {trigger}
      <Button
        size="sm"
        variant="outline"
        aria-label={stopLabel ?? tr("停止")}
        title={stopLabel ?? tr("停止")}
        className="h-6 shrink-0 gap-1 px-2 text-xs"
        onClick={onStop}
      >
        <Square className="size-3" />
        {stopLabel ?? tr("停止")}
      </Button>
    </div>
  );
  // 桌面端 DOM 一个字都不加（head 就是原来那两段之一）；触屏多一个全文弹窗
  if (!touch || !detail) return head;
  return (
    <>
      {head}
      <DetailDialog
        title={title}
        detail={detail}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolUIPart["output"];
  errorText: ToolUIPart["errorText"];
};

/**
 * 这段文本**真的是 JSON** 吗（决定代码块用哪套语法高亮）。
 *
 * ⚠️ 以前对所有字符串一律 `language="json"`：终端输出、构建日志这类纯文本被 JSON 语法
 * 逐字切开 —— 每个数字都变成独立的 token span（`/dev/vda1` → `/dev/vda` + `1`、
 * `x86_64` → `x` + `86` + `_` + `64`），满屏都是跳出来的数字，单词也断了。
 * 只有首字符是 `{` / `[` 且能 parse 的才算 JSON，其余按纯文本渲染。
 */
const looksLikeJson = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    // 纯文本不进 Shiki（`language` 的类型里只有真语言，没有 plain text）：
    // 直接铺等宽 pre —— 不高亮、不切词，也省掉一次异步高亮。
    // 是 JSON 的才交给 CodeBlock（见 looksLikeJson 的说明）。
    Output = looksLikeJson(output) ? (
      <CodeBlock code={output} language="json" />
    ) : (
      <pre className="m-0 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-sm">
        {output}
      </pre>
    );
  }

  return (
    <div className={cn("space-y-2 p-4", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div className="py-2 px-3">{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
