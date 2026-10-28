"use client";

/**
 * 会话主界面（消息列表 + 输入框 + 落底指示器）—— 主会话与容器工作台**共用的一份**。
 *
 * ## 为什么要这一个文件
 *
 * 两处会话视图本来各写一份消息流 + 输入框：
 * - 主会话 `ChatPanel`（对话视图）—— 数据来自 `useAgentApp`；
 * - 容器工作台 `flow/node-workbench.tsx`（流程节点）—— 数据来自 `useNodeWorkbench`。
 *
 * 两边的**观感必须一致**（注释里明写了「否则两边会各自漂移」），但那时只有「零件」共用
 * （`MessageParts` / `ThinkingRow` / `MessageActionRow` / `Composer`），**外层结构**仍是两份手写
 * JSX：滚动容器、对齐壳、落底钮、消息循环、零 part 分支、空态各写一遍。改一处漏一处就漂。
 * 这里把外层结构也收进来，数据与两侧特有的部分走 props。
 *
 * ## 刻意留在调用方的东西（语义不同，不该共用）
 *
 * - 顶栏 / 右侧面板（终端、文件、git）：工作台那边标签只有两个，主会话三个；
 * - 输入框两侧的 pill：主会话是「工作区 + 权限 / 后端模型」，工作台是「权限 / 容器模型」；
 * - 输入框上方的卡片：主会话是「待发送队列」，工作台是「待答复权限 + 当前任务」；
 * - 消息级操作：主会话能编辑重发 / 删除；工作台与 acp 会话的历史改不了（只留复制）。
 *
 * 它们通过 `leading` / `trailing` / `header` / `above` / `renderActions` 这几个槽位进来。
 */
import { useRef, type ReactNode } from 'react'
import { Loader2, MessageSquare, RotateCw, Unplug } from 'lucide-react'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton
} from '@fizz/agent-kit/shared/ai-elements/conversation'
import { Message, MessageContent } from '@fizz/agent-kit/shared/ai-elements/message'
import { Skeleton } from '@fizz/ui/skeleton'
import { MessageOutline } from '@fizz/agent-kit/features/chat/MessageOutline'
import { ChatFind } from '@fizz/agent-kit/features/chat/chat-find'
import { ContextCompactionCard } from '@fizz/agent-kit/features/chat/ContextCompactionCard'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { Composer } from '@fizz/agent-kit/features/chat/composer'
import {
  MessageActionRow,
  MessageParts,
  ThinkingRow,
  isWaitingNextStep,
  type MessageFollowupBridge
} from '@fizz/agent-kit/features/chat/message-parts'
import type { AgentChatMessage } from '@fizz/contracts/agent-api'
import type { ContextCompactionState } from '@fizz/agent-kit/shared/lib/stores/slices/conversation'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

// ---------------------------------------------------------------------------
// 消息列表
// ---------------------------------------------------------------------------

export interface MessageListProps {
  messages: AgentChatMessage[]
  /**
   * 这些消息属于哪条会话（`ChatPanel` 传当前那条）。
   *
   * 只有一个用途：错误消息（`⚠️ ` 前缀的文本 part）后面那颗「重新加载」要知道重载**哪一条**
   * —— 多标签面板里可能同时挂着好几条会话，读「当前会话」会刷错。不传（容器工作台）就不出
   * 那颗按钮。
   */
  conversationId?: string
  /** 本轮是否在跑（末条助手消息的处理、流式结束后的操作行都看它） */
  streaming: boolean
  /**
   * 正在回放现场（断线重连后服务端从帧日志头部重放这一轮）—— 只影响滚动跟随方式。
   *
   * 回放是「先把这一轮的 parts 清空、再逐帧重建」，内容高度先塌后长；这段窗口里若还
   * 用流式那套 spring 平滑跟随，用户看到的就是「消息列表像在重新加载、一直从顶部往下
   * 滚」。所以回放期间降级成**瞬时贴底**（与图片加载完成那类「没人操作却长高」同理，
   * 见 ai-elements/conversation.tsx 的 smoothResize 说明）。默认 false。
   */
  replaying?: boolean
  /**
   * 变化时**瞬时落底**：切会话 / 历史装载完成 / 自己发出新消息。
   * 用户往上翻过历史后滚动容器已退出跟随，靠「内容变高」那套贴底救不回来，必须显式落底。
   */
  resetKey: string
  /**
   * 消息列的壳类名。其中的 `max-w-*` **与 `MessageOutline` 的定位强相关**：
   * 竖线要落在「消息列右缘 → 面板右缘」那条空白带里，落点公式拿消息列宽当输入
   * （见那边的 `RAIL_PADDING_RIGHT`）。改这里的宽度上限就要同步改那边，否则竖线会偏。
   *
   * 纵向内边距压到最小（上下各 4px）：用户明确要求「下面空白太大不能接受」，
   * 而滚动容器是贴底的 —— 这里的 `pb` 会**原样变成滚到底之后那片空白的底**。
   * 代价：末条消息的操作行贴着滚动区底边，悬停显形时可能被裁剪线切到一点。
   * 不能压到 0：留一点点，至少让末条消息的按钮不正好压在边上。
   *
   * 横向务必保留移动端内边距（`px-2`，与 `ChatComposer` 的 `p-2` 对齐）：
   * 只写 `sm:px-6` 的话手机上消息会**左右贴边**（用户报过「左边没有边距」）。
   */
  contentClassName?: string
  /** 消息流**之前**的内容（上下文压缩 / 连接中断等 sticky 条） */
  header?: ReactNode
  /**
   * 历史装载失败：给了就整块替换消息流（调用方传自己的「错误 + 重试」组件）。
   * ⚠️ 必须与 `loading` 互斥判断：装载窗口里先上骨架，别闪错误。
   */
  error?: ReactNode
  /** 历史装载中：还没有任何消息时上骨架屏（形状对齐真实消息流） */
  loading?: boolean
  /**
   * 正在删消息（「仅本条」/「本条及其后」/ 编辑重发里的那一步）。
   *
   * 删除完成后要整体回拉历史，中途再点别的消息（编辑 / 删除 / 签出）只会让两边的回拉
   * 互相盖，所以这段窗口里**消息内容暂时不接收点击**（滚动照常）、顶部挂一条进度。
   * 用户报过「删的时候很慢、没有任何提示，还能继续点别的消息」。
   */
  deleting?: boolean
  /** 一条消息都没有时的内容（会包在 `ConversationEmptyState` 里） */
  emptyState?: ReactNode
  /** 提问卡的作答通道；不传 = 提问卡只读（容器工作台没有） */
  followup?: MessageFollowupBridge
  /**
   * 消息下方的**文档入口**（本轮写出的 markdown 文档，见
   * `shared/lib/artifacts.ts`）。返回 null 则不渲染。
   *
   * ⚠️ 这里**不再有 `renderFooter`**（原先放「本轮用量」那一行）：2026-10 用户要求把
   * 用量收成一颗图标、与「复制」并排在同一行里，于是它改走 `renderActions` 的
   * `usageSlot`（见 `MessageActionRow`）。**别再往正文下方加常驻的一行元信息** ——
   * 那种行比正文还宽，每条消息下面挂一条会把列表压得很碎，用户已明确不接受。
   */
  renderArtifacts?: (message: AgentChatMessage) => ReactNode
  /**
   * 消息条底部的操作行。返回 null 则不渲染。
   * ⚠️ 「流式输出的最后一条助手消息」这条规则由本组件统一挡掉，调用方不必自己判 ——
   * 内容还在长时复制到的是半截文本、删除也容易点错时机。
   *
   * ⚠️ 但**该条上这个回调仍会被调用一次**：返回的节点会被渲染进一个不可见、不可交互的
   * 壳里**占位**（理由见下面那段注释）。所以实现里不要带副作用，也不要假设「被调用 =
   * 用户能点到」。
   */
  renderActions?: (args: MessageActionArgs) => ReactNode
  /**
   * 消息目录：右侧「拉线」时间轴，用户消息各占线上的一个点，指针移到点上跳转。
   * 桌面与窄屏共用同一形态（见 `MessageOutline`）。
   */
  outline?: boolean
  /**
   * 模型请求正在重试：把「第 N 次重试」这条**单条**提示渲染在「正在思考…」的位置。
   * `attempt` 变化时整条重建，重放一遍入场动画；屏幕上始终只有一条。
   */
  retryNotice?: { attempt: number; maxRetries: number | null } | null
  /**
   * 连接断了但服务端那轮还在跑：正在自动重接（第几次）。渲染在「正在思考…」的位置 ——
   * 用户看到的是「没新内容是因为连接断了」，而不是「卡住了」。与 `retryNotice` 同位，
   * 两者同时出现时优先显示重连（连接不通时重试提示没有意义）。
   */
  reconnectNotice?: { attempt: number } | null
  /**
   * 当前会话的上下文交接文档。带着 `messageId`（触发压缩的那条助手消息）时作为该消息
   * 里的一个折叠块渲染；手动压缩没有绑定消息（`messageId` 缺省），渲染在消息列表末尾。
   * 两者与思考 part 同一形态，不再放在列表顶部。
   */
  compaction?: ContextCompactionState | null
  /**
   * 正在编辑重发的那条消息（null = 不在编辑）。该条消息加描边压暗，输入框上方同时显示
   * 「编辑消息」条 —— 两处一起才是完整标识：条上写着原文，消息上是它在哪。
   */
  editingMessageId?: string | null
}

/** `MessageList` 里 `renderActions` 的参数 */
export interface MessageActionArgs {
  message: AgentChatMessage
  /** 该条在消息列表中的下标 */
  index: number
  /** 消息总条数（`deleteCount` 由此算出：含本条在内会被一起删掉的条数） */
  total: number
}

/**
 * 消息列表：贴底滚动容器 + 消息循环 + 「回到底部」指示器。
 *
 * 滚动位置由 `Conversation` 显式管理（库内部 `use-stick-to-bottom`），本组件只在
 * `resetKey` 变化时让它瞬时落底；其余的跟随 / 停跟交给库。
 */
export function MessageList({
  messages,
  conversationId,
  streaming,
  replaying = false,
  resetKey,
  contentClassName = 'mx-auto w-full px-2 py-1 sm:px-6 max-w-3xl',
  header,
  error,
  loading = false,
  deleting = false,
  emptyState,
  followup,
  renderArtifacts,
  renderActions,
  outline = false,
  editingMessageId = null,
  retryNotice = null,
  reconnectNotice = null,
  compaction = null
}: MessageListProps) {
  const tr = useT()
  /**
   * 消息区根节点，给右侧「消息目录」定位用。
   *
   * 刻意不用 `document.getElementById`：桌面端能同时挂多个会话面板，同一个会话在两个
   * 分屏里打开时全局 id 会撞，拿到的可能是另一个面板里的节点。所以在本面板内按
   * `data-message-id` 找。
   */
  const panelRef = useRef<HTMLDivElement>(null)

  /** 消息目录点击：把那条消息滚到可视区顶部（消息上的 `scroll-mt-6` 负责留出上边距） */
  const jumpToMessage = (messageId: string): void => {
    const node = panelRef.current?.querySelector(
      `[data-message-id="${CSS.escape(messageId)}"]`
    )
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const total = messages.length

  return (
    // relative 只包住消息区（不含下方输入框）：「消息目录」的竖条相对它垂直居中。
    // `@container`：给下面的「窄面板让出竖线通道」用容器查询（判的是**面板**宽度，
    // 不是视口宽度 —— 侧栏、右侧分栏都会挤面板，而视口可能还很宽）。
    <div
      ref={panelRef}
      aria-busy={deleting || undefined}
      className="@container relative flex min-h-0 flex-1 flex-col"
    >
      <Conversation
        className="min-h-0 flex-1"
        resetKey={resetKey}
        /*
         * 只有「本轮正在流式输出」才用平滑跟随（消息向上流动的观感）；
         * 其余内容长高（图片加载完成、历史刷新…）一律瞬时贴底，不要自己滚。
         *
         * ⚠️ `replaying` 必须一起判：断线重连的回放窗口里 `streaming` 也是 true，
         * 但那是「清空后逐帧重建」，内容先塌后长 —— 用 spring 跟随就是一段「列表像在
         * 重新加载、从顶部往下滚」的动画（用户实测反馈过）。回放期间瞬时贴底，
         * 视角一直落在底部，等 `replay-end` 之后再恢复流式的平滑跟随。
         */
        smoothResize={streaming && !replaying}
      >
        {/* ⚠️ 两处都与 `MessageOutline` 的竖线耦合，改要一起改：
            1) 这里的宽度上限（`max-w-3xl`）是竖线落点的输入（见那边的 RAIL_PADDING_RIGHT）；
            2) 面板一窄，竖线就退化成贴着面板右缘（占「右起 inset+1 ~ inset+23」这条带），而**用户
               消息是右对齐的**（ai-elements 的 `ml-auto`）、操作行也靠在消息右缘 —— 不让开位置，竖线
               正好压在用户消息下面那排按钮（删除）上，点不动（手机上必现）。
               所以窄面板要给内容补右内边距：`--rail-channel` = 竖线通道 + 列宽 + 缝，与竖线自己的
               落点**同源**（都由 `styles.css` 的 `--rail-inset` 推导）—— 不再各写一个魔数靠注释互指。
               ⚠️ 手机贴边后这个通道只有 ~32px（原来是 44px）：窄屏横向每一像素都值钱，竖线本身
               只占 ~22px，多让出来的都是白扔的空白。
               用**容器查询**而不是 `md:` 视口断点：挤压来自面板宽度（侧栏 / 右侧分栏都会挤），
               跟视口多宽没关系；阈值 820px 取自「内容右内边距自然值 ≥ 通道」的临界点
               （面板 ≥ 820 时居中留白已经够宽，竖线根本够不着内容）。 */}
        <ConversationContent
          className={cn(
            contentClassName,
            outline && '@max-[820px]:pr-[var(--rail-channel)]',
            // 删除窗口里整块内容压暗 + 不收点击：鼠标滚轮落在滚动容器上，滚动不受影响，
            // 但消息上的操作行（编辑 / 删除 / 签出）与正文链接都点不到
            deleting && 'pointer-events-none opacity-50 transition-opacity'
          )}
        >
          {header}
          {error ? (
            error
          ) : loading && total === 0 ? (
            // 切会话 / 刷新后的历史装载窗口：消息气泡骨架
            <div className="flex flex-col gap-6" aria-busy="true" aria-hidden="true">
              {/* 消息区本身可能透出壁纸（主题背景遮罩），骨架再用 `bg-muted` 会跟底色糊在一起。
                  这里统一加深一档，保证透明背景下也能看见加载中的形状。 */}
              <Skeleton className="h-4 w-1/3 self-end bg-foreground/10" />
              {/* `max-w-full` 挂在**外层**：`self-start` 的 flex 子项按 max-content 收缩，
                  子元素的 `max-w-full` 不参与它的内在宽度计算 —— 窄屏上 26rem 会顶出
                  容器、让消息区横向可拖（并连带禁用侧栏滑动，见 `use-sidebar-swipe.ts`）。 */}
              <div className="flex w-full max-w-[26rem] min-w-0 flex-col gap-2 self-start">
                <Skeleton className="h-4 w-[26rem] max-w-full bg-foreground/10" />
                <Skeleton className="h-4 w-[20rem] max-w-full bg-foreground/10" />
              </div>
              <Skeleton className="h-4 w-1/4 self-end bg-foreground/10" />
              <div className="flex w-full max-w-[26rem] min-w-0 flex-col gap-2 self-start">
                <Skeleton className="h-4 w-[22rem] max-w-full bg-foreground/10" />
              </div>
            </div>
          ) : total === 0 ? (
            <ConversationEmptyState>{emptyState ?? <DefaultEmptyState />}</ConversationEmptyState>
          ) : (
            <>
              {messages.map((message, index) => {
                const isStreamingLast = streaming && index === total - 1
                /** 正在编辑重发的那条：描边 + 压暗，和输入框上方的「编辑消息」条是一对标识 */
                const isEditing = !!editingMessageId && message.id === editingMessageId
                const messageCompaction =
                  compaction && compaction.messageId === message.id ? compaction : null
                const actions = renderActions?.({ message, index, total }) ?? null
                /*
                 * 流式末条**不渲染操作行**（连占位也不）—— 用户明确要求「不要占位」。
                 *
                 * 代价（已知并接受）：操作行是「结束那一帧」才出现的，而滚动是贴底的 ——
                 * 正文的位置只由它下面的内容决定，所以结束那一帧这一行凭空多出的高度
                 * （~28px，加上 `Message` 的 `gap-2` 约 36px）会把正文顶上去一小截。
                 * 这就是最早那个「会话结束后消息列表会跳一下」的成因；用户在看到
                 * 「占位导致底部空白太大」之后，明确选择用「跳一下」换「不留空白」。
                 * ⚠️ 若哪天要把它改回去，做法是：流式末条把**真行**渲染进
                 * `invisible` + `pointer-events-none` 的壳里（`visibility: hidden`，
                 * 不能只用 `opacity-0` —— 挡不住行自己的 `md:group-hover:opacity-100`）。
                 */
                const showActions = !isStreamingLast
                return (
                  <Message
                    key={message.id}
                    from={message.role}
                    // data-message-id + scroll-mt-6：给右侧「消息目录」定位 / 留上边距用。
                    data-message-id={message.id}
                    // 引用片要标「你的消息 / 助手消息」（见 MessageQuoteLayer）：role 只体现在
                    // `is-user` / `is-assistant` class 上，靠 class 判太脆，这里显式给一个属性
                    data-role={message.role}
                    // 有目录时消息的宽度上限，**按面板宽窄分两档**（判据是容器查询，与上面 `pr` 同一口径）：
                    // - **窄面板（≤820px）→ `max-w-full`**：那儿已经由 `--rail-channel` 整段让出了
                    //   竖线通道，再叠一个百分比就是**双重让位** —— 助手的长内容（代码块 / 表格）右缘
                    //   会平白多空出一段（手机上「92% 的剩余宽度 + 44px 通道」合起来能到 ~71px，正是
                    //   用户报的「右侧一大片空白」）。让位只留一处，通道说了算。
                    //   ⚠️ 必须**显式**写 `max-w-full`：ai-elements 的 `Message` 自带 `max-w-[95%]`，
                    //   不覆盖它就还是双重让位（用户消息右对齐不受影响，助手内容是左对齐的，会少一截）。
                    // - **宽面板（>820px）→ 95%**：竖线挪到消息列右侧的空白带里，但面板刚过 820px 时
                    //   那条带还很窄（26px 上下），收一档才留得住余量。
                    // ⚠️ 早先这里写的是 `max-w-[92%] md:max-w-[95%]` —— `md:` 是**视口**断点，于是
                    // 桌面窄分栏会被判成「宽」（95% 叠上通道）、手机反而被多让一次，两头都不对。
                    className={cn(
                      'mb-6 scroll-mt-6',
                      outline && '@max-[820px]:max-w-full @min-[820px]:max-w-[95%]'
                    )}
                  >
                    {/* 正文 15px：ai-elements 默认是 text-base(16px)，用户反馈偏大，收一档。
                        层级仍高于思考 / 工具 / 代码（都是 text-sm 14px）。
                        正在编辑的那条加 `ring` 描边并压暗 —— 圆角沿用用户气泡自身的
                        （`group-[.is-user]:rounded-lg`，改不了 ai-elements 内部，只能靠 ring 描一圈）。 */}
                    <MessageContent
                      className={cn(
                        'text-[0.9375rem]',
                        isEditing && 'opacity-60 ring-2 ring-ring/70 ring-offset-2 ring-offset-background'
                      )}
                    >
                      {/*
                        零 part 的助手消息有两种，必须分开：
                        - **正在跑**：还没吐第一个 part，显示「正在思考…」；
                        - **已经跑完却什么都没吐**（外部 ACP agent 直接 end_turn、模型返回空流…）：
                          绝不能还转圈。原来这里无条件渲染 ThinkingRow，实测「pi-acp 复用会话的
                          第二轮」整轮只有一条 finish 事件 → parts 永远为空 → 界面永久停在
                          「正在思考…」，且一条报错都没有。
                      */}
                      {message.parts.length === 0 && !messageCompaction ? (
                        streaming && isStreamingLast ? (
                          <StreamingStatusNotice retryNotice={retryNotice} reconnectNotice={reconnectNotice} />
                        ) : (
                          <div className="text-sm text-muted-foreground">{tr('（本轮没有返回内容）')}</div>
                        )
                      ) : (
                        <MessageParts
                          message={message}
                          index={index}
                          total={total}
                          streaming={streaming}
                          conversationId={conversationId}
                          followup={followup}
                          compaction={messageCompaction}
                        />
                      )}
                      {/* 思考 / 工具都落地了、整轮还在跑：把「正在思考…」补在消息底部，
                          直到下一个 part 开始（正文 / 思考一开流它就不满足条件了）或整轮停止。
                          与上面 0 part 时的那个是同一个组件，观感一致。 */}
                      {streaming &&
                        message.role === 'assistant' &&
                        isStreamingLast &&
                        messageCompaction?.status !== 'streaming' &&
                        isWaitingNextStep(message.parts) && (
                          <StreamingStatusNotice retryNotice={retryNotice} reconnectNotice={reconnectNotice} />
                        )}
                    </MessageContent>

                    {/* 文档入口：紧贴正文之下（交付物）。「本轮用量」不在这里 —— 它是操作行
                        最前面那颗图标（见 `renderActions` / `MessageActionRow`）。

                        ⚠️ **本轮没结束时一律不渲染**：`write_file` 一返回 `presentedDocsOf`
                        就能认出文档，但流式期间把 chip 挂出来会让「交付物」在模型还没说完时
                        提前出现（还会把下面的内容高度顶一下）。等这一轮真正落定（`isStreamingLast`
                        为假）再显示 —— 与操作行 / 用量的出现时机一致。 */}
                    {!isStreamingLast && renderArtifacts?.(message)}

                    {/* 流式末条整行不渲染（含占位）—— 理由与代价见上面 `showActions` */}
                    {actions && showActions ? actions : null}
                  </Message>
                )
              })}
              {compaction && !compaction.messageId && (
                <Message from="assistant" className="mb-6">
                  <MessageContent className="text-[0.9375rem]">
                    <ContextCompactionCard compaction={compaction} />
                  </MessageContent>
                </Message>
              )}
            </>
          )}
        </ConversationContent>
        {/* 「回到底部」指示器（不贴底时才出现） */}
        <ConversationScrollButton />
      </Conversation>

      {/* 删除进度：悬浮在消息区顶部中央。**绝对定位**而不是塞进消息流 —— 插进流里会让
          内容高度跳一下、还可能把用户的阅读位置顶走（正在被删的恰恰是中间那段历史） */}
      {deleting && (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-2">
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-full border border-border/60 bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            {tr('正在删除消息…')}
          </div>
        </div>
      )}

      {/* 消息目录：右侧拉线时间轴，桌面与窄屏同一形态（见 MessageOutline） */}
      {outline ? <MessageOutline messages={messages} onJump={jumpToMessage} /> : null}

      {/* 会话内查找（Ctrl/Cmd+F）：浮在消息区右上角，不开时不占位（见 chat-find.tsx） */}
      <ChatFind panelRef={panelRef} messages={messages} />
    </div>
  )
}

/** 没给 `emptyState` 时的兜底空态 */
function DefaultEmptyState() {
  const tr = useT()
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <MessageSquare className="size-8 opacity-40" />
      <div className="text-sm font-medium">{tr('还没有消息')}</div>
    </div>
  )
}

/**
 * 「第 N 次重试」提示条（单条自替换）。
 *
 * 调用方用 `key={attempt}` —— 次数变化时整条重建，从而**重放一遍入场动画**
 * （只在同一节点上改文本不会重新触发 CSS 动画）。因为 `retryNotice` 只有一份
 * （每次重试覆盖上一条），屏幕上任何时刻只有这一条。
 */
function RetryRow({ notice }: { notice: { attempt: number; maxRetries: number | null } }) {
  const tr = useT()
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-300"
    >
      <RotateCw className="size-3.5 shrink-0 animate-spin" />
      <span>{tr('第 {attempt} 次重试', { attempt: notice.attempt })}</span>
    </div>
  )
}

/**
 * 流式期间消息底部那一行的**状态提示**：按优先级挑一条渲染。
 *
 * - 断线重接中：连接断了（页面切后台 / 电脑休眠 / 网络切换最常见），服务端那轮还在跑。
 *   这条必须盖过其余两种 —— 不然用户看到「正在思考」转圈，以为模型在憋一个长回答。
 * - 模型重试中：第 N 次重试（重试 = 从头再跑，已渲染的部分被清掉了）。
 * - 其余：普通「正在思考…」。
 */
function StreamingStatusNotice({
  retryNotice,
  reconnectNotice
}: {
  retryNotice: { attempt: number; maxRetries: number | null } | null
  reconnectNotice: { attempt: number } | null
}) {
  const tr = useT()
  if (reconnectNotice) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-300"
      >
        <Unplug className="size-3.5 shrink-0" />
        <span>
          {tr('连接中断，正在重连（第 {attempt} 次）…', { attempt: reconnectNotice.attempt })}
          <span className="ml-1 text-xs">{tr('服务端这一轮还在跑，接上就继续')}</span>
        </span>
      </div>
    )
  }
  if (retryNotice) {
    return <RetryRow notice={retryNotice} />
  }
  return <ThinkingRow />
}

/**
 * 只有「复制」的操作行：容器工作台的历史消息在容器里，改不了也删不掉，
 * 所以 `onEdit` / `onDelete` 都不给（见 `MessageActionRow`）。
 *
 * `onConvert` 可选传入额外挂一颗「从此转为内置 Agent 会话」（只有 ACP 会话用得上）。
 * `usageSlot` 可选传入「本轮用量」那颗图标（与主会话同形：挨在复制左边）。
 */
export function CopyOnlyActions({
  message,
  index,
  total,
  onConvert,
  usageSlot
}: MessageActionArgs & { onConvert?: () => void; usageSlot?: ReactNode }): ReactNode {
  // 含本条在内、从本条往后的消息条数（与主会话同口径）
  return (
    <MessageActionRow
      message={message}
      deleteCount={total - index}
      onConvertFromHere={onConvert}
      usageSlot={usageSlot}
    />
  )
}

// ---------------------------------------------------------------------------
// 输入区
// ---------------------------------------------------------------------------

/**
 * 输入区外壳的两种排布。
 *
 * - `page`（主会话）：整块可滚（待发送队列长了要能滚），列宽与消息列一致（`max-w-3xl`）；
 * - `panel`（容器工作台）：面板可能只有 380px 宽，上下留白收一档，输入框列左右用 `px-3`。
 *
 * ⚠️ 这里以前镜像了消息区滚动容器的 `scrollbar-gutter`（消息列在「面板宽 − 槽位」里居中，
 * 输入框得落在同一坐标系）。现在消息区**不画滚动条也不留槽位**（见 `Conversation`），
 * 宽度恒定，那份补偿已撤掉 —— 别再给哪一侧补 padding 去「对齐槽位」，那会真的错开。
 */
export type ChatComposerVariant = 'page' | 'panel'

export interface ChatComposerProps {
  value: string
  onChange: (value: string) => void
  /** 发送（Enter 或点发送钮） */
  onSubmit: () => void
  /**
   * 插话（传了才会在「跑着 + 有字」时把发送钮换成「队列消息 / 插话」选择器）；
   * 不传 = 无此能力。见 `Composer` 的 `onSteer`。
   */
  onSteer?: () => void
  /** 停止（点停止钮，或输入框里按 Esc） */
  onCancel: () => void
  streaming: boolean
  /** 输入框与发送钮一并不可用（会话未就绪 / 没选工作区…） */
  disabled?: boolean
  /** 只禁发送、不禁输入（手动压缩进行中）：发送钮灰掉、Enter 不出手 */
  sendDisabled?: boolean
  /** 禁发原因（上传附件中等）：传给发送钮 tooltip，不传回落「上下文压缩中」 */
  sendDisabledHint?: string
  /** 有附件没文字也允许发送：解除「草稿为空」对发送钮的禁用（Enter 仍走 sendDisabled） */
  allowEmptySend?: boolean
  /**
   * 提交后到「这一轮真的开跑」之间，把发送钮换成转圈（且不可点）。
   *
   * 只该在这个等待真的明显时才传：目前唯一的使用者是「开始新对话」页选 ACP 后发送 ——
   * 服务端要先起外部 agent 进程、`session/new` 拿到档位才建会话，几百毫秒到几秒，
   * 这段时间界面完全没反应，用户会以为没点上而反复点。内置模型那次往返很快，不必转。
   */
  sending?: boolean
  placeholder?: string
  /** 操作行左侧（工作区 / 权限） */
  leading?: ReactNode
  /** 操作行右侧、**发送钮左边**（模型） */
  trailing?: ReactNode
  /**
   * 输入框卡片内的 `header`（渲染在同一张卡片内，与 textarea 浑然一体），
   * 如主会话的「待发送队列」。
   */
  header?: ReactNode
  /**
   * 输入框**上方**、卡片之外的内容：待答复的权限卡、当前任务卡之类。
   * 与 `header` 的区别是它不带卡片底色与分隔线。
   */
  above?: ReactNode
  /**
   * 输入框**下方**、卡片之外的内容：常驻的「当前工作区」选择行。
   *
   * 与 `above` 对称（同一对齐壳内、卡片外，不带底色）。放在卡片**外**而不是 `leading`：
   * 卡片内的操作行已经挤了权限 / 模型 / 发送，工作区名一长就会把它们挤变形。
   */
  below?: ReactNode
  /** 暴露 textarea 引用（编辑队列消息写回输入框后聚焦用） */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  /**
   * 粘贴 / 拖拽进来的文件（截图、图片、从资源管理器拖来的文件）；透传给 `Composer`。
   * 不传 = 本输入框没有附件区（工作台 / ACP 会话），也不接管粘贴与拖放。
   */
  onAttachFiles?: (files: File[]) => void
  /** 斜线命令（不传 = 无此功能）；透传给 Composer 的 `/` 命令浮层 */
  slashCommands?: import('@fizz/agent-kit/shared/lib/slash-commands').SlashCommand[]
  /** 命令执行上下文（与 slashCommands 一同传） */
  slashContext?: import('@fizz/agent-kit/shared/lib/slash-commands').SlashCommandContext
  variant?: ChatComposerVariant
  /** 紧凑输入框（初始高度一行）—— 窄面板里的助手用，见 Composer 的 compact */
  compact?: boolean
}

/**
 * 会话输入区：与消息列逐像素对齐的壳 + 共用的 `Composer`。
 *
 * 草稿由调用方持有（主会话的在 `PromptInputProvider` 里，工作台的是它自己的 `useState`），
 * 这里不替它们做决定。
 */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onSteer,
  onCancel,
  streaming,
  disabled,
  sendDisabled,
  sendDisabledHint,
  allowEmptySend,
  sending,
  placeholder,
  leading,
  trailing,
  header,
  above,
  below,
  textareaRef,
  onAttachFiles,
  slashCommands,
  slashContext,
  variant = 'page',
  compact
}: ChatComposerProps) {
  const panel = variant === 'panel'
  return (
    <div
      className={panel ? 'shrink-0 pt-3 pb-3 overflow-y-auto' : 'shrink-0 overflow-y-auto'}
    >
      {/*
        ⚠️ `above`（审批卡 / 当前任务卡）与 `Composer` 必须在**同一个对齐壳**里：
        壳只有一处定义（宽度上限 max-w-3xl + 左右内边距），所以权限卡的宽度永远
        与输入框卡片、与消息列逐像素对齐 —— 三者在同一坐标系里。
        以前 `above` 单独套了个 `px-3` 的壳（不限宽），面板一宽权限卡就铺满、输入框
        却限在 768px，同一块区域里两种宽度；现在两者同壳，`space-y-2` 统一给间距
        （卡片自身的 `mb-*` 已去掉，间距不再由卡片自己带 —— 免得两处叠加成 16px）。
      */}
      <div
        className={
          panel
            ? 'mx-auto w-full max-w-3xl space-y-2 px-3'
            : /*
               * 底部内边距从 `sm:pb-6`（24px）收到 `sm:pb-2`（8px）：用户明确要求
               * 「消息列表下面空白太大不能接受」。这一层紧挨着消息区，它的 `pb`
               * 就是「消息列底部 → 输入框卡片」那一段空白的主体（原来 24px）。
               * 顶部维持 `pt-2`：输入框上方要跟消息留出视觉间隔，那一段不算「底部空白」。
               */
              'mx-auto w-full max-w-3xl p-2 sm:px-6 sm:pb-4'
        }
      >
        {above ? <div className="space-y-2 mb-1">{above}</div> : null}
        <Composer
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          onSteer={onSteer}
          onCancel={onCancel}
          streaming={streaming}
          disabled={disabled}
          sendDisabled={sendDisabled}
          sendDisabledHint={sendDisabledHint}
          allowEmptySend={allowEmptySend}
          sending={sending}
          placeholder={placeholder}
          leading={leading}
          trailing={trailing}
          header={header}
          textareaRef={textareaRef}
          onAttachFiles={onAttachFiles}
          slashCommands={slashCommands}
          slashContext={slashContext}
          compact={compact}
        />
        {below ? <div className="flex min-w-0 items-center gap-2 px-1 bg-sidebar/60 rounded-b-lg mx-3">{below}</div> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 组合：会话主界面
// ---------------------------------------------------------------------------

/**
 * 会话主界面：消息列表 + 输入框（+ 落底指示器）。
 *
 * 两个会话视图的**共同骨架**就是这一个组件；调用方只负责传数据与两侧特有的槽位内容。
 *
 * `list` / `composer` 分成两组而不是拍平成一组：`streaming`、`header` 这两个名字两边都有
 * 但**含义不同**（消息列表的 `header` 是消息流上方的 sticky 条，输入区的 `header` 是
 * 卡片内的待发送队列），拍平必然互相盖掉。
 */
export interface ChatSurfaceProps {
  list: Omit<MessageListProps, 'renderActions'> & {
    renderActions?: (args: MessageActionArgs) => ReactNode
  }
  composer: ChatComposerProps
  /** 消息列表与输入框之间的内容（错误条之类） */
  between?: ReactNode
}

export function ChatSurface({ list, composer, between }: ChatSurfaceProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageList {...list} />
      {between}
      <ChatComposer {...composer} />
    </div>
  )
}