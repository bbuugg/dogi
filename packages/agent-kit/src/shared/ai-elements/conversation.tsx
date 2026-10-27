"use client";

/**
 * 消息区滚动容器：基于 `use-stick-to-bottom`（v1.1.6）实现「贴住底部」。
 *
 * 库内部用 spring 动画平滑跟随内容增长（就是「消息向上流动」顺滑观感的来源）；
 * 仅当「已经贴底」时才会自动跟随，用户上滚即停止、滚回底部自动恢复。
 *
 * 这里只做四件事：
 * 1. 切换会话 / 消息装载完成（resetKey 变化）：`useLayoutEffect` 里**同步写 scrollTop**
 *    落底，压掉内容暴增时库默认的 resize spring 动画（只调 scrollToBottom 是不够的，
 *    会被同一帧的 ResizeObserver spring 抢跑，详见那段注释）。
 * 2. 用户手动开合折叠块（`holdScroll`）：转调库的 `stopScroll()` 退出跟随，
 *    刚展开的内容向下长出来、视图不动，点的那张卡不会被拽到底部。
 * 3. **容器宽度变化时退出跟随**（见下面 `attachScroll`）：宽度变化是**布局**变化
 *    （右侧面板开合、窗口缩放），不是「新内容到达」—— 但宽度一变正文就重排、内容高度
 *    跟着变，库的 ResizeObserver 会把它当成 positive resize 而去贴底。用户正翻着历史时
 *    这就会把视图**突然拽到底部**（实测反馈）。所以宽度一变且用户不在底部时主动 stopScroll。
 * 4. 对外提供 isAtBottom / scrollToBottom / holdScroll，给「回到底部」按钮与折叠块用。
 * 5. **用户自己往上滚时立刻退出跟随**（见 `attachScroll` 里的 wheel / touch 监听）——
 *    库自带的「上滚即停」在我们这套样式 + 流式场景下两条判定同时失效，只靠它会一直
 *    被拽回底部。
 */
import { Button } from "@fizz/ui/button";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import { useStickToBottom } from "use-stick-to-bottom";
import type { ComponentProps } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

/**
 * 「算贴底」的距离阈值（像素）。与库内部的 `STICK_TO_BOTTOM_OFFSET_PX` 取同一个值 ——
 * 两处口径不一致会出现「库认为贴底、我们认为没贴」的错位。
 */
const AT_BOTTOM_THRESHOLD_PX = 70;

type ConversationContextValue = {
  isAtBottom: boolean;
  scrollToBottom: () => void;
  /** 用户手动开合折叠块时调用：退出自动贴底，别把刚展开的内容拽到底部 */
  holdScroll: () => void;
};

const ConversationContext = createContext<ConversationContextValue | null>(null);

/** 取消息区的滚动状态与动作（必须在 <Conversation> 内使用） */
export function useConversation(): ConversationContextValue {
  const context = useConversationOptional();
  if (!context) {
    throw new Error("useConversation must be used within a <Conversation>");
  }
  return context;
}

/**
 * 同 `useConversation`，但在 `<Conversation>` 之外调用时**返回 null 而不是抛错**。
 * 给「既可能在消息流里、也可能单独渲染」的片段用（如 PartView 里的工具卡 / 思考条）。
 */
export function useConversationOptional(): ConversationContextValue | null {
  return useContext(ConversationContext);
}

export type ConversationProps = ComponentProps<"div"> & {
  /**
   * 变化时立刻（瞬时）落底。切换会话 / 消息装载完成时由调用方递增 ——
   * 用 useLayoutEffect 在本帧 paint 之前写 scrollTop，杜绝任何中间态。
   */
  resetKey?: string;
  /**
   * 内容**变高**（ResizeObserver 的 positive resize）时是否用平滑动画跟随。
   *
   * 只有**流式追加**需要它（就是「消息向上流动」那个顺滑观感）。其余让内容长高的
   * 情况一律不需要，最典型的是历史里的图片：`MarkdownImage` 先用骨架占位、`onLoad`
   * 后按真实尺寸撑开，于是装载完成后内容还会二次长高 —— 用 spring 跟随就是一段
   * 「没人操作却自己往下滚」的动画（用户明确反馈过）。这类场景瞬时到底即可。
   *
   * 默认 `false`（瞬时）。流式那一路由调用方传 `streaming` 打开。
   */
  smoothResize?: boolean;
};

export const Conversation = ({
  className,
  resetKey,
  smoothResize = false,
  children,
  style,
  ...props
}: ConversationProps) => {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll } =
    useStickToBottom({
      // 首屏 / 初次挂载直接落底（不要从顶部动画下来）
      initial: "instant",
      /*
       * 内容变高时的跟随方式。`undefined` 会让库回到自己的默认值（spring 平滑动画，
       * 见库内 mergeAnimations），"instant" 则瞬时贴底 —— 图片加载这类「没人操作却
       * 长高」的场景必须瞬时，否则就是一段自己往下滚的动画（见 smoothResize 注释）。
       */
      resize: smoothResize ? undefined : "instant",
    });

  /** 用户手动开合折叠块：退出跟随，让内容向下长、视图留在原地（见文件头注释）。 */
  const holdScroll = useCallback(() => {
    stopScroll();
  }, [stopScroll]);

  /**
   * 盯**滚动容器自己的宽度**（不是内容高度）的观察器。
   *
   * 为什么需要它：库只在内容**变高**时贴底，且它无从区分「新内容到了」与「同一批内容
   * 因容器变窄而重排变高」。右侧面板开合走的是 `transition-[width] duration-200`
   * （见 SidePanel），这 200ms 里会话列每帧都在变窄 / 变宽 —— 正文跟着重排，内容高度
   * 每帧都在变。库的 ResizeObserver 于是每帧发一次 positive resize 并调 `scrollToBottom`；
   * 它唯一的闸门是内部 `state.isAtBottom`，而那个状态在一次 resize 风暴里并不可靠
   * （`handleScroll` 在 `resizeDifference !== 0` 时会直接 return，用户的上滚可能没被记账）。
   * 结果就是用户翻着历史、一开合面板，视图被拽到底部。
   *
   * 修法：宽度一变就自己退出跟随。`stopScroll()` 会同步把内部 `isAtBottom` 置 false，
   * 库随后那些 `scrollToBottom` 在 rAF 里一查 `!isAtBottom` 就直接 bail（库源码
   * `next()` 的第一个分支），而浏览器天然会在内容变高时保住 `scrollTop` ——
   * 视图于是留在原地。
   *
   * **贴底时反过来：重新锁上跟随**。手机键盘收起 / 输入框高度变化会让滚动容器的
   * 高度跟着变，浏览器把 `scrollTop` 夹到新的最大值会触发一次**看起来像上滚**的
   * scroll 事件，库据此把 `isAtBottom` 置 false；之后流式内容再长高就不再跟随，
   * 用户必须手动滑到底部才恢复（实测反馈）。容器尺寸一变、而当前仍离底 ≤ 阈值时，
   * 直接同步落底并 `scrollToBottom({ animation: 'instant' })` 把库的状态机复位 ——
   * 这与「用户真的翻到历史里」不同，那种情况离底 > 阈值，不动。
   *
   * 顺带把「窗口缩放」也覆盖了：那是同一类布局变化，同样不该把视图甩到底部。
   */
  const widthObserverRef = useRef<ResizeObserver | null>(null);
  /** 用户上滚监听的卸载函数（与 widthObserver 同生命周期，节点换了要摘掉） */
  const userScrollCleanupRef = useRef<(() => void) | null>(null);
  const attachScroll = useCallback(
    (el: HTMLDivElement | null) => {
      // 先把节点交给库（它要挂 scroll / wheel 监听、并从 ref 读 scrollTop）
      scrollRef(el);
      widthObserverRef.current?.disconnect();
      widthObserverRef.current = null;
      userScrollCleanupRef.current?.();
      userScrollCleanupRef.current = null;
      if (!el) return;
      /**
       * 用户主动上滚 → 立刻退出跟随。
       *
       * 为什么库自带的「上滚即停」在这里不管用（两条判定同时失效）：
       *
       * 1. **wheel 那条**：库从事件 target 往上找第一个 `getComputedStyle(el).overflow`
       *    ∈ `{scroll, auto}` 的祖先，然后才认「这一滚是不是发生在滚动容器上」。而我们的
       *    容器是 `overflow-y-auto overflow-x-hidden`（见下面类名注释：必须禁掉横向滚动），
       *    计算值会序列化成 `"hidden auto"` —— 永远匹配不上，它一路走到没有父元素就
       *    `return`，**上滚完全不记账**。
       * 2. **scroll 那条**：库在回调里先判 `state.resizeDifference`，非 0 就 return
       *    （它没法区分「新内容到了」和「内容重排变高」）。流式输出时内容每帧都在长高，
       *    ResizeObserver 每帧都写一个非 0 的 difference，于是用户的 scroll 事件被整段丢掉。
       *
       * 两条一起失效 = 用户一边往上翻、AI 一边输出，`isAtBottom` 一直是 true，下一帧
       * 内容长高就被 `scrollToBottom` 拉回底部（用户实测：终端助手面板里根本翻不上去）。
       * 所以这里自己判「用户想往上」，直接 `stopScroll()` 把库的 isAtBottom 置 false ——
       * 它后续那些 resize 贴底在 rAF 里一查 `!isAtBottom` 就 bail。
       */
      const onWheel = (e: WheelEvent): void => {
        if (e.deltaY < 0) {
          stopScroll();
          return;
        }
        // 往下滚且已经贴底：把跟随锁回来。流式期间库的 handleScroll 会被 resize 挡掉，
        // 不主动锁的话「滚回底部」之后要等这一轮结束才恢复跟随
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX) {
          scrollToBottom({ animation: "instant" });
        }
      };
      /** 触摸（手机 / 触屏本）：手指往下移 = 内容往上翻 = 用户在往回看 */
      let touchY: number | null = null;
      const onTouchStart = (e: TouchEvent): void => {
        touchY = e.touches[0]?.clientY ?? null;
      };
      const onTouchMove = (e: TouchEvent): void => {
        const y = e.touches[0]?.clientY ?? null;
        // 2px 死区：手指按住时的轻微抖动不该算「上滚」
        if (y !== null && touchY !== null && y - touchY > 2) stopScroll();
        touchY = y;
      };
      el.addEventListener("wheel", onWheel, { passive: true });
      el.addEventListener("touchstart", onTouchStart, { passive: true });
      el.addEventListener("touchmove", onTouchMove, { passive: true });
      userScrollCleanupRef.current = () => {
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("touchstart", onTouchStart);
        el.removeEventListener("touchmove", onTouchMove);
      };
      /** 上一帧的尺寸；`null` = 首次回调（只记录，不当成一次变化） */
      let prevWidth: number | null = null;
      let prevHeight: number | null = null;
      const ro = new ResizeObserver(([entry]) => {
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        const first = prevWidth === null || prevHeight === null;
        const widthChanged = !first && prevWidth !== width;
        const heightChanged = !first && prevHeight !== height;
        prevWidth = width;
        prevHeight = height;
        // 首帧只记录：挂载时不该被当成「刚刚变过尺寸」
        if (!widthChanged && !heightChanged) return;
        // 直接量 DOM 而不是读 React state：这个判断必须与本次布局同步，
        // 走 state 会晚一帧（而这一帧正是库要贴底的那一帧）。
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        /*
         * 容器尺寸变化后仍然贴底 → 重新锁上跟随。
         *
         * 典型触发是手机键盘开合：`scrollTop` 被浏览器夹到新上限时会产生一次
         * 「scrollTop 变小」的 scroll 事件，库把它当用户上滚、把 isAtBottom 置 false；
         * 不重新锁的话，这一轮流式输出就永远不跟了（用户得手动滑到底）。
         * 只在「离底 ≤ 阈值」时做 —— 用户真的翻到历史里时不动他的视图。
         */
        if (distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX) {
          const relock = (): void => {
            // 再量一次：rAF 里用户可能已经上滚了，别把他拽回来
            if (el.scrollHeight - el.scrollTop - el.clientHeight > AT_BOTTOM_THRESHOLD_PX) return;
            el.scrollTop = el.scrollHeight;
            scrollToBottom({ animation: "instant" });
          };
          relock();
          // 尺寸变化后浏览器还可能补发一次 scroll（`scrollTop` 被夹到新上限），
          // 库会把它当成用户上滚。下一帧再锁一次，盖住这条迟到的 scroll。
          requestAnimationFrame(relock);
          return;
        }
        // 宽度变化 = 布局变化（面板开合 / 窗口缩放），不是新内容到达：退出跟随
        if (widthChanged) stopScroll();
      });
      ro.observe(el);
      widthObserverRef.current = ro;
    },
    [scrollRef, stopScroll, scrollToBottom]
  );

  // 组件卸载时摘掉观察器与用户上滚监听（节点被换掉时由 attachScroll 自己清）
  useEffect(
    () => () => {
      widthObserverRef.current?.disconnect();
      userScrollCleanupRef.current?.();
    },
    []
  );

  // 切换会话 / 消息装载完成：本帧 paint 之前瞬时落底（不要平滑动画）
  useLayoutEffect(() => {
    /*
     * ⚠️ 必须**同步**把 scrollTop 写到底，不能只调 scrollToBottom({ animation: "instant" })。
     *
     * 库的 scrollToBottom 内部每一步都 `await` 一个 rAF，而同一帧里 ResizeObserver 的回调
     * 先于 rAF 执行：历史消息一次性装载完成时内容高度暴增，RO 会先用 resize 动画（默认
     * spring）发起平滑滚动并占住 `state.animation`；随后 instant 那次请求因为 behavior
     * 不匹配被直接跳过（见库源码 `state.animation || (state.animation = …)` 与
     * `if (state.animation?.behavior === behavior)`），于是观感就是「切进会话后从顶部
     * 平滑滚到底部」。同步赋值则发生在 RO 之前，等 RO 回调跑时 scrollTop 已到底
     * （`scrollTop < target` 为假），spring 根本起不来。
     *
     * 落底本身直接写 DOM（同步、本帧生效）；随后的 scrollToBottom 负责把库的状态机复位
     * —— 它会清掉在途动画（`wait !== true` 时），并同步把 isAtBottom 置回 true。
     * 顺序不能反：先 scrollToBottom 的话，它内部要等一个 rAF 才真正动 scrollTop，
     * 又会被 RO 的 spring 抢先。
     */
    const scrollEl = scrollRef.current;
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    scrollToBottom({ animation: "instant" });
  }, [resetKey, scrollRef, scrollToBottom]);

  return (
    <ConversationContext.Provider
      value={{ isAtBottom, scrollToBottom, holdScroll }}
    >
      <div
        ref={attachScroll}
        /*
         * `data-message-scroll` = 消息区的滚动容器锚点。
         *
         * 划选浮层（`features/chat/quotes.tsx` 的 `MessageQuoteLayer`）是 body 上的
         * `fixed` 浮层，要判断「浮层会不会飘出消息区、压到标签条上」就得知道这个容器的
         * rect。用属性显式标出来，而不是让那边按 `overflow-y-auto` 往上找祖先 ——
         * 正文里的代码块也是 `overflow-auto`，会被误判成滚动容器。
         */
        data-message-scroll=""
        className={cn(
          /*
           * `overflow-x-hidden`：消息区**只纵向滚**。只写 `overflow-y-auto` 时另一轴按
           * 规范会被算成 `auto` —— 任何一条略宽的内容（加载骨架的固定宽度、图片、
           * 没包滚动层的宽元素）都会让整块消息区能左右拖。手机壳的侧栏手势靠
           * 「起点不在横向滚动容器里」来避让代码块 / 宽表格（见 `use-sidebar-swipe.ts`），
           * 消息区自己被认成横向滚动容器时，右滑开抽屉就整个失效。
           * 代码块 / 表格自带 `overflow-x-auto`，不受这一条影响。
           */
          "relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden no-scrollbar",
          /*
           * 消息区**不画滚动条**（`no-scrollbar`，见 styles.css）：滚轮 / 触摸 / 键盘滚动照常。
           *
           * ⚠️ 这个类**必须留着**：`c21b40d` 那次改动把它误删过一次，于是桌面端（`pointer: fine`
           * + `≥768px`，见 styles.css 那条 base 层 `::-webkit-scrollbar { width: 10px }`）消息区
           * 又开始画 10px 占位式滚动条 —— 长会话里条一出现，内容列就横向缩 10px、和下方输入框
           * 错开，短会话又弹回去（用户报的「滚动条前后宽度变化」）。去掉它 = 让宽度重新变得不定。
           *
           * 这里以前预留着滚动条槽位（`scrollbar-gutter: stable`），为的是「条一出现内容
           * 别横向跳 10px」—— 那是**占位式**滚动条才有的烦恼（styles.css 那条 base 层
           * `::-webkit-scrollbar { width: 10px }` 只在桌面宽度下生效）。现在条本身不画了，
           * 宽度恒定，槽位与所有为它做的对齐补偿（见 ChatComposer）一并撤掉；
           * 别再给任何一侧补 padding 去「对齐槽位」—— 那会真的错开半个槽位。
           */
          className
        )}
        /*
         * overflow-anchor: none —— 关掉 Chromium 的滚动锚定。流式内容增长 / markdown 重排时
         * 它会「帮忙」修正滚动位置，造成偶发跳顶。滚动位置由 use-stick-to-bottom 显式管理。
         */
        style={{ overflowAnchor: "none", ...style }}
        {...props}
      >
        <div ref={contentRef}>{children}</div>
      </div>
    </ConversationContext.Provider>
  );
};

export type ConversationContentProps = ComponentProps<"div">;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <div className={cn("flex flex-col gap-8", className)} {...props} />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useConversation();

  return (
    !isAtBottom && (
      // sticky（而不是 absolute）：按钮在滚动容器**里面**，用 sticky 才能一直贴在可视区底部
      <div className="pointer-events-none sticky bottom-4 z-10 -mt-12 flex justify-center">
        <Button
          // outline 变体在暗色下是 `dark:bg-input/30`、悬停 `dark:hover:bg-input/50`，而 `--input`
          // 本身就是 15% 透明的白，浮在消息上看不清；这里换成不透明的 popover / accent 背景，
          // 保留边框与阴影。
          className={cn(
            "pointer-events-auto rounded-full bg-background text-foreground shadow-lg hover:bg-accent dark:bg-popover dark:hover:bg-accent backdrop-blur-2xl",
            className
          )}
          onClick={scrollToBottom}
          size="icon"
          type="button"
          variant="outline"
          {...props}
        >
          <ArrowDownIcon className="size-4" />
        </Button>
      </div>
    )
  );
};
