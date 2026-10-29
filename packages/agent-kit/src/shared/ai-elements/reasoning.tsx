"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@fizz/ui/collapsible";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { useStickToBottom } from "use-stick-to-bottom";
import { Shimmer } from "@fizz/agent-kit/shared/ai-elements/shimmer";
import { useStreamdownOptions } from "@fizz/agent-kit/shared/lib/streamdown";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { t } from "@fizz/i18n";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = true,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState({
      prop: durationProp,
      defaultProp: undefined,
    });

    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const [startTime, setStartTime] = useState<number | null>(null);

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) {
          setStartTime(Date.now());
        }
      } else if (startTime !== null) {
        setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
        setStartTime(null);
      }
    }, [isStreaming, startTime, setDuration]);

    // Auto-open when streaming starts, auto-close when streaming ends (once only)
    useEffect(() => {
      if (defaultOpen && !isStreaming && isOpen && !hasAutoClosed) {
        // Add a small delay before closing to allow user to see the content
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, defaultOpen, setIsOpen, hasAutoClosed]);

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen);
    };

    return (
      <ReasoningContext.Provider
        value={{ isStreaming, isOpen, setIsOpen, duration }}
      >
        <Collapsible
          className={cn("not-prose my-1", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
  /**
   * 折叠 + 流式时，紧跟在「正在思考…」后面那一行**实时预览**（已切好最后一行）。
   * undefined = 不显示。调用方负责在不该显示时传 undefined，原因见 `reasoningPreviewLine`。
   */
  previewText?: string;
};

/**
 * 思考正文 → 行内预览的那一行。
 *
 * **只取最后一行**（最后一个 `\n` 之后那段）—— 这就是「出现换行就向上滚一下」的全部含义：
 * 一行的高度只放得下一行，与其把整段塞进来再靠 CSS 截断（那样永远只看得见开头几个字），
 * 不如让这一行始终跟着**最新的一行**走：换行发生的那一刻，露出来的内容整体往上跳一格。
 * 还没出现换行时就是同一行内的流式增长，超出宽度时把前面的字从左边顶出去（见
 * ReasoningTrigger 里的预览窗口），永远露出最新的结尾。
 *
 * 顺手去掉的 markdown 记号：预览是纯文本一行，`**粗体**` / `` `代码` `` / `- 列表` 这些
 * 记号留在一行里只是噪点（又要省掉重新解析 markdown 的开销）。
 *
 * ⚠️ 调用方（PartView）必须在**自己知道 open 的时候**调用它、只把切好的一行传进来：
 * 把原始 text 传进来的话，展开状态下每来一个 token 都会改 props，`memo` 的
 * ReasoningTrigger 连同里面的 Shimmer 就跟着重渲染（现在它们在展开时是不重渲染的）。
 */
export function reasoningPreviewLine(text: string): string {
  return text
    .slice(text.lastIndexOf("\n") + 1)
    // 行首的标题 / 引用 / 列表符号（「-5 是负数」里的「-」后面没空格，不会误伤）
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/`([^`]*)`/g, "$1") // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, "$1") // 粗体
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接只留文字
    .replace(/[*_~]+/g, "") // 其余强调 / 删除线记号
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 思考条的默认触发文案（中英都走 `t()`；英文见 `packages/i18n/src/en.ts`）。
 *
 * ⚠️ 这里在渲染期调用 `t()`，所以**用它的组件必须订阅语言**（`ReasoningTrigger` 里调了
 * `useT()`）：本组件是 `memo` 的，props 不变时不会因为父级重渲染而跟着重渲染 —— 不自己
 * 订阅的话，切成英文后这行字会一直停在中文，直到下一条消息进来。
 */
const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming) {
    return <Shimmer duration={1}>{t('正在思考…')}</Shimmer>;
  }
  // ⚠️ 只有「正在流式」才该显示闪烁的「正在思考…」。原来 `duration === 0` 也走这个分支，
  // 于是思考不到 1 秒就结束时，收起后头部会一直闪着「Thinking...」（像还没想完）。
  if (duration === undefined || duration === 0) {
    return <p>{t('思考了几秒')}</p>;
  }
  return <p>{t('思考了 {seconds} 秒', { seconds: duration })}</p>;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    previewText,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();
    // 订阅语言：memo 组件不订阅的话，切语言时这行字不会跟着变（见 defaultGetThinkingMessage）
    useT();

    /*
     * 预览窗口：超出宽度**不 truncate**（那永远只看得见开头，而最新内容在尾部），
     * 而是让文字躺在 `w-max` 轨道上、窗口 `overflow-x-hidden`，每次内容更新把
     * scrollLeft 钉到最右 —— 未超宽时等于 0（无副作用），超宽后每颗 token 都把
     * 前面的字往左顶一格，露出的始终是最新结尾（与消息贴底、终端跟随同一套逻辑）。
     * useLayoutEffect 在绘制前同步执行，不会闪出旧内容。
     */
    const previewRef = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
      const win = previewRef.current;
      if (win) win.scrollLeft = win.scrollWidth;
    }, [previewText]);

    return (
      /*
       * ⚠️ `flex w-fit` 而不是 `inline-flex`（别改回去）：
       * inline-flex 是**行内级**盒子，会落进块级父元素的行盒里，被父级 line-height
       * （这里是 15px 正文的 22.5px）撑到 24.5px —— 触发器本身只有 20px，
       * 多出来的 4.5px 全掉在**下方**，于是这条「思考了几秒」看着比工具条偏上、
       * 与下一条的间距也比上一条松（工具条是 display:flex 的 20px 盒子，没有行盒）。
       * `flex` 让它变成块级盒子、脱离行盒，`w-fit` 保住「触发区只占内容宽度」。
       */
      <CollapsibleTrigger
        className={cn(
          "flex w-fit max-w-full items-center gap-2 text-left text-muted-foreground text-sm transition-colors hover:text-foreground",
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4 shrink-0" />
            {/* 预览在时标题不许被压缩（min-w-0 留给预览那一格去 truncate） */}
            <span className={cn("truncate", previewText != null && "shrink-0")}>
              {getThinkingMessage(isStreaming, duration)}
            </span>
            {previewText != null ? (
              /*
               * 折叠 + 流式时的行内实时预览。`min-w-0 flex-1`：与触发器的 `w-fit max-w-full`
               * 搭配 —— 文字短时整行贴合内容（右侧箭头紧跟），长了就顶满并把旧字从左边推出。
               * 换行后的「整体上跳」由 reasoningPreviewLine 切最后一行实现，与这里行内的
               * 横向推出互补：纵向跟最新行、横向跟最新字。最后一行暂时为空时宁可让预览
               * 消失，也不补闪烁光标（用户明确不要那个光标）。
               */
              <span
                ref={previewRef}
                className="min-w-0 flex-1 overflow-x-hidden whitespace-nowrap text-muted-foreground"
              >
                {previewText ? (
                  <span className="inline-block w-max">{previewText}</span>
                ) : null}
              </span>
            ) : null}
            <ChevronRightIcon
              className={cn(
                "size-4 shrink-0 transition-transform",
                isOpen ? "rotate-90" : "rotate-0"
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    // 思考内容可能很长：限高 + 内部滚动；用 use-stick-to-bottom 让流式增长时自动贴底
    // （用户中途上滚即停止、滚回底部自动恢复，与消息区一致），避免整篇思考直接铺满屏。
    const { scrollRef, contentRef } = useStickToBottom({ initial: "instant" });
    // 代码高亮主题跟着当前配色主题走（与 MessageResponse 同一份）
    const streamdownOptions = useStreamdownOptions();

    return (
      <CollapsibleContent
        className={cn(
          "mt-4 text-sm",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=closed]:animate-out data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
          className
        )}
        {...props}
      >
        <div
          ref={scrollRef}
          className="max-h-[20rem] overflow-y-auto pr-2 no-scrollbar"
          /*
           * overflow-anchor: none —— 关掉 Chromium 滚动锚定：流式 token 增长 / markdown 重排时
           * 它会「帮忙」修正滚动位置，造成偶发跳顶。滚动位置由 use-stick-to-bottom 显式管理。
           */
          style={{ overflowAnchor: "none" }}
        >
          <div ref={contentRef}>
            {/* Streamdown 的 props 比 div 更严（dir 只收 auto/ltr/rtl），这里显式收窄再透传。
                `sd-md` 是 styles.css 里「代码块 / 表格收敛」那组覆盖的作用域锚点；
                行号 / 表格工具条 / 代码高亮等渲染选项与 MessageResponse 共用 lib/streamdown.ts */}
            <Streamdown
              className="sd-md"
              {...streamdownOptions}
              {...(props as ComponentProps<typeof Streamdown>)}
            >{children}</Streamdown>
          </div>
        </div>
      </CollapsibleContent>
    );
  }
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
