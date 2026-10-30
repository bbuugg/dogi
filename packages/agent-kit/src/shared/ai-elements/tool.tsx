"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@fizz/ui/collapsible";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { REVEAL_ON_HOVER_ARROW } from "@fizz/agent-kit/shared/lib/hover-reveal-arrow";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import type { ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  CopyIcon,
  Loader2Icon,
  Square,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { Button } from "@fizz/ui/button";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, useEffect, useState } from "react";
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
   * 工具名右侧的**运行态**（子任务的「运行中 · 正在读文件 · 已调用 N 个工具」等）。
   *
   * 与 `detail` 并列、排在明细之前：运行态要一眼可见，不该被挤到卡片内容区里当正文。
   */
  status?: ReactNode;
  /**
   * 停掉这次工具调用（工具在飞的时候给的回调）：传了就渲染一颗停止钮，排在触发行右侧。
   *
   * ⚠️ 按钮**必须与 CollapsibleTrigger 平级**、不能塞进触发器里 ——
   * `input-available`（正在跑）时触发器是 `disabled` 的，塞进去按钮点不动。
   */
  onStop?: () => void;
  /** 停止钮文案（缺省「停止」） */
  stopLabel?: string;
  /**
   * 这一条是不是**本轮直播里还在跑**（所属消息仍在流式）。
   *
   * 只有它为真时，运行态才画成转圈的 loading。历史里因异常中断残留的未结算 part
   * （用户停止 / 断线 / 进程被杀）也停在 `input-streaming` / `input-available`，
   * 给它们转圈等于在说「它还在跑」—— 所以那两档在非直播时退回静态图标。
   *
   * 缺省 true：自造头部的调用方（插件面板等）不必关心这个区别。
   */
  live?: boolean;
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

/**
 * 工具行的**运行态图标**：只一颗图标，**不带文案、不带底色**。
 *
 * - 去掉文案：这一行已经挤了工具名 + 明细（命令 / 路径），再挂一段 "Running" / "Completed"
 *   会把明细先挤断，而图标本身已经把状态说清楚了。
 * - 去掉底色：以前套在 `<Badge variant="secondary">` 里，那块灰底在暗色主题下比工具名还重，
 *   而状态是**次要信息**，不该抢戏。
 *
 * 图标自身的语义色保留（绿=完成 / 红=出错 / 黄=等审批），那是唯一还在传递状态的东西。
 *
 * ⚠️ 这张表只放**结算 / 审批**两类的静态图标；「还在跑」那两档由 `statusIcon` 换成转圈的
 * loading，见那里的说明。
 */
const STATUS_ICONS: Record<ToolUIPart["state"], ReactNode> = {
  "input-streaming": <CircleIcon className="size-4 shrink-0" />,
  "input-available": <ClockIcon className="size-4 shrink-0" />,
  "approval-requested": <ClockIcon className="size-4 shrink-0 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 shrink-0 text-blue-600" />,
  "output-available": <CheckCircleIcon className="size-4 shrink-0 text-green-600" />,
  "output-error": <XCircleIcon className="size-4 shrink-0 text-red-600" />,
  "output-denied": <XCircleIcon className="size-4 shrink-0 text-orange-600" />,
};

/** 「还在跑」的两档：入参正在生成（模型还在写这个调用）、已收到完整入参（工具在执行） */
const RUNNING_STATES = new Set<ToolUIPart["state"]>(["input-streaming", "input-available"]);

/**
 * 状态图标：**在跑的转圈**，其余按 `STATUS_ICONS`。
 *
 * 转圈是「还没结束」最直白的信号 —— 原来 `input-available` 是一颗 `animate-pulse` 的时钟，
 * 脉冲幅度太小，扫一眼看不出和静止图标的区别（长命令、`sleep 30` 这种几秒不动的尤其明显）。
 *
 * `live` 是必需的门：非直播（历史里残留的未结算 part）时**不能转** —— 那一轮早就没了，
 * 转圈会让人以为它还在跑。那时退回静态的圆圈 / 时钟。
 */
const statusIcon = (state: ToolUIPart["state"], live: boolean) =>
  live && RUNNING_STATES.has(state) ? (
    <Loader2Icon className="size-4 shrink-0 animate-spin" />
  ) : (
    STATUS_ICONS[state]
  );

/**
 * 状态文案（**中文为源**，英文见 `packages/i18n/src/en.ts` 的「工具卡的状态 tooltip」一节）。
 *
 * 只出现在图标的 tooltip 里，不再铺在工具行上 —— 那一行要留给工具名与明细。
 */
const STATUS_LABELS: Record<ToolUIPart["state"], string> = {
  "input-streaming": "正在生成参数",
  "input-available": "执行中",
  "approval-requested": "等待审批",
  "approval-responded": "已审批",
  "output-available": "已完成",
  "output-error": "出错",
  "output-denied": "已拒绝",
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
  // 触屏没有 hover：复制入口默认藏起来，点一下内容区才浮出来（与消息操作行同一做法）
  const [copyVisible, setCopyVisible] = useState(false);

  // 关掉弹窗时复位，下一次打开仍是干净状态（复制的勾也不该留到下次）
  useEffect(() => {
    if (!open) {
      setCopyVisible(false);
      setCopied(false);
    }
  }, [open]);

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
            {tr("这次调用的完整内容（列表里被截断了），可选中复制；点击内容会显示复制按钮。")}
          </DialogDescription>
        </DialogHeader>
        <div
          className="relative max-h-[60vh] overflow-hidden rounded-md bg-muted/50"
          onClick={() => setCopyVisible(true)}
        >
          <pre
            // 全局默认禁选（styles.css 的白名单制）：这块是要拿去复制 / 贴给别人的，显式放开
            data-selectable
            className="max-h-[60vh] overflow-auto px-2 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap break-all"
          >
            {detail}
          </pre>
          {copyVisible && (
            <button
              type="button"
              title={copied ? tr("已复制") : tr("复制")}
              aria-label={copied ? tr("已复制") : tr("复制")}
              onClick={(event) => {
                event.stopPropagation();
                copy();
              }}
              // 与消息操作行里的复制钮同一形态：无边框 / 无底色，只有图标
              className="absolute right-1.5 bottom-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              {copied ? (
                <CheckIcon className="size-4 text-emerald-500" />
              ) : (
                <CopyIcon className="size-4" />
              )}
            </button>
          )}
        </div>
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
  status,
  onStop,
  stopLabel,
  live = true,
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
  // 标题与明细**都可截断**（min-w-0 truncate）：空间不够时先结尾，右侧的状态图标 / 停止钮
  // 永远留在容器里。全文走 Tooltip（原生 title 要悬停一秒才出，这里 100ms），触屏走全文弹窗。
  // 头部外壳：触发行 + 可选的停止钮（平级，见 ToolHeaderProps.onStop 的说明）。
  /*
   * ⚠️ **不要**给触发器加原生 `disabled`：按钮一旦 disabled，浏览器会吞掉它内部所有
   * 子元素的 click —— 触屏上「点明细看完整命令」在 pending / 完成时能用、执行中却点不动
   * （`input-available` 正好是 !settled）。这里改成 aria-disabled + 自己吞掉点击：
   * `preventDefault()` 会让 Radix 的 composeEventHandlers 跳过 toggle
   * （见 @radix-ui/primitive），明细自己的 onClick 里 stopPropagation 不受影响。
   */
  const titleText = title ?? type.split("-").slice(1).join("-");
  /**
   * 标题能不能点开全文弹窗。
   *
   * 触屏没有 hover，长标题只能靠弹窗看全文；但**只有真的会渲染弹窗时**（`detail` 存在，
   * 见函数末尾那个 `!touch || !detail` 的短路）才把它变成可点区域 —— 否则点了一下没反应，
   * 比不能点更糟。
   */
  const titleOpenable = touch && !!detail;
  const openDetail = (): void => setDetailOpen(true);

  const trigger = (
    <CollapsibleTrigger
      className={cn(
        // `group/row`：箭头 hover 显示要按「这一行」算，不能用裸 `group` —— 消息气泡自带
        // 一个裸 group，那样会变成「鼠标停在消息任意处、所有箭头一起亮」（见 REVEAL_ON_HOVER_ARROW）。
        // 裸 `group` 保留给下面的 `group-data-[state=open]:rotate-90`。
        "group group/row flex min-w-0 max-w-full flex-col items-start gap-1 rounded-md text-left text-muted-foreground transition-colors hover:text-foreground",
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
        {/*
         * ⚠️ 标题**必须可截断**（min-w-0 truncate）。
         * 这里原来是 `shrink-0`：标题恒为工具名（短，不该被挤掉）。现在标题可能是模型写的
         * 「意图」整句（见 `toolCardHead`），`shrink-0` 让这一行的 min-content 等于那一整句 ——
         * 手机窄屏下整行比容器还宽，右侧的状态图标 / 停止钮被顶到外面（用户报过）。
         * 改成可截断后，空间不够先结尾，右侧控件永远留在视口内。
         */}
        {titleOpenable ? (
          // 触屏：标题就是那一句意图，截断了没处看全文 —— 点它开与明细同一个弹窗
          // （阻止冒泡，否则会同时触发卡片展开 / 收起，与下面明细的做法一致）
          <span
            role="button"
            tabIndex={0}
            title={titleText}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openDetail();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              openDetail();
            }}
            className="min-w-0 cursor-pointer truncate text-sm transition-colors hover:text-foreground"
          >
            {titleText}
          </span>
        ) : (
          <Tooltip delayDuration={100}>
            <TooltipTrigger asChild>
              <span className="min-w-0 truncate text-sm">{titleText}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[28rem] break-words">{titleText}</TooltipContent>
          </Tooltip>
        )}
        {status ? <span className="min-w-0 shrink truncate">{status}</span> : null}
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
        {/*
         * 状态：只有一颗图标，文案挪进 tooltip。
         * 图标本身已经把状态说清楚了（转圈 = 还在跑 / 绿勾 / 红叉 / 黄钟），而这一行还要装
         * 工具名和明细，文字挂在旁边只会先把明细挤断 —— 想要确切说法的人悬停一下就有。
         */}
        <Tooltip delayDuration={100}>
          <TooltipTrigger asChild>
            {/* 图标现在是状态唯一的载体：`role="img"` + aria-label 让读屏也能听到状态 */}
            <span
              role="img"
              aria-label={tr(STATUS_LABELS[state])}
              className="inline-flex shrink-0 items-center"
            >
              {statusIcon(state, live)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{tr(STATUS_LABELS[state])}</TooltipContent>
        </Tooltip>
        {settled && (
          /*
           * 箭头平时隐形、悬停整行才浮出来（规则与理由见 `REVEAL_ON_HOVER_ARROW`）：
           * 鼠标停在这条工具行上时它才是有用的提示（能展开 / 能收起），平时只是噪音。
           * 触屏靠那条 `[@media(hover:none)]` 常显 —— 否则手机上完全看不出卡片能点开。
           */
          <ChevronRightIcon
            className={cn(REVEAL_ON_HOVER_ARROW, "size-4 shrink-0 group-data-[state=open]:rotate-90")}
          />
        )}
      </span>
    </CollapsibleTrigger>
  );
  const head = !onStop ? (
    trigger
  ) : (
    // `min-w-0`：这一行是 flex 容器，不给它 min-w-0 的话触发器那一侧会把整行撑到
    // min-content（长标题 / 长明细），停止钮跟着被挤出容器（手机窄屏）。
    <div className="flex min-w-0 max-w-full items-center gap-2">
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
