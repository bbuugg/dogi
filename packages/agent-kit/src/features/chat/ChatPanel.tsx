/**
 * 对话区：消息流（ai-elements 的 Conversation / Message）+ 输入框（PromptInput）。
 *
 * **结构在 `chat/chat-surface.tsx`**（消息列表 + 输入区 + 落底指示器，与容器工作台共用
 * 同一份）；本文件只负责主会话特有的部分：数据接线、工作区 / 模型 / 权限 pill、
 * 待发送队列、消息级编辑重发与删除。
 *
 * 流式期间最后一条 assistant 消息会不断长大：每个 SSE 帧折进 parts，React 重渲染。
 * 跑起来时右下角那颗钮是「停止」（输入框空着才有），一输入字它就换成**发送方式选择器**
 * ——「队列消息」进待发送队列（本轮结束由泵自动接着发），「插话」插进当前这一轮的下一个
 * 工具步骤边界（进「插入中」列表）。切换逻辑在 `Composer` 的 `sendChooser`。
 *
 * 消息条 hover 会出现操作栏（复制 / 编辑并重发 / 删除从这里重新开始），与桌面端 Agent 对齐。
 * 编辑走「把文本灌进底部输入框 + 标记重发起点」，重发时先删掉该条及其后的全部消息再发；
 * 编辑期间有两处标识：输入框卡片内的「编辑消息」条（写着原文 + 取消）与消息列表里那条消息的
 * 描边压暗（见 `EditMessageBar` 与 `MessageList` 的 `editingMessageId`）。
 */
import {
  AlertTriangle,
  Check,
  Clock,
  Container,
  Download,
  FolderOpen,
  Gauge,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  RotateCcw,
  SendHorizontal,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Unplug,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "sonner";
// 消息渲染零件与共用骨架（消息列表 / 输入区 / 落底指示器）
import {
  AttachmentPreviewRow,
  AttachmentUploadButton,
} from "@fizz/agent-kit/features/chat/attachments";
import {
  ChatComposer,
  ChatSurface,
  CopyOnlyActions,
  type ChatComposerProps,
} from "@fizz/agent-kit/features/chat/chat-surface";
import { ConfirmQueue } from "@fizz/agent-kit/features/chat/ConfirmCard";
import { ConvertAcpDialog } from "@fizz/agent-kit/features/chat/ConvertAcpDialog";
import { ForkDialog } from "@fizz/agent-kit/features/chat/ForkDialog";
import { ModelSelect } from "@fizz/agent-kit/features/chat/ModelSelect";
import { MessageActionRow } from "@fizz/agent-kit/features/chat/message-parts";
import {
  MessageQuoteLayer,
  QuotePreviewRow,
} from "@fizz/agent-kit/features/chat/quotes";
import { requestOpenWorkspaceFile } from "@fizz/agent-kit/features/files/open-file";
import { GitCloneDialog } from "@fizz/agent-kit/features/projects/GitCloneDialog";
import { NewContainerProjectDialog } from "@fizz/agent-kit/features/projects/NewContainerProjectDialog";
import { useDirectoryPicker } from "@fizz/agent-kit/shared/hooks/use-directory-picker";
import { useStateValue } from "@fizz/agent-kit/shared/lib/state-ws";
import { ArtifactChips } from "@fizz/agent-kit/shared/ai-elements/artifact-chips";
import {
  PromptInputProvider,
  usePromptInputController,
} from "@fizz/agent-kit/shared/ai-elements/prompt-input";
import { useConfirm } from "@fizz/agent-kit/shared/components/ConfirmProvider";
import { presentedDocsOf } from "@fizz/agent-kit/shared/lib/artifacts";
import {
  fileRefsOfParts,
  nextAttachmentId,
  readImagePreview,
  sendableAttachments,
  splitUploadable,
  type ChatAttachment,
} from "@fizz/agent-kit/shared/lib/attachments";
import {
  formatDuration,
  formatDurationExact,
} from "@fizz/agent-kit/shared/lib/duration";
import { textOf } from "@fizz/agent-kit/shared/lib/parts";
import { takePendingDraft } from "@fizz/agent-kit/shared/lib/pending-draft";
import {
  buildQuotedText,
  type MessageQuote,
} from "@fizz/agent-kit/shared/lib/quotes";
import type { SlashCommandContext } from "@fizz/agent-kit/shared/lib/slash-commands";
import {
  builtinSlashCommands,
  resolveSlashDispatchFor,
} from "@fizz/agent-kit/shared/lib/slash-commands";
import { supportsTouch } from "@fizz/agent-kit/shared/lib/supports-touch";
import { cn } from "@fizz/agent-kit/shared/lib/utils";
import { Button } from "@fizz/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@fizz/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@fizz/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@fizz/ui/hover-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@fizz/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@fizz/ui/select";
import { Skeleton } from "@fizz/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@fizz/ui/tooltip";
import { SortableRow } from "@fizz/agent-kit/shared/components/SortableRow";
import type {
  UploadFileRef,
  UploadProviderView,
} from "@fizz/contracts/agent-api";
// 输入区外壳 / 发送钮 / 权限 pill 与容器工作台共用一份，见 `./composer`
import {
  CHAT_ICON_PILL,
  CHAT_PILL,
  PermissionPill,
} from "@fizz/agent-kit/features/chat/composer";
import {
  ComposerToolbar,
  ComposerToolbarPlaceholder,
} from "@fizz/agent-kit/features/chat/ComposerToolbar";
// 工作区 / MCP 两颗 pill 的受控版（定时任务表单也用同一份，见 `./pickers`）
import { McpPill, WorkspacePill } from "@fizz/agent-kit/features/chat/pickers";
import { IconTip } from "@fizz/agent-kit/shared/components/IconTip";
import { useAppContext } from "@fizz/agent-kit/shared/hooks/use-app-context";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useAgentStore } from "@fizz/agent-kit/shared/lib/stores/agent-store";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import type { AgentWorkspace } from "@fizz/contracts/agent-api";
import {
  compactionTriggerTokens,
  type ContainerProjectsSnapshot,
  DEFAULT_CONTEXT_WINDOW,
  findModelEntry,
  resolveContextWindow,
  SUBAGENT_META,
  type AgentChatMessage,
  type QueuedMessage,
  type SubagentId,
  type TurnUsage,
} from "@fizz/contracts/types";

/**
 * 会话历史加载失败（mastra 拉存档 / acp session/load 回放）：消息列表处展示错误 + 重试。
 * 不再像以前那样静默吞掉变成「历史丢了」—— 把 agent 侧（OpenCode 等）报的错亮出来，
 * 让用户一键重试。重试只是重跑同一段装载逻辑，不再走 openConversation 的 id 去重早退。
 */
function MessagesLoadError({
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

/**
 * 一轮结束后的**用量统计**：一颗图标按钮，悬停出卡片（TPS / 各项 token / 耗时）。
 *
 * 为什么从「一整行文字」改成「一颗图标 + 悬停卡片」（用户要求）：那一行（输入 / 输出 /
 * 合计 / 思考 / 缓存 / 耗时）比正文还宽，每条助手消息下面都挂一条，把消息列表压得很碎；
 * 而这些数字是**偶尔核对**的元信息，不是每次都要读的正文。收成一颗图标后，
 * 它和「复制 / 编辑 / 删除」那排操作按钮**同一形态、同一套样式**，视觉上归为「操作」而不是「内容」。
 *
 * 图标沿用圆环那套（`Gauge`）：它与输入框那栏的上下文用量圆环是「同一类信息」的两种粒度
 * —— 那颗是「整个会话的上下文占用」，这颗是「这一轮的账目」。
 */
function UsageRow({ usage }: { usage?: TurnUsage }) {
  /*
   * 没有 usage 就整颗不渲染（不再有「占位形态」）。
   * 用户已明确要求「不要占位」：占位会把结束那一帧的高度提前撑起来，而那种
   * invisible 的高度在屏幕上就是一片看不见的空白，代价与收益不成比例。
   */
  const t = useT();
  if (!usage) return null;

  /** 卡片里的一个「标签 + 数值」格；值为空（上游没报）就不渲染这一格 */
  const stat = (label: string, value: number | undefined): ReactNode =>
    value === undefined || value === null ? null : (
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-foreground tabular-nums">
          {value.toLocaleString()}
        </span>
      </div>
    );

  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        {/* 与 `MessageActionRow` 里的复制按钮同一套样式（无边框、hover 底色） */}
        <button
          type="button"
          title={t("本轮用量")}
          aria-label={t("本轮用量")}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <Gauge className="size-4" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-64">
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Gauge className="size-3.5" />
            {t("本轮用量")}
          </div>
          {/*
           * 速度与耗时是「一眼想看」的两个数，放在最上面一行（大一点）。
           * `formatDuration` 短轮次到 0.1s、超一分钟换 `3m 45s`；精确毫秒值放 title。
           */}
          <div
            className="flex items-baseline gap-1.5"
            title={t("整轮耗时 {time}", { time: formatDurationExact(usage.durationMs) })}
          >
            <span className="text-lg font-semibold tabular-nums">
              {usage.tps}
            </span>
            <span className="text-muted-foreground">tok/s</span>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {formatDuration(usage.durationMs)}
            </span>
          </div>
          <div className="space-y-0.5 border-t pt-1.5">
            {stat(t("输入"), usage.inputTokens)}
            {stat(t("输出"), usage.outputTokens)}
            {stat(t("合计"), usage.totalTokens)}
            {stat(t("思考"), usage.reasoningTokens)}
            {stat(t("缓存命中"), usage.cachedInputTokens)}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * 刚登记进来的工作区 / 项目：选中它、回到空会话。
 *
 * `addWorkspace` / `cloneWorkspace` 都已经在 store 里 `await refresh()` 过，拿到返回值时
 * 它已经在列表里了 —— 所以直接按 id 选，不用「等列表刷新 → 按路径找回来」那一跳。
 */
function selectNewWorkspace(app: AgentApp, ws: AgentWorkspace): void {
  app.selectWorkspace(ws.id);
  void app.openConversation(null);
}

/**
 * 输入框**下方**的工作区选择行（**只在空会话时**出现）。
 *
 * 分工：顶栏那行是「这个会话属于哪个项目」的只读事实，这里是**下一条消息**的归属 ——
 * 会话的 `workspaceId` 落库后不可改，所以切换 = 回空会话，下一条消息按新归属新建。
 * 正因为进了会话就改不了，这一行在会话里一律收起（见 `useMainComposerProps` 的
 * `below`）：摆在那儿只会让人以为能改当前会话的归属。
 *
 * 「未指定工作区」**不是一种归属**，只是这一行上的「还没选」：真发消息时服务端会为这条
 * 会话建一个临时工作区（目录 `<数据目录>/conversations/<会话 id>`）再绑上去 —— 会话永远
 * 挂在真实工作区上，文件工具 / 终端 / 技能都能用。所以这里的 `null` 只活到发送为止。
 */
function WorkspaceSelect({ app }: { app: AgentApp }) {
  const t = useT();
  /**
   * 「添加项目」的三种方式里，只有 Git / 容器需要记状态（它们各开一个弹窗）；
   * 选目录那一路直接 `await pick()`。
   *
   * ⚠️ 侧栏那颗「+」**已经删掉**了，加项目只剩这一处入口（加上「还没有项目」页）——
   * 别再把入口往回加，两处维护同一组弹窗迟早会漂。
   */
  const [addMode, setAddMode] = useState<"git" | "container" | null>(null);
  /** 容器型项目的唯一能力门控（服务端有 docker 才有这个选项） */
  const containerProjects = useStateValue<ContainerProjectsSnapshot>(
    "containerProjects",
    { available: false, projects: [] },
  );

  /**
   * 选目录：桌面端弹**系统目录框**，web 才用内置的服务端目录浏览器。
   * 工作区登记的是「跑 Agent 那台机器」上的路径 —— 桌面端后端就在本进程里，是同一台机器。
   */
  const { pick, node: dirPicker } = useDirectoryPicker(
    app,
    t("这里列的是服务端上的目录（Agent 就跑在那台机器上）。选中的目录会登记为项目。"),
  );

  const addDir = (path: string): void => {
    void app.addWorkspace({ path }).then((ws) => {
      if (ws) selectNewWorkspace(app, ws);
    });
  };

  const pickDir = (): void => {
    void pick().then((path) => {
      if (path) addDir(path);
    });
  };

  return (
    <>
      {/* 长相与交互在 `pickers.tsx` 的 `WorkspacePill`（定时任务表单也用同一颗）。
          「未指定工作区」= `null`：发送时服务端建临时工作区（见 `newConversation`）。 */}
      <WorkspacePill
        value={app.activeWorkspaceId}
        workspaces={app.workspaces.filter(
          // 临时工作区不进这个列表：它是「不选项目」发消息后自动建的，
          // 再把它们列出来等于让人能手动选一个 uuid 目录
          (workspace) => workspace.path && !workspace.scratch,
        )}
        onChange={(next) => {
          // 只决定**下一条消息**的归属（会话的 workspaceId 落库后不可改）。
          // 这一行平时只在空会话里出现，这里再退一次空会话是兜底：将来若有人把它放回会话页，
          // 也不会让人误以为改的是当前会话的归属。
          app.selectWorkspace(next, false);
          if (app.activeConversationId) void app.openConversation(null);
        }}
        actions={[
          { value: "__add_dir__", label: t("选择文件夹…") },
          { value: "__add_git__", label: t("从 Git 导入…") },
          // 容器型项目：服务端有 docker 才出现（目录由服务端固定生成，用户不可选）
          ...(containerProjects.available
            ? [{ value: "__add_container__", label: t("新建容器型项目…") }]
            : []),
        ]}
        onAction={(action) => {
          if (action === "__add_dir__") pickDir();
          else if (action === "__add_container__") setAddMode("container");
          else setAddMode("git");
        }}
        title={t("工作区：Agent 只能读写这个目录里的东西。切换会回到空会话（会话归属不可改）")}
      />
      {/* 桌面端是系统目录框（这里为 null），web 才是内置的服务端目录浏览器 */}
      {dirPicker}
      <GitCloneDialog
        app={app}
        open={addMode === "git"}
        onOpenChange={(open) => setAddMode(open ? "git" : null)}
        onCloned={(ws) => selectNewWorkspace(app, ws)}
      />
      <NewContainerProjectDialog
        app={app}
        open={addMode === "container"}
        onOpenChange={(open) => setAddMode(open ? "container" : null)}
        onCreated={(ws) => selectNewWorkspace(app, ws)}
      />
    </>
  );
}

/**
 * 一个项目都没有时的画面：提示 + 「添加项目」入口。
 *
 * 走的是与侧栏「项目」组同一条路（服务端目录浏览器 → addWorkspace）。添加成功后
 * 选中它、回到空会话 —— 初始页（输入框）自然接上，提示语也会指到新项目。
 */
function NoProjectsView({ app }: { app: AgentApp }) {
  const t = useT();
  /** 同 `WorkspaceSelect`：Git / 容器各开一个弹窗，选目录直接 await（见下） */
  const [addMode, setAddMode] = useState<"git" | "container" | null>(null);
  /** 容器型项目的能力门控（与输入区那颗下拉同一份数据） */
  const containerProjects = useStateValue<ContainerProjectsSnapshot>(
    "containerProjects",
    { available: false, projects: [] },
  );

  /** 同上：桌面端系统框、web 服务端目录浏览器 */
  const { pick, node: dirPicker } = useDirectoryPicker(
    app,
    t("这里列的是服务端上的目录（Agent 就跑在那台机器上）。选中的目录会登记为项目。"),
  );

  /** 选完就登记 + 选中（取消 → null，什么都不做） */
  const pickDir = (): void => {
    void pick().then((path) => {
      if (!path) return;
      void app.addWorkspace({ path }).then((ws) => {
        if (ws) selectNewWorkspace(app, ws);
      });
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-3 sm:px-6 pb-20">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <FolderOpen className="size-10 text-muted-foreground/40" />
        <div className="text-lg font-semibold">{t("还没有项目")}</div>
        <div className="text-xs leading-5 text-muted-foreground">
          {t("添加一个本地目录，或从 Git 地址克隆导入开始使用。")}
          <br />
          {t("也可以不绑定项目，直接开始对话（会话存在服务端）。")}
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <FolderOpen className="size-4" />
                {t("添加项目")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuItem onSelect={pickDir}>
                <FolderOpen className="size-4" />
                {t("选择目录…")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAddMode("git")}>
                <Download className="size-4" />{t("从 Git 导入…")}
              </DropdownMenuItem>
              {/* 容器型项目：服务端有 docker 才有入口（目录固定、打开即起容器、彼此隔离） */}
              {containerProjects.available && (
                <DropdownMenuItem onSelect={() => setAddMode("container")}>
                  <Container className="size-4" />
                  {t("新建容器型项目…")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              // 不选项目 + 明确要空态：两者都要，否则 gate 还会把人拦回这一页
              app.selectWorkspace(null, false);
              app.openConversation(null);
            }}
          >
            {t("直接开始对话")}
          </Button>
        </div>
      </div>
      {/* 桌面端是系统目录框（这里为 null），web 才是内置的服务端目录浏览器 */}
      {dirPicker}
      <GitCloneDialog
        app={app}
        open={addMode === "git"}
        onOpenChange={(open) => setAddMode(open ? "git" : null)}
        onCloned={(ws) => selectNewWorkspace(app, ws)}
      />
      <NewContainerProjectDialog
        app={app}
        open={addMode === "container"}
        onOpenChange={(open) => setAddMode(open ? "container" : null)}
        onCreated={(ws) => selectNewWorkspace(app, ws)}
      />
    </div>
  );
}

/**
 * 初始页骨架（刷新后的加载窗口）：形状对齐「开始新对话」页 —— 标题 + 提示 + 输入卡片。
 * 工作区列表没拉回来之前**不成立**「还没有项目」这个结论，所以先上骨架屏别闪空态。
 */
function NewTaskSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-3 sm:px-6 pb-20">
      <div className="w-full max-w-2xl" aria-busy="true" aria-hidden="true">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3 w-64" />
        </div>
        <div className="rounded-xl border border-border bg-card/60 p-3">
          <Skeleton className="h-16 w-full" />
          <div className="mt-3 flex items-center justify-between">
            <Skeleton className="h-6 w-28 rounded-full" />
            <Skeleton className="h-8 w-20 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** 初始页：中央输入框 + 下方常驻的工作区选择行（不绑定项目也能直接聊） */
function NewTaskView({ app }: { app: AgentApp }) {
  const t = useT()
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-3 sm:px-6 pb-20">
      <div className="w-full max-w-2xl">
        <div className="mb-5 flex flex-col items-center gap-1 text-center space-y-4">
          <div className="text-lg font-semibold">{t('开始新对话')}</div>
        </div>
        {/* 草稿在「确认开跑」后才清：建 ACP 会话要先起外部进程，失败时输入框必须还在 */}
        <ChatComposer
          {...useMainComposerProps(app, {
            onSubmit: (text, onStarted) => app.send(text, undefined, onStarted)
          })}
        />
      </div>
    </div>
  );
}

/**
 * 「一个上传源都没有」的**共享空数组**：上传源清单是异步拉的，拉不到 / 还没拉到时用它。
 * 用同一个引用是为了让 `setState` 能 bail out（每次 `[]` 都是新引用，会白跑一轮渲染）。
 */
const NO_UPLOAD_PROVIDERS: UploadProviderView[] = [];

/** 已打开的会话是不是 ACP 会话（消息操作行这类「会话内」的事用它）；没打开会话 = false */
function activeConversationIsAcp(app: AgentApp): boolean {
  return (
    app.conversations.find((c) => c.id === app.activeConversationId)
      ?.backend === "acp"
  );
}

/**
 * 下一轮会不会走 ACP —— 输入框那一排（工具权限 / 上下文圆环）按它决定给不给。
 *
 * 会话已定型就以会话为准；**没有会话时看 `chatTarget`** —— 「开始新对话」页现在允许
 * 直接选外部 Agent（见 ModelSelect 的 ACP 组），所以这一支不是兜底，是新任务页的正路：
 * 选中即写 `chatTarget`，档位由 `probeDraftAcp` 探回来（见 `AcpModePill` 的草稿分支）。
 */
function turnIsAcp(app: AgentApp): boolean {
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  return conversation
    ? conversation.backend === "acp"
    : app.chatTarget?.backend === "acp";
}

/**
 * 主会话输入区的接线：草稿（`PromptInputProvider`）/ 发送 / 停止 / 两侧 pill。
 *
 * 「开始新对话」初始页与正式会话共用这一份 —— 两边的输入框本来就该一模一样，初始页只是
 * 没有重发起点（不传 `editing`，输入框里也不会出现「编辑消息」条）。
 *
 * @param onSubmit 已 trim 的文本。**普通发送与「编辑并重发」的区分留给调用方** —— 初始页
 *   永远只是发新消息，正式会话还要先删掉被编辑那条及其后的消息（`resendMessage`）。
 */
function useMainComposerProps(
  app: AgentApp,
  opts: {
    /**
     * 提交一条草稿。第二个参数是「这一轮确认开跑」的回调（由 store 的 `onStarted`
     * 一路透传而来）—— **输入框只在这里清**，不在提交那一刻清。
     *
     * 为什么不看返回值：`send` 返回的 Promise 要等整轮跑完才 resolve，等它清会把草稿
     * 一直留在输入框里；而「开始新对话」建 ACP 会话要起外部进程，失败时又不能把用户
     * 写的内容吃掉。`onStarted` 恰好是「会话已建好、消息已落本地」那一刻。
     */
    onSubmit: (text: string, onStarted: () => void) => void | boolean | Promise<boolean>;
    /**
     * 插话：跑一轮时发送钮选「插话」后调用（文本已 trim，`files` 是本次要带走的
     * 可发附件）。不传（初始页）/ ACP 会话 / 编辑态下都不暴露这颗钮的能力 ——
     * 那时「跑着 + 有内容」仍只给普通发送。`onStarted` 语义同 `onSubmit`。
     */
    onSteer?: (
      text: string,
      files: UploadFileRef[],
      onStarted: () => void,
    ) => void | boolean | Promise<boolean>;
    /** 暴露 textarea 引用（编辑队列消息写回输入框后聚焦用）；不传则内部自建 */
    textareaRef?: RefObject<HTMLTextAreaElement | null>;
    /** 正在编辑重发的那条消息（非空时输入框卡片内显示「编辑消息」条）；初始页没有 */
    editing?: EditingMessage | null;
    /** 退出编辑态：清编辑标记 + 清输入框里的草稿 */
    onCancelEdit?: () => void;
    /** 正在编辑的插话（非空时输入框卡片内显示「编辑插话」条）；不传 = 无此功能 */
    editingSteer?: EditingSteer | null;
    /** 退出插话编辑态：清编辑标记 + 清输入框里的草稿 */
    onCancelEditSteer?: () => void;
    /** 点「插入中」列表的 ✎：写回输入框 + 撤回收件箱 + 记编辑态（见 ChatPanelInner） */
    onEditSteer?: (item: AgentChatMessage) => void;
    /** 待发送附件（输入卡片 header 的预览行 + 发送门控）；不传 = 无附件交互 */
    attachments?: ChatAttachment[];
    /** 上传入口选中文件（回形针 → 图片 / PDF）；不传 = 不渲染上传按钮、也不接管粘贴与拖放 */
    onPickFiles?: (files: FileList | File[]) => void;
    /** 可用上传源（内置 + 插件注册的）；不传 / 只有一个 = 上传菜单里不出现选择器 */
    uploadProviders?: UploadProviderView[];
    /** 当前选中的上传源（null = 用服务端的缺省那个） */
    uploadProviderId?: string | null;
    /** 切换上传源（选择状态归 ChatPanel 持有） */
    onSelectUploadProvider?: (id: string) => void;
    /**
     * 重新拉一遍上传源清单。上传按钮在**菜单打开时**调它 —— 这样在设置里刚启用的
     * 上传插件不必等切换项目 / 刷新页面。
     */
    onRefreshUploadProviders?: () => void;
    /**
     * 粘贴（截图 / 复制的图片）或拖拽进来的文件 —— 与 `onPickFiles` 是同一条链路，
     * 只是入口不同。不传 = 输入框不接管粘贴与拖放（空态）。
     */
    onAttachFiles?: (files: File[]) => void;
    /** 从预览行移除一条附件 */
    onRemoveAttachment?: (id: string) => void;
    /** 队列「编辑」写回时还原附件（seed 用来生成稳定的附件 id） */
    onRestoreQueueFiles?: (files: UploadFileRef[], seed: string) => void;
    /**
     * 已挂上的引用片（划选消息里的文字得到）：输入卡片 header 里显示、
     * 发送时拼进正文。不传 = 本输入框没有引用交互（初始页）。
     */
    quotes?: MessageQuote[];
    /** 移除一片引用 */
    onRemoveQuote?: (id: string) => void;
  },
): ChatComposerProps {
  const t = useT()
  const { textInput } = usePromptInputController();
  /**
   * 提交那一刻的草稿 / 最新草稿：`onStarted` 可能在几百毫秒后才到（ACP 建会话），
   * 这期间用户可能已经在输入框里改了字 —— 只有「还是提交的那一份」才清，
   * 别把人新敲的内容一起抹掉。
   */
  const latestDraftRef = useRef(textInput.value);
  latestDraftRef.current = textInput.value;
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = opts.textareaRef ?? ownRef;
  const { streaming, activeWorkspace } = app;
  const isAcp = turnIsAcp(app);
  const running = streaming;
  const slashContext: SlashCommandContext = { app, running };
  /**
   * 插话能力：只给 **mastra 后端的已打开会话** —— steer 依赖服务端把消息注入
   * mastra 循环，ACP 会话的协议给不了；初始页（还没有会话）也没有「当前这一轮」可插。
   */
  const canSteer = !!app.activeConversationId && !isAcp;
  /**
   * 命令分发（submit 路径）：浮层只在「前缀输入阶段」开着，带了参数后 Enter 走的
   * 就是这里 —— 例如 `/{命令} 参数` 若不在这里接住会被当正文发出去。
   *
   * ⚠️ 「是不是命令」只看 **`/名字` 形状**，**不是**「以 `/` 开头」：以 `/` 开头的
   * 路径、正则、分隔符（`/usr/local/bin` 那种）是用户要发的正文，早先这里
   * 只要看见 `/` 就报「未知命令」并吞掉，现在由 `resolveSlashDispatchFor` 兜回
   * text 分支照常发送（用户报的 bug）。名字不在表里的 `/xxx` 同样归 text
   * （用户要求：认不出就照发，别拦正文）；拦下的只剩缺参数 / 当前会话不可用。
   * 编辑重发态不分发：那段文本是要原样重发的旧消息，不是命令语境。
   */
  const dispatchSlashCommand = (text: string): boolean => {
    const all = builtinSlashCommands(slashContext);
    const outcome = resolveSlashDispatchFor(text, all, (c) =>
      c.available ? c.available(slashContext) : true,
    );
    if (outcome.kind === "run") {
      outcome.command.run(slashContext, outcome.args);
      return true;
    }
    if (outcome.kind === "reject") {
      app.setError(outcome.message);
      return true;
    }
    return false;
  };

  /**
   * 「这一轮确认开跑」后才收草稿。
   *
   * 发送路径上原本是「提交即清、被拦下再异步回填」，但「开始新对话」建 ACP 会话
   * 要先起外部 agent 进程 + `session/new`，空窗有几百毫秒到几秒；建会话失败时草稿
   * 虽然会被回填，中间那段「输入框空了」足够让用户以为消息丢了（用户报过）。
   * 改成只由 store 的 `onStarted` 驱动：会话没建出来就一个字都没动过。
   *
   * 回填兜底也一并去掉：只有真发出去才会调用这里，不需要「先清再还」。
   */
  const clearDraftAfterStarted = (draft: string): void => {
    if (latestDraftRef.current === draft) textInput.clear();
  };

  return {
    value: textInput.value,
    onChange: textInput.setInput,
    onSubmit: () => {
      const trimmed = textInput.value.trim();
      // 「只发附件、不打字」也放行（附件本身就是有效内容）：空正文守卫不能把
      // 带完成附件的提交拦在这里 —— ChatPanelInner.onSubmit 才是附件感知的那层。
      // 只挂引用不打字同理放行（引用内容本身就是有效上下文）
      const hasSendableAttachment = (opts.attachments ?? []).some(
        (a) => a.uploaded && a.url,
      );
      const hasQuote = (opts.quotes ?? []).length > 0;
      if (!trimmed && !hasSendableAttachment && !hasQuote) return;
      // 手动压缩进行中禁发（双保险：发送钮已灰、Enter 已拦在 Composer，这里兜住队列等入口）
      if (app.contextCompressing) return;
      // 编辑态不分发命令：重发原文 / 编辑中的插话不是命令语境（与编辑重发同理由）
      if (
        !opts.editing &&
        !opts.editingSteer &&
        dispatchSlashCommand(trimmed)
      ) {
        textInput.clear();
        return;
      }
      opts.onSubmit(trimmed, () => clearDraftAfterStarted(trimmed));
    },
    // 插话（发送钮选择器的一项）：只在「已打开会话 + 非 ACP + 非编辑态」时暴露给
    // Composer，否则发送钮保持普通发送。草稿与附件的读取、清空在这里统一处理，
    // 调用方（ChatPanelInner）只管把文本 + 附件送进收件箱。
    ...(canSteer && opts.onSteer && !opts.editing && !opts.editingSteer
      ? {
          onSteer: () => {
            const trimmed = textInput.value.trim();
            const files = sendableAttachments(opts.attachments ?? []);
            // 空草稿 + 无附件 + 无引用 = 没有要插的内容；只带附件 / 只带引用都合法
            if (
              !trimmed &&
              files.length === 0 &&
              (opts.quotes ?? []).length === 0
            )
              return;
            // 手动压缩进行中禁发（与 onSubmit 同一道守卫）
            if (app.contextCompressing) return;
            opts.onSteer?.(trimmed, files, () => clearDraftAfterStarted(trimmed));
          },
        }
      : {}),
    onCancel: () => void app.stop(),
    streaming,
    // 没有工作区也能聊（无项目会话）：不再按 `!activeWorkspace` 整体禁用输入框
    disabled: false,
    // 上传中的附件禁发（连同压缩中的合并进 sendDisabled：Enter 与发送钮一起拦）
    sendDisabled:
      app.contextCompressing ||
      (opts.attachments ?? []).some((a) => !a.uploaded && !a.error),
    // 禁发原因说明（上传优先于压缩文案：两个同时为真时用户该先等上传）
    sendDisabledHint: (opts.attachments ?? []).some(
      (a) => !a.uploaded && !a.error,
    )
      ? t("附件上传中，等上传完成后再发")
      : undefined,
    // 有附件没文字也允许发（附件本身就是有效内容）；只有引用没文字同理
    allowEmptySend:
      (opts.attachments ?? []).length > 0 || (opts.quotes ?? []).length > 0,
    /**
     * 「发送即建会话」期间发送钮转圈（见 store 的 `creatingConversation`）。
     *
     * 只有**还没打开会话**时才有意义：已打开的会话发消息不建会话，`send` 直接进
     * `runRound` 的流式那一段，转圈会变成「点了没反应又忽然开始流」。ACP 那条路最慢
     * （起外部 agent 进程 + `session/new`），内置模型也一并转 —— 反正都是同一条建会话链路，
     * 分支只会多一处不一致。
     */
    sending: !app.activeConversationId && app.creatingConversation,
    placeholder: activeWorkspace
      ? t("交给 Agent 做点什么…（Enter 发送，Shift+Enter 换行）")
      : t("有什么想问的？…（不绑定项目，会话存在服务端）"),
    // 输入框卡片内（`header`）从上到下三块：编辑条（正在改哪条历史）/ 编辑插话条
    // （正在改哪条未生效插话）/ 插入中列表 + 待发送队列，都与输入框浑然一体
    //（各自自带底部分隔线）
    //
    // ⚠️ 这里**刻意不再挂 `DndProvider`**：整个应用的唯一 manager 由 `app-shell`
    // 的根 provider 提供（它传了自定义 `context`，见那里的 `DND_CONTEXT` 注释）。
    // 之前在这里再挂一个，StrictMode 把单例槽清空后它就会**再造一个 HTML5 后端** ——
    // 队列 / 插话列表挂到新后端、标签页落区还挂在旧后端上，表现为「拖拽落区永远不响应」。
    // 直接用 Fragment 包住即可，队列与插话两张列表照样共用同一个 manager。
    header: (
      <>
        {(opts.quotes ?? []).length > 0 && opts.onRemoveQuote ? (
          <QuotePreviewRow
            quotes={opts.quotes ?? []}
            onRemove={opts.onRemoveQuote}
          />
        ) : null}
        {(opts.attachments ?? []).length > 0 && opts.onRemoveAttachment ? (
          <AttachmentPreviewRow
            attachments={opts.attachments ?? []}
            onRemove={opts.onRemoveAttachment}
          />
        ) : null}
        {opts.editing ? (
          <EditMessageBar
            text={opts.editing.text}
            onCancel={opts.onCancelEdit}
          />
        ) : null}
        {opts.editingSteer ? (
          <SteerEditBar
            text={opts.editingSteer.text}
            onCancel={opts.onCancelEditSteer}
          />
        ) : null}
        <PendingSteers app={app} onEdit={opts.onEditSteer} />
        <QueuedMessages
          app={app}
          onEdit={(item) => {
            // 点队列「编辑」：把这条（文本 + 附件）回填到输入框、移出队列，并聚焦输入框。
            // 附件回显回调由 ChatPanelInner 注入（restoreAttachments 在那边）
            textInput.setInput(item.text);
            opts.onRestoreQueueFiles?.(item.files ?? [], `queue-${item.id}`);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
        />
      </>
    ),
    // 输入框卡片上方：工具条（能力开关，常驻）+ confirm 模式待答复的审批
    //（工具卡默认折叠，折起来就等于没提示，所以审批卡也要放这儿）。
    // 工具条排在审批卡之上：它常驻、位置固定，审批卡插在它与输入框之间
    above: (
      <>
        {/* 浏览器 / MCP 开关只在 mastra（本地）链路生效：browser_* 工具与提示词里的浏览器
            说明只在那边注入，ACP 走外部 agent，这套开关对它无效。
            ⚠️ 但 ACP 下**不能整行不渲染** —— 这一行高 32px，少了它输入框卡片会往上跳，
            在「开始新对话」页切「内置 ↔ 外部 Agent」时整块输入区上下抖。用同高占位顶住。 */}
        {isAcp ? (
          <ComposerToolbarPlaceholder mcp={app.mcpServers.length > 0} />
        ) : (
          <ComposerToolbar app={app}>
            {/* MCP 从 `trailing` 搬上来：它与浏览器同属「给这一轮装能力」 */}
            <McpSelect app={app} />
          </ComposerToolbar>
        )}
        {app.pendingConfirms.length > 0 && (
          <ConfirmQueue
            confirms={app.pendingConfirms}
            onResolve={app.resolveConfirm}
          />
        )}
      </>
    ),
    /*
     * 输入卡片**下方**：工作区选择行（含「未指定工作区」）——**只在空会话时**出现。
     *
     * 会话的 `workspaceId` 落库后不可改，进了会话还摆一行「切换工作区」只会让人以为
     * 能改当前会话的归属（点它其实只会把人踢回空会话）。会话的归属在顶栏那行只读
     * 事实里看就够了；要换归属就点「新建会话」回空态，那一行自然又出现。
     */
    below: app.activeConversationId ? null : <WorkspaceSelect app={app} />,
    leading: (
      <>
        {/* 上传附件：mastra 会话专属（ACP 链路只发纯文本）——排在最左，与 ainav 的回形针一致 */}
        {!isAcp && opts.onPickFiles && (
          <AttachmentUploadButton
            disabled={!activeWorkspace}
            onPick={opts.onPickFiles}
            providers={opts.uploadProviders}
            providerId={opts.uploadProviderId}
            onSelectProvider={opts.onSelectUploadProvider}
            onMenuOpen={opts.onRefreshUploadProviders}
          />
        )}
        {/* 工具权限：非 ACP 会话用内置三档 `permissionMode` —— 只有 mastra 那条路读它
            （runAgent → tools 的 guardWrite）。ACP 那边要控权限是 agent 自己发
            session/request_permission，所以这里给的是**答复策略**（确认 / 完全放行，按会话记住）；
            agent 自己的模式（opencode 的 build / plan）在右侧模型选择器之后 */}
        {isAcp ? (
          <AcpPermissionPill app={app} />
        ) : (
          <PermissionPill
            value={app.permissionMode}
            onChange={app.setPermissionMode}
          />
        )}
      </>
    ),
    trailing: (
      <>
        {/* 上下文用量圆环：模型选择左侧；点击出详情 + 手动压缩。
            ACP 会话也渲染：agent 通过 session/update 的 usage_update 上报占用
            （→ 流事件 context-usage → 消息的 contextUsage），圆环用 agent 实测的
            分子 / 分母；本地压缩那几项对 ACP 不可用，组件里按 isAcp 隐掉 */}
        <ContextRing app={app} />
        <ModelSelect app={app} />
        {/* 模式：**只有 opencode 风格**才显示（build / plan），摆在模型选择器之后；
            没有模式时返回 null —— 不做中性 pill */}
        <AcpModePill app={app} />
        {/* 思考档：**只有 pi 风格**才显示（pi 用 configOptions 的 thought_level 表达它，
            不是 Session Modes）；没有思考档时返回 null */}
        <AcpThoughtLevelSelect app={app} />
      </>
    ),
    textareaRef,
    // 粘贴 / 拖拽进来的文件走同一条上传链路（`onPickFiles` 已能收 File[]）
    onAttachFiles: opts.onAttachFiles,
    // 斜线命令：`/` 浮出列表（Composer 渲染浮层，提交分发在 dispatchSlashCommand）。
    // 编辑态（重发 / 插话）不给命令 —— 那段文本不是命令语境
    ...(opts.editing || opts.editingSteer
      ? {}
      : {
          slashCommands: builtinSlashCommands(slashContext),
          slashContext,
        }),
  };
}

/**
 * 正在编辑重发的那条消息：`id` 是重发起点（重发时从它起删历史），`text` 是**原文**。
 *
 * 存原文而不只存 id：用户会在输入框里接着改，编辑条要引的是「改的是哪一条」的原文，
 * 拿输入框当前值当会在改了一半之后变成自引自。
 */
export interface EditingMessage {
  id: string;
  text: string;
  /** 消息所属会话：换会话后这条编辑态立刻作废（id 只在那个会话里有意义） */
  conversationId: string | null;
}

/**
 * 正在编辑的插话（插入中列表的 ✎）：`id` 只用来在收件箱里认「是哪条」，`text` 是**原文**
 * （引在编辑条上，用户改了草稿后仍能认出改的是哪条）。
 *
 * ⚠️ 点 ✎ 时就已把它移出收件箱（agent 从此看不到它），所以这里**不按收件箱成员关系
 * 校验** —— 收件箱里必然已经没有它了。有效性只看两件事：还在同一个会话、本轮还在跑
 * （跑完 = 收件箱语义已消失，重发就该是普通发送）。
 */
export interface EditingSteer {
  id: string;
  text: string;
  conversationId: string | null;
}

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
function EditMessageBar({
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

/**
 * 编辑插话的提示条：结构与 `EditMessageBar` 同款，语义不同 —— 点 ✎ 时这条插话**已经
 * 移出收件箱**（agent 看不到了），发送后走 `steer` 重新插回当前轮（跑完则回落普通发送）。
 */
function SteerEditBar({
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

/**
 * 两张待发送列表（队列 / 插话）共用的规矩 —— 内容与交互都对齐，只是语义不同：
 *
 * - **固定高度 + 内部滚动**：不管几条都是同一块高（`LIST_HEIGHT_CLASS`），多了自己滚 ——
 *   消息条跟着往上顶会把输入框和发送钮挤出屏幕，那种抖动比滚动更难接受。
 * - **可拖拽排序**（抓左侧那颗把手上下拖）：数组顺序就是顺序，松手即同步服务端。
 *   指示器**只有一种**（拖拽把手），不按设备分叉成「桌面把手 / 触屏 ↑↓」—— 两套指示器并排
 *   会让「怎么拖」在换设备后整个变样。触屏上 HTML5 后端起不动（浏览器不给 touch 派发
 *   `dragstart`），那一路由把手自己扛：指针捕获 + 「指针下是哪一行就插到哪一行前」，
 *   规则与桌面 `hover` 完全一致（见 `SortableRow`）。
 *   **`SortableRow` 是共享组件**（`shared/components/SortableRow`，manager 来自 `app-shell`
 *   的根 provider）：队列 / 插话两张列表，以及「快捷功能」管理弹窗都用它，排序交互因此
 *   天然一致；差别只在正文与右边的按钮各自属于哪个列表。
 * - 各图标的说明走 Tooltip（`./ui/tooltip`，不用原生 title），正文默认**一行**、超出部分
 *   截断；截断时点击正文弹 Dialog 看全文（手机上没法悬停，也不能就地展开把列表挤走）。
 *   见 `ExpandableRowText`。
 */

/**
 * 队列条目的拖拽类型。顺序 = 「本轮结束后依次发」的顺序。
 * 与 `STEER_ITEM_TYPE` 分开是刻意的：跨列表拖拽没有语义，靠类型让两张列表互不接受。
 */
const QUEUE_ITEM_TYPE = "queued-message";

/**
 * 插话列表的拖拽类型：与队列**刻意分开** —— 两种东西的排序意义不同（队列决定「本轮结束后
 * 依次发」的顺序，插话决定「下一个工具步骤边界谁先被消费」），跨列表拖拽没有语义，
 * 靠类型隔离让两张列表互不接受对方的拖拽。
 */
const STEER_ITEM_TYPE = "pending-steer";

/**
 * 待发送列表（队列 / 插话两张共用）的固定高度：约 3 条多。别改成 `max-h-" + 内容高度`：
 * 高度跟着条数变 = 输入框被顶得上下跳，Enter 之后尤其明显。
 */
const LIST_HEIGHT_CLASS = "max-h-[104px]";

export function QueuedMessages({
  app,
  onEdit,
}: {
  app: AgentApp;
  /** 点「编辑」：把这条（文本 + 附件）写回输入框，由调用方负责移出队列 */
  onEdit: (item: QueuedMessage) => void;
}) {
  const t = useT();
  const items = app.queuedMessages;
  const running = app.streaming;
  // 触屏上 HTML5 拖拽起不动：那些设备改由把手自己扛指针事件（见 QueuedRow / SortableRow）
  const canTouch = supportsTouch();
  const confirm = useConfirm();
  /**
   * 「清空队列」也要二次确认：它一次丢掉**全部**未发送的消息（含附件），且不可撤销 ——
   * 恰恰是那排里最容易误点的一个按钮（就挨着「继续发下一条」）。
   */
  const onClear = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t("清空队列里的 {count} 条消息？", { count: items.length }),
      description: t("这些都还没发出去，清空后就没了。"),
      confirmLabel: t("清空"),
      destructive: true,
    });
    if (ok) app.clearQueuedMessages();
  }, [app, confirm, items.length]);
  /**
   * ⚠️ 这个提前返回**必须放在所有 Hook 之后**。
   *
   * 之前它写在 `useConfirm` / `useCallback` 之前：队列从 0 条变 1 条时，这次渲染
   * 突然比上一次多跑了两个 Hook，React 直接抛 "Rendered more hooks than during the
   * previous render"；反过来删掉最后一条 / 点「编辑」把它移出队列时又少跑两个 Hook，
   * 抛 "Rendered fewer hooks than expected"。两者都没有 ErrorBoundary 兜底 ——
   * 整个应用白屏，刷新后队列已有数据、Hook 数从首帧就稳定，于是「刷新就正常」。
   * 功能上「没消息就什么都不渲染」不变，只是把返回挪到 Hook 后面。
   */
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col border-b border-border px-3 py-2">
      {/* 队列是干什么的：常显只留一句短的，完整语义放悬停提示（见下面 TooltipContent） */}
      <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5" />
        <span className="min-w-0 flex-1">{t("待发送 · {count} 条", { count: items.length })}</span>
      </span>
      {/* 失败停链提示（spec §3）：上一轮失败后队列静默停住没人知道，这里把状态
        挑明，并把「继续 / 清空」两个决定递到用户手边 */}
      {app.queuePausedReason === "failed" && (
        <div className="mb-1 flex items-center gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <span className="min-w-0 flex-1 truncate">{t("上轮失败，队列已暂停")}</span>
          <button
            type="button"
            disabled={running}
            onClick={() => app.pump()}
            className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("继续发下一条")}
          </button>
          <button
            type="button"
            onClick={() => void onClear()}
            className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-destructive/15"
          >
            {t("清空队列")}
          </button>
        </div>
      )}
      {/*
        固定高度 + 内部滚动：条数再多也不顶高输入框。
        `overscroll-contain`：滚到边界时别把页面 / 消息列表一起牵着滚（手机上很明显）。
      */}
      <div
        className={cn(
          LIST_HEIGHT_CLASS,
          "overflow-y-auto overscroll-contain pr-0.5",
        )}
      >
        {items.map((item) => (
          <QueuedRow
            key={item.id}
            item={item}
            running={running}
            canTouch={canTouch}
            app={app}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 插入中（steer）的插话：POST 成功到 agent 消费之间挂在收件箱里，这里可视化出来。
 *
 * 每条可编辑（✎，与队列编辑同款：写回输入框 + 移出收件箱，见 `onEditSteer`）、**可排序**
 * （与队列同一套 `SortableRow`：抓左侧把手拖 —— 顺序就是边界消费顺序）、
 * 本轮停下来之后还能 **➤ 立刻发送**（见 `sendSteer`）或 ✕ 移除。
 *
 * agent 在下一个工具步骤边界消费时，消息经 `user-injected` 事件转正进会话流、从这里出列。
 * ⚠️ 所以「插入中」这个标题只在**本轮在跑**时成立；本轮已结束（用户停止 / 失败）时服务端
 * 收件箱已经没了，列表改叫「未发出」——留在这里的是没生效的插话，等用户处置。
 */
function PendingSteers({
  app,
  onEdit,
}: {
  app: AgentApp;
  /** 点「编辑」：把整条交给调用方（写回输入框 + 撤回收件箱 + 记编辑态）；不传则不渲染 ✎ */
  onEdit?: (item: AgentChatMessage) => void;
}): ReactNode {
  const t = useT();
  const items = app.pendingSteers;
  if (items.length === 0) return null;
  // 排序能力判定与队列一致：触屏上 HTML5 拖拽起不动，那些设备由把手自己扛指针事件（见 SortableRow）
  const canTouch = supportsTouch();
  // 头部文案随「本轮是否在跑」切换，与队列同一套做法：跑着 = 会在边界生效；
  // 没跑 = 这些插话已经不会再生效（服务端收件箱随 run 消失），只能立刻发出去或移除
  const running = app.streaming;
  return (
    <div className="flex flex-col border-b border-border px-3 py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Zap className="size-3.5" />
            <span className="min-w-0 flex-1">
              {running
                ? t("插入中 · {count} 条（下个步骤边界生效，agent 正在跑的这一轮内）", { count: items.length })
                : t("未发出 · {count} 条（本轮已结束，可挑一条立刻发出去）", { count: items.length })}
            </span>
            <span className="shrink-0">{t("拖动左侧把手可调整顺序")}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          className="max-w-80 text-left text-pretty"
        >
          {t("插入的消息不算新的一轮：agent 在下一个工具步骤边界直接看到它、当场调整方向，列表顺序就是生效顺序（排在前面的先被看到）。点 ✎ 写回输入框改内容、点 ✕ 移除。本轮已停止 / 失败时这些插话不会再生效：点 ➤ 会把这一条当新一轮的普通消息发出去，其余没处理的会在你下次发消息时自动转入待发送队列（内容不会丢）。")}
        </TooltipContent>
      </Tooltip>
      {/* 固定高度 + 内部滚动：与队列列表同一套尺寸，条数再多也不顶高输入框 */}
      <div
        className={cn(
          LIST_HEIGHT_CLASS,
          "overflow-y-auto overscroll-contain pr-0.5",
        )}
      >
        {items.map((item) => (
          <SteerRow
            key={item.id}
            item={item}
            canTouch={canTouch}
            running={running}
            app={app}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  );
}

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
function RowIconButton({
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
function ExpandableRowText({
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

/**
 * 队列里的一条：排序交互由 `SortableRow` 提供，这里只给本列表的正文与按钮。
 *
 * 正文**默认一行**：稍长的消息不能把整张列表撑到内容高度（输入框在手机上尤其挤）。
 * 溢出时正文可点，弹 Dialog 看全文（见 `ExpandableRowText`）。
 */
function QueuedRow({
  item,
  running,
  canTouch,
  app,
  onEdit,
}: {
  item: QueuedMessage;
  running: boolean;
  /** 触屏设备：HTML5 拖拽起不动，改由把手自己扛 */
  canTouch: boolean;
  app: AgentApp;
  onEdit: (item: QueuedMessage) => void;
}) {
  const t = useT();
  /**
   * 删除前二次确认：队列里删掉的这条**不会再发出去**（内容不会落到别处），而队列常常
   * 攒着几条还没发的话 —— 误点一颗 × 就是一整条消息凭空没了，且没有任何撤销。
   * 确认框里带上正文前若干字，让人能确认自己删的是哪一条（队列项本身就一行截断）。
   */
  const confirm = useConfirm();
  const onRemove = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t("删除这条待发送消息？"),
      description: (
        <span className="whitespace-pre-wrap break-words">{item.text}</span>
      ),
      confirmLabel: t("删除"),
      destructive: true,
    });
    if (ok) app.removeQueuedMessage(item.id);
  }, [app, confirm, item.id, item.text]);
  return (
    <SortableRow
      id={item.id}
      dragType={QUEUE_ITEM_TYPE}
      canTouch={canTouch}
      moveTo={(draggedId, beforeId) =>
        app.moveQueuedMessage(draggedId, beforeId)
      }
    >
      <ExpandableRowText
        text={item.text}
        className="text-sm text-muted-foreground"
      />
      <RowIconButton
        onClick={() => app.sendQueuedMessage(item.id)}
        disabled={running}
        tip={running ? t("对话进行中，本轮结束后会自动发送") : t("立刻发送这一条")}
        label={t("发送这一条")}
        className={cn(
          "shrink-0 rounded p-1 transition-colors",
          running
            ? "cursor-not-allowed text-muted-foreground/50"
            : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        )}
      >
        <SendHorizontal className="size-3.5" />
      </RowIconButton>
      <RowIconButton
        onClick={() => {
          onEdit(item);
          app.removeQueuedMessage(item.id);
        }}
        tip={t("编辑并写回输入框")}
        label={t("编辑并写回输入框")}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <Pencil className="size-3.5" />
      </RowIconButton>
      <RowIconButton
        onClick={() => void onRemove()}
        tip={t("删除")}
        label={t("删除")}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </RowIconButton>
    </SortableRow>
  );
}

/**
 * 插话（「插入中」）列表的一条：排序与按钮都与队列行**同一套**（同一个 `SortableRow`、
 * 同一个 `RowIconButton`）—— ➀ 立刻发送（跑着时禁用，与队列同规则）、✎ 编辑写回输入框、
 * ✕ 移除。
 *
 * ➤ 的用处是「本轮已经结束（停止 / 报错）时把这条当新一轮发出去」：跑着时它的去处是
 * 「下个边界生效」，没有「立刻」这回事，所以那时禁用。
 *
 * 附件标识：插话也带附件（见 `SteerInput.files`），只有附件、没写文字的插话否则会显示成一句空话。
 */
function SteerRow({
  item,
  canTouch,
  running,
  app,
  onEdit,
}: {
  item: AgentChatMessage;
  /** 触屏设备：HTML5 拖拽起不动，改由把手自己扛 */
  canTouch: boolean;
  /** 本轮是否在跑（➤ 立刻发送只在停下来的那一轮才有意义） */
  running: boolean;
  app: AgentApp;
  onEdit?: (item: AgentChatMessage) => void;
}) {
  const t = useT();
  const fileCount = fileRefsOfParts(item.parts).length;
  const body = textOf(item) || (fileCount > 0 ? t("（仅附件）") : t("（空消息）"));
  /** 移除前二次确认（同队列删除）：移除 = 这条既不会在边界注入、也不会被发出去，误点即丢 */
  const confirm = useConfirm();
  const onRemove = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t("移除这条插话？"),
      description: (
        <span className="whitespace-pre-wrap break-words">{body}</span>
      ),
      confirmLabel: t("移除"),
      destructive: true,
    });
    if (ok) await app.removeSteer(item.id);
  }, [app, body, confirm, item.id]);
  return (
    <SortableRow
      id={item.id}
      dragType={STEER_ITEM_TYPE}
      canTouch={canTouch}
      moveTo={(draggedId, beforeId) => app.moveSteer(draggedId, beforeId)}
    >
      <ExpandableRowText text={body} className="text-xs text-foreground" />
      {fileCount > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
          title={t("这条插话带了 {count} 个附件，会在边界与文字一起注入", { count: fileCount })}
        >
          <Paperclip className="size-3" />
          {fileCount}
        </span>
      ) : null}
      {/* ➤ 立刻发送：与队列同一颗钮、同一套禁用规则 —— 跑着时禁用（跑着时它的去处是
                「下个边界生效」，没有「立刻」这回事），停下来了才轮到它把这条当新一轮发出去 */}
      <RowIconButton
        onClick={() => app.sendSteer(item.id)}
        disabled={running}
        tip={
          running
            ? t("对话进行中：会在下个工具步骤边界注入当前轮")
            : t("立刻发送这一条（作为新一轮的普通消息）")
        }
        label={t("立刻发送这一条")}
        className={cn(
          "shrink-0 rounded p-1 transition-colors",
          running
            ? "cursor-not-allowed text-muted-foreground/50"
            : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        )}
      >
        <SendHorizontal className="size-3.5" />
      </RowIconButton>
      {onEdit ? (
        <RowIconButton
          onClick={() => onEdit(item)}
          tip={t("编辑并写回输入框（附件一起回显）")}
          label={t("编辑这条插话")}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <Pencil className="size-3.5" />
        </RowIconButton>
      ) : null}
      <RowIconButton
        onClick={() => void onRemove()}
        tip={t("移除（还没生效：不再发给 agent，也不再发出去）")}
        label={t("移除这条插话")}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="size-3.5" />
      </RowIconButton>
    </SortableRow>
  );
}

/** ACP 权限答复档的中文名（pill 的 tooltip / aria 用） */
const ACP_PERMISSION_LABELS = {
  confirm: "确认（逐次询问）",
  allow: "完全放行（不再询问）",
} as const;

/**
 * ACP 会话的「权限答复」pill（复用内置权限 pill 的位置与外观；**两档**）。
 *
 * - **确认**（缺省）：agent 每次发 `session/request_permission` 都弹确认卡，由你挑；
 * - **完全放行**：服务端在应用层直接替用户答复「允许」（挑 agent 给的 allow_always →
 *   allow_once），确认卡根本不会出现。
 *
 * 按**会话**记住（存会话配置，换会话要重选）。一轮运行中切换也有效：服务端在每次
 * `session/request_permission` 到来时现取会话当前的模式，所以切到「完全放行」后
 * **本轮后续**的权限请求就不再弹卡（已经挂起等答复的那一张除外）。
 * ⚠️ ACP 没有运行时可设的「权限等级」：agent 自己配成 `deny` 时它根本不发请求，放宽无从谈起
 * —— `allow` 只是把它的 **ask** 变成放行。
 */
function AcpPermissionPill({ app }: { app: AgentApp }) {
  const t = useT();
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  if (!conversation || conversation.backend !== "acp") return null;
  const mode: "confirm" | "allow" =
    conversation.acpPermissionMode === "allow" ? "allow" : "confirm";
  return (
    <Select
      value={mode}
      onValueChange={(v) => app.setAcpPermissionMode(v as "confirm" | "allow")}
    >
      <SelectTrigger
        className={CHAT_ICON_PILL}
        icon={false}
        aria-label={t("权限答复：{label}", { label: t(ACP_PERMISSION_LABELS[mode]) })}
      >
        {/* mx-auto 居中：SelectTrigger 自带 justify-between，单个子元素会被顶到左边 */}
        <span className="mx-auto flex items-center">
          {mode === "allow" ? (
            <ShieldAlert className="size-3.5 text-amber-600 dark:text-amber-500" />
          ) : (
            <ShieldCheck className="size-3.5 text-muted-foreground" />
          )}
        </span>
      </SelectTrigger>
      <SelectContent position="popper" side="top" align="start" sideOffset={6}>
        <SelectItem value="confirm">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="size-3.5 text-muted-foreground" />
            <span>{t("确认（逐次询问）")}</span>
          </span>
        </SelectItem>
        <SelectItem value="allow">
          <span className="flex items-center gap-1.5">
            <ShieldAlert className="size-3.5 text-amber-600 dark:text-amber-500" />
            <span>{t("完全放行（不再询问）")}</span>
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * acp 会话的「模式」pill（**只有 opencode 风格**才显示，摆在模型选择器之后）。
 *
 * 数据来自**会话配置**（`conversation.acpModes`）：agent 广告的模式（规范 Session Modes
 * 或 configOptions 的 `category:'mode'`，opencode 是后者 = build / plan），服务端写回会话；
 * 不再像以前那样自己拉接口（进程没起来时拉不到、且与「agent 没有模式」分不清）。
 * 切换走 `setAcpAgentMode`（按通道走 `session/set_mode` 或 `session/set_config_option`），
 * store 乐观更新会话、失败回滚；服务端持久化后经 WS 推回权威快照。
 *
 * ⚠️ 它**不是**内置 agent 那种「权限档」：ACP 没有运行时可设的权限等级，模式语义全由 agent
 * 定义（opencode 的 plan = 禁编辑工具；权限策略在它自己的配置文件里）。所以这里叫中性的「模式」，
 * 名字 / 描述原样用 agent 给的。
 *
 * 语义由**设置里的 agent 类型**决定（见 `AcpAgentType`）：opencode 显示模式 pill；
 * pi 的思考档在 configOptions 里（见 `AcpThoughtLevelSelect`）；generic 不显示任何模式 UI。
 * 没有模式就整个不渲染 —— **不做中性 pill**。
 */
function AcpModePill({ app }: { app: AgentApp }) {
  const t = useT();
  const [switching, setSwitching] = useState(false);
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  /**
   * 新任务页（还没有会话）：档位来自**探测**（`draftAcp`），选择先记在草稿上，
   * 会话建好时由 `newConversation` 统一下发 —— 没有会话可读，只能先问 agent。
   */
  const draft =
    !conversation && app.chatTarget?.backend === "acp" ? app.draftAcp : null;
  const agentId =
    conversation?.backend === "acp" ? conversation.configId : draft?.agentId;
  const agent = agentId
    ? app.acpAgents.find((a) => a.id === agentId)
    : undefined;
  const modes = conversation?.acpModes ?? draft?.modes ?? undefined;
  const currentId = (draft ? draft.mode : null) ?? modes?.current ?? null;
  const isOpencode = agent?.type === "opencode";
  /**
   * ⚠️ 占位必须挂在「数据还没回来」而不是「探针在跑」上：`probeDraftAcp` 切到**别的
   * agent** 时会先把 `modes` 清空、`loading` 置真（正确：旧 agent 的档位不能顶着新
   * agent 的名字显示）。但如果只在 loading 时占位，切回来的那一下数据虽已在内存
   * （`draftAcpCache`，秒回），`loading` 仍会闪一帧真 -> 空 -> 真，pill 跟着闪。
   * 挂到 `modes` 上：缓存命中时第一帧就有数据、pill 原地不变；真没数据才转圈。
   * 也就顺带盖住「切走再切回同一个 agent、探针还在飞」那种空窗。
   */
  if (isOpencode && !draft && !modes) return null;
  if (isOpencode && draft && !modes) {
    return (
      <IconTip label={t("正在读取这个外部 Agent 的模式…")}>
        <button type="button" disabled className={CHAT_ICON_PILL} aria-busy>
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        </button>
      </IconTip>
    );
  }
  if (
    !agent ||
    agent.type !== "opencode" ||
    !modes ||
    !modes.available.length
  ) {
    return null;
  }
  const currentMode = modes.available.find((m) => m.id === currentId);

  const select = async (modeId: string): Promise<void> => {
    if (switching) return;
    // 还没有会话：只记在草稿上（建会话时下发）
    if (!conversation) {
      app.setDraftAcpMode(modeId);
      return;
    }
    setSwitching(true);
    const res = await app.setAcpAgentMode(agent.id, conversation.id, modeId);
    setSwitching(false);
    if (!res.ok) toast.error(t("切换权限档失败：{error}", { error: res.error ?? t("未知错误") }));
  };

  return (
    <DropdownMenu>
      <IconTip
        label={
          currentMode
            ? t("模式：{name}（由外部 Agent 提供，可切换）", { name: currentMode.name ?? currentMode.id })
            : t("模式（由外部 Agent 提供，可切换）")
        }
      >
        <DropdownMenuTrigger asChild>
          {/* 触发器只放图标（与权限 pill 同款）：档位名由 agent 自定义，进下拉看打勾 + tooltip */}
          <button
            type="button"
            className={CHAT_ICON_PILL}
            aria-label={currentMode ? t("模式：{name}", { name: currentMode.name ?? currentMode.id }) : t("模式")}
          >
            {switching ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </button>
        </DropdownMenuTrigger>
      </IconTip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="min-w-56"
      >
        {modes.available.map((mode) => (
          <DropdownMenuItem
            key={mode.id}
            title={mode.description ?? mode.name ?? mode.id}
            onSelect={() => void select(mode.id)}
          >
            <span className="truncate">{mode.name ?? mode.id}</span>
            {mode.id === currentId && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * acp 会话的「思考档」pill（**只有 pi 风格**才显示，摆在模型选择器之后）。
 *
 * `pi` 用 configOptions 的 `thought_level` 表达思考档（不是 Session Modes），数据同样来自
 * 会话配置（`conversation.acpThoughtLevel`）；切换走 `setAcpThoughtLevel`
 * （`session/set_config_option`）。没有思考档就整个不渲染。
 */
function AcpThoughtLevelSelect({ app }: { app: AgentApp }) {
  const t = useT();
  const [switching, setSwitching] = useState(false);
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  /** 新任务页：档位来自探测的 `draftAcp`，选择先记草稿、建会话时下发（同 `AcpModePill`） */
  const draft =
    !conversation && app.chatTarget?.backend === "acp" ? app.draftAcp : null;
  const agentId =
    conversation?.backend === "acp" ? conversation.configId : draft?.agentId;
  const agent = agentId
    ? app.acpAgents.find((a) => a.id === agentId)
    : undefined;
  const thought =
    conversation?.acpThoughtLevel ?? draft?.thoughtLevel ?? undefined;
  // 同 `AcpModePill`：占位挂在「数据还没回来」上（不是 loading）—— 缓存命中时切回来
  // 第一帧就有档位，pill 原地不动，不会闪一下转圈
  const isPi = agent?.type === "pi";
  if (isPi && !draft && !thought) return null;
  if (isPi && draft && !thought) {
    return (
      <IconTip label={t("正在读取这个外部 Agent 的思考档…")}>
        <button type="button" disabled className={CHAT_ICON_PILL} aria-busy>
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        </button>
      </IconTip>
    );
  }
  if (!agent || agent.type !== "pi" || !thought || !thought.options.length)
    return null;
  const currentValue = (draft ? draft.thought : null) ?? thought.current;
  const current = thought.options.find((o) => o.value === currentValue);

  const select = async (value: string): Promise<void> => {
    if (switching) return;
    if (!conversation) {
      app.setDraftAcpThought(value);
      return;
    }
    setSwitching(true);
    const res = await app.setAcpThoughtLevel(agent.id, conversation.id, value);
    setSwitching(false);
    if (!res.ok) toast.error(t("切换思考档失败：{error}", { error: res.error ?? t("未知错误") }));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={CHAT_PILL}
          aria-label={t("思考档：{name}", { name: current?.name ?? t("默认") })}
          title={t("思考档：{name}（由外部 Agent 提供，session/set_config_option 切换）", { name: current?.name ?? t("默认") })}
        >
          {switching ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{current?.name ?? t("思考档")}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        className="min-w-56"
      >
        {thought.options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            title={option.description ?? option.name}
            onSelect={() => void select(option.value)}
          >
            <span className="truncate">{option.name}</span>
            {option.value === currentValue && (
              <Check className="ml-auto size-3.5" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 模型 / 后端选择：紧挨发送按钮。
 *
 * 一个下拉装下「这一轮用什么」，标签行尾各有设置齿轮（配置入口永远可达）：
 * - AI 模型：每个模型配置一项，展开是它带的那几个模型；齿轮打开 设置 → AI 模型；
 * - 外部 Agent（ACP）：每个 agent 一项，展开是**设置里挑过的那几个**模型
 *   （一个 agent 常有十几二十个模型，全列出来太吵，白名单见设置 → 外部 Agent）；
 *   齿轮打开 设置 → 外部 Agent。没有任何模型 / agent 时分组也显示（给配置入口）。
 *
 * 会话类型在创建时就锁定，**被锁的整组不显示**（不是置灰）：
 * - acp 会话：只显示绑定的那个 agent 的模型（AI 模型组、其它 agent 一概不出）；
 * - mastra 会话：ACP 组不出；锁了配置的只显示那份配置；
 * - 没有会话（空态）：两组全量可选。
 * 换类型只能新建会话。
 */
/**
 * 上下文用量圆环：输入框操作行右侧的小环 + **点击**弹出的详情卡。
 *
 * 按会话类型分两条数据来源：
 * - **内置 agent（mastra）**：分子取最近一条助手消息落盘的 `usage.contextTokens`
 *   —— 就是 pi 的 `calculateContextTokens`：**最后一次请求上游真实上报的 input + output**
 *   （不是本地按字符估的量）；分母取该会话选中模型的窗口（`resolveContextWindow`，
 *   与压缩触发同源）。详情卡里可**手动压缩**。
 * - **ACP**：分子 / 分母都取 agent 自己上报的 `contextUsage`（session/update 的 usage_update
 *   的 `used` / `size`）。这份数据 `session/load` 拿不到，**没推过就整个不渲染**（不画空环）；
 *   历史在 agent 侧、本地压不了 —— 压缩相关 UI 一律隐藏。
 *
 * 流式进行中显示的是上一完成轮的值，本轮结束后跳到新值；ACP 的 usage_update 是即时的，
 * 收到就会在轮中刷新。
 */
function ContextRing({ app }: { app: AgentApp }) {
  const t = useT();
  const isAcp = turnIsAcp(app);
  const conversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  const checkpoint = conversation?.contextSummary ?? null;

  /**
   * 内置 agent 的分母 = **这个会话选中的模型自己配的窗口**（pi 的 `model.contextWindow`）；
   * 模型没单独配就用**兜底窗口**（服务端 `FIZZ_CONTEXT_BUDGET` > 200k，见
   * `GET /api/chat/context`）—— 与 `runAgent` 判断「何时压缩」用的是同一个数，
   * 所以圆环上的 80% 永远等于「下一轮会压缩」那条线。
   *
   * 别改成「没配窗口就整个不画」：那会连带把圆环里的手动压缩入口一起藏掉，而服务端
   * 那侧本来就按兜底值在压 —— 界面不显示只会让人找不到按钮，不会让压缩不发生。
   *
   * `windowFromModel` 只用来在卡片上说明这个分母的来源（模型自己声明 / 兜底值）。
   * ACP 不用它：窗口由 agent 在上报里给。
   */
  const config = app.models.find((m) => m.id === app.chatTarget?.configId);
  const modelId = app.chatTarget?.modelId;
  const configuredWindow = findModelEntry(config?.models, modelId)?.contextWindow;
  const windowFromModel =
    typeof configuredWindow === "number" &&
    Number.isFinite(configuredWindow) &&
    configuredWindow > 0;
  const localContextWindow = resolveContextWindow(
    config?.models,
    modelId,
    app.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
  );
  /**
   * 兜底窗口是**服务端**解析的（环境变量只在那边），挂载时拉一次缓存；`null` 期间先按
   * `DEFAULT_CONTEXT_WINDOW` 画，拉到之后自然重算（`loadDefaultContextWindow` 自己会去重）。
   * 模型配了窗口就不必拉 —— 那一份永远用不上。
   */
  useEffect(() => {
    // ACP 用不到兜底窗口（分母来自 agent 上报的 size），别为它白拉一次
    if (!isAcp && !windowFromModel) void app.loadDefaultContextWindow();
  }, [isAcp, windowFromModel, app.loadDefaultContextWindow]);

  /** 内置 agent：上一轮的完整用量 —— 从后往前找第一条带 usage 的助手消息（同时要它的 createdAt） */
  const lastUsageMessage = useMemo(() => {
    for (let i = app.messages.length - 1; i >= 0; i--) {
      const m = app.messages[i];
      if (m.role === "assistant" && m.usage) return m;
    }
    return null;
  }, [app.messages]);
  const lastUsage = lastUsageMessage?.usage ?? null;

  /**
   * 带 `contextUsage` 的助手消息（从后往前找最后一条）。
   *
   * 两条来源共用这一个 memo：ACP 是 agent 上报，内置 agent（mastra）是每个工具步骤
   * 边界由服务端估推（见流事件 `context-usage`）—— 两者的落点都是消息上的
   * `contextUsage`，所以这里不需要按 isAcp 分叉。
   */
  const contextUsageMessage = useMemo(() => {
    for (let i = app.messages.length - 1; i >= 0; i--) {
      const m = app.messages[i];
      if (m.role === "assistant" && m.contextUsage) return m;
    }
    return null;
  }, [app.messages]);
  /**
   * 上下文占用的「实时那份」（**仅内置 agent**）：
   * 本轮每个工具步骤边界由服务端估算推来（见流事件 `context-usage`），落点是消息上的
   * `contextUsage`。它比 finish 的发得早，所以用于「一轮之内圆环也跟着走」。
   *
   * ⚠️ 只有当这份比 `lastUsageMessage`（带 `usage` 的助手消息）**严格更新**时才认：
   * 一轮跑完后，finish 的 `usage` 和最后一步的 `contextUsage` 落在**同一条**消息上
   * （同一个 `createdAt`），这份是「最后一步开始前」的估算，比 finish 的权威值略小，
   * 那时必须让 finish 赢 —— 所以判据是 `>` 而不是 `>=`（`>=` 会让估算把权威值盖回去，
   * 圆环跑完后永远差最后一段输出）。会话重开后 `contextUsage` 不再回放，自然退到 finish。
   */
  const liveContextUsage =
    contextUsageMessage &&
    (!lastUsageMessage ||
      contextUsageMessage.createdAt > lastUsageMessage.createdAt)
      ? contextUsageMessage.contextUsage
      : null;
  /**
   * ACP 的分子 / 分母：
   * - 先看**消息上**那份 —— 本轮 agent 推来时 handleFrame 即时写入，最新；
   * - 再退到**会话配置**里那份 —— 服务端持久化过，刷新后即使 `session/load` 回放
   *   不带 `usage_update`，圆环也能画回来。
   *
   * 两份都没有就整个不显示（不画一个永远空的环）；上面两个 useMemo 必须先执行
   * （hooks 顺序），所以这个早退放在它们之后。
   */
  const acpUsage = liveContextUsage ?? conversation?.acpContextUsage ?? null;
  /*
   * ACP：两份都没有、或 agent 报了个非法的 size（0 / NaN）就整个不显示。
   * `size` 是分母，为 0 时 `used / size` 会变成 Infinity —— 圆环被顶满、直接判红，
   * 看着像「上下文爆了」，实际只是没数据（上游 `toAcpStreamEvent` 已经滤过一次，
   * 但持久化的那份是历史数据，可能来自旧版本）。
   *
   * 内置 agent 没有这个分支：分母永远有（模型窗口 || 兜底窗口），最多是 `used` 还没来。
   */
  if (
    isAcp &&
    !(acpUsage && Number.isFinite(acpUsage.size) && acpUsage.size > 0)
  )
    return null;
  /**
   * 分子只认 `contextTokens`（pi 的 `calculateContextTokens` = 最后一次请求的 input + output）。
   * **不要用 `inputTokens`**：那是上游上报的**整轮累计**，多步工具循环下会虚高好几倍
   * （见 `TurnUsage.contextTokens` 的说明）—— 早先拿它当「上下文占用」，圆环就一直是超标的。
   *
   * 手动压缩之后、下一轮跑完之前：手上还是**压缩前**那一轮的值，直接画会显示成
   * 「压了等于没压」。这段时间用检查点里算好的 afterTokens 顶一下（同一口径：
   * base + 压缩后消息），等下一轮跑完自然换成实测值。
   */
  const compressedUsed =
    checkpoint &&
    (!lastUsageMessage || checkpoint.createdAt > lastUsageMessage.createdAt)
      ? checkpoint.stats.afterTokens
      : null;
  /**
   * 分子优先级（内置 agent）：
   * 1. **本轮实时估算**（`liveContextUsage`，每个工具步骤边界推来）—— 让圆环在一轮之内
   *    也跟着走；这是 pi 的兜底估算分支，finish 时会被上游真实 usage 覆盖。
   * 2. 上一轮 finish 落盘的 `usage.contextTokens`（历史 / 刚打开会话时用）。
   * 手动压缩后、下一轮还没产出实时值（也没跑完）时，用检查点的 afterTokens 顶一下
   * —— 判据仍是「检查点比手上这份估算更新」，压缩后 `liveContextUsage` 会被清掉
   * （新一轮还没推），所以这里先看检查点再看实时值。
   */
  const used = isAcp
    ? (acpUsage?.used ?? null)
    : (compressedUsed ??
      liveContextUsage?.used ??
      lastUsage?.contextTokens ??
      null);
  /** ACP 的窗口取 agent 上报的 size（本地模型配置对 ACP 不适用） */
  const contextWindow = isAcp && acpUsage ? acpUsage.size : localContextWindow;
  const triggerTokens = compactionTriggerTokens(contextWindow);
  /** 顶上来的那个值是**压缩后**的估算，卡片里要标明，别让人以为又多占了（仅内置 agent） */
  const usedIsCheckpoint = !isAcp && compressedUsed !== null;
  /** 顶部那个值是不是「本轮实时估算」（内置 agent 流式中）；卡片文案据此区分 */
  const usedIsLive = !isAcp && !usedIsCheckpoint && liveContextUsage !== null;

  // pi 的 footer 是 `(tokens / contextWindow) * 100` 保留一位小数；**不截断**（会真的显示 105.3%）
  const percent = used !== null ? (used / contextWindow) * 100 : null;
  // 弧长只能画 0..1，截断只发生在这里；数字与颜色仍按真实比值（与 pi 的 footer 一致）
  const ratio = percent !== null ? Math.min(1, percent / 100) : null;
  const percentText = percent !== null ? percent.toFixed(1) : null;
  // 颜色档照抄 pi 的 footer：`> 90` 红、`> 70` 琥珀，其余默认（无数据淡灰）
  const tone =
    percent === null
      ? "stroke-muted-foreground/30"
      : percent > 90
        ? "stroke-destructive"
        : percent > 70
          ? "stroke-amber-500 dark:stroke-amber-400"
          : "stroke-muted-foreground";

  const compressing = app.contextCompressing;
  const compress = async (): Promise<void> => {
    const res = await app.compressContextNow();
    // 成功的反馈走压缩横幅（store 里设置 contextNotice）；失败这里直接报
    if (!res.ok) toast.error(t("手动压缩失败：{error}", { error: res.reason ?? t("未知错误") }));
  };
  const clear = async (): Promise<void> => {
    const res = await app.clearContextSummary();
    if (!res.ok) toast.error(t("清除摘要失败：{error}", { error: res.reason ?? t("未知错误") }));
  };

  /** 圆环几何：r=7 在 18×18 视窗里留给 2.5 描边刚好；弧线从 12 点方向起 */
  const R = 7;
  const CIRC = 2 * Math.PI * R;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          /*
                      ⚠️ **悬停不改圆环颜色**（用户要求）：这颗的「图标」是手绘 SVG，圆环用
                      `stroke-*` 上色、本来就不吃 `CHAT_ICON_PILL` 里那条 `hover:[&_svg]:text-primary`；
                      曾经另补过一条 `hover:[&_circle]:stroke-primary` 让整排 pill 的 hover 手感一致，
                      但圆环的颜色本身是**用量告警语义**（灰 / 琥珀 / 红），hover 一变就会被误读成
                      「占用变了」—— 去掉它，hover 不留卡片（详情改成点击弹出）。
                    */
          className={CHAT_ICON_PILL}
          aria-label={t("上下文用量")}
          title={
            isAcp
              ? t("上下文用量（agent 上报，点击看详情）")
              : t("上下文用量（点击看详情，可手动压缩）")
          }
        >
          {compressing ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <svg viewBox="0 0 18 18" className="size-4 shrink-0" aria-hidden>
              <circle
                cx="9"
                cy="9"
                r={R}
                fill="none"
                strokeWidth="2.5"
                className="stroke-muted-foreground/25"
              />
              {ratio !== null && ratio > 0 && (
                <circle
                  cx="9"
                  cy="9"
                  r={R}
                  fill="none"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={`${(ratio * CIRC).toFixed(2)} ${CIRC.toFixed(2)}`}
                  transform="rotate(-90 9 9)"
                  className={tone}
                />
              )}
            </svg>
          )}
        </button>
      </PopoverTrigger>
      {/*
        与「模型 / 权限」那几个下拉保持一套外观：圆角、实边框、离视口边缘留白。
        ⚠️ `PopoverContent` 默认只有 `ring-foreground/5`，在 `contrast` 主题下
        （`--popover` 与 `--background` 同色、边框才是纯黑 / 纯白）等于没有边；
        而且圆环在输入行偏右，`align="end"` 在窄屏上会把 256px 的卡片顶到视口左缘，
        没有 `collisionPadding` 就紧贴屏幕边。两处都照 DropdownMenuContent 来。
      */}
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        className="w-64 rounded-xl border border-border"
      >
        <div className="space-y-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Gauge className="size-3.5" />
            {t("上下文用量")}
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums">
              {used !== null ? used.toLocaleString() : "—"}
            </span>
            <span className="text-muted-foreground">
              / {contextWindow.toLocaleString()} tokens
              {percentText !== null && ` · ${percentText}%`}
            </span>
          </div>
          {/* 上一轮的完整账目：上游上报的**整轮**输入（多步工具循环下是各 step 累加，
                        所以它不是上面的上下文占用）、输出、思考、速度。缺哪项（上游没报）就不显示 */}
          {lastUsage && (
            <div className="grid grid-cols-1 gap-y-0.5 text-muted-foreground">
              <span>
                {t("本轮累计输入")}{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {lastUsage.inputTokens.toLocaleString()}
                </span>
              </span>
              <span>
                {t("输出")}{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {lastUsage.outputTokens.toLocaleString()}
                </span>
              </span>
              {lastUsage.cachedInputTokens != null && (
                <span>
                  {t("其中缓存命中")}{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {lastUsage.cachedInputTokens.toLocaleString()}
                  </span>
                </span>
              )}
              {lastUsage.reasoningTokens != null && (
                <span>
                  {t("其中思考")}{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {lastUsage.reasoningTokens.toLocaleString()}
                  </span>
                </span>
              )}
              {/* 子任务（subagent）的账：父的字段是父自己上报的，不含这部分 */}
              {lastUsage.subagents &&
                Object.entries(lastUsage.subagents).map(([id, s]) => (
                  <span key={id}>
                    {t("子任务")} · {SUBAGENT_META[id as SubagentId]?.name ?? id}{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {s.totalTokens.toLocaleString()}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      {t("（{count} 次）", { count: s.calls })}
                    </span>
                  </span>
                ))}
              <span>
                {lastUsage.tps > 0 && `${lastUsage.tps.toFixed(1)} tok/s`}
                {/* 分隔符只在两段都有时才出现 —— 早先 TPS 为 0 时会留下一个
                                    前导的「 · 」（`false && \` · …\`` 渲染成空串，但前一个
                                    分支也是 false，看起来干干净净；tps 为 0 时才看出来） */}
                {lastUsage.tps > 0 && lastUsage.durationMs > 0 && " · "}
                {lastUsage.durationMs > 0 &&
                  formatDuration(lastUsage.durationMs)}
              </span>
            </div>
          )}

          {/* 会话累计：与消息区顶部那条 sticky 条同源（conversation.totalUsage） */}
          {conversation?.totalUsage && (
            <>
              <div className="border-t pt-2" />
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <Gauge className="size-3.5" />
                {t("会话累计")}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
                <span>
                  {t("输入")}{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {conversation.totalUsage.inputTokens.toLocaleString()}
                  </span>
                </span>
                <span>
                  {t("输出")}{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {conversation.totalUsage.outputTokens.toLocaleString()}
                  </span>
                </span>
                <span>
                  {t("合计")}{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {conversation.totalUsage.totalTokens.toLocaleString()}
                  </span>
                </span>
                {!!conversation.totalUsage.reasoningTokens && (
                  <span>
                    {t("思考")}{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {conversation.totalUsage.reasoningTokens.toLocaleString()}
                    </span>
                  </span>
                )}
                {!!conversation.totalUsage.cachedInputTokens && (
                  <span>
                    {t("缓存")}{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {conversation.totalUsage.cachedInputTokens.toLocaleString()}
                    </span>
                  </span>
                )}
              </div>
            </>
          )}

          {/* 压缩相关的是内置 agent 专属：ACP 的上下文在 agent 侧，本地既看不见
                        压缩历史也没有可点的按钮（`compressContextNow` / `clearContextSummary`
                        都是 mastra 那条路的事） */}
          {!isAcp && (
            <>
              <div className="border-t pt-2" />
              {app.contextNotice ? (
                <p className="text-muted-foreground">
                  {t("最近一次压缩：{before} → {after} token，摘要 {summarized} 轮、保留 {kept} 轮。", {
                    before: app.contextNotice.beforeTokens.toLocaleString(),
                    after: app.contextNotice.afterTokens.toLocaleString(),
                    summarized: app.contextNotice.summarizedTurns ?? 0,
                    kept: app.contextNotice.keptTurns ?? 0,
                  })}
                </p>
              ) : (
                <p className="text-muted-foreground">
                  {t("最近没有发生过上下文压缩。")}
                </p>
              )}
              {checkpoint && (
                <p className="text-muted-foreground">
                  {t("已开启摘要压缩（{time}）：之前的对话以摘要参与上下文，原始消息未动。", {
                    time: new Date(checkpoint.createdAt).toLocaleString(),
                  })}
                </p>
              )}

              {app.activeConversationId && (
                <div className="flex items-center gap-2 pt-1">
                  {/* 会话进行中禁止压缩：这一轮还在跑时禁用。
                                        服务端不额外拦（回合中途落检查点只影响下一轮，无害），
                                        这里禁用是交互层的要求：用户在等回复，按钮点了也没有意义。 */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    disabled={compressing || app.streaming}
                    title={
                      app.streaming
                        ? t("这一轮还在进行中，请等它结束后再压缩")
                        : undefined
                    }
                    onClick={() => void compress()}
                  >
                    {compressing ? (
                      <>
                        <Loader2 className="size-3 animate-spin" />
                        {t("压缩中…")}
                      </>
                    ) : (
                      t("压缩上下文")
                    )}
                  </Button>
                  {checkpoint && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2.5 text-xs text-muted-foreground"
                      disabled={compressing}
                      onClick={() => void clear()}
                    >
                      {t("清除摘要")}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 会话级 MCP 多选：**输入框上方工具条**里的扳手 pill（与「浏览器」并排 —— 两者同属
 * 「给这一轮装能力」；原先它挂在输入框右侧那排 pill 里，与「选择模型」相邻）。
 *
 * 语义：**这个会话允许用哪几个 MCP server**。默认一个都不选（存量会话天然如此），
 * 选中的会在下一轮对话被接进工具集 —— 未选的不起进程（见 `app/api/chat/route.ts`）。
 * 选「全不选」等价于清空；勾选后即时持久化到会话（刷新 / 重进都在）。
 *
 * 这不是「配置启停」：设置 → MCP 里配好 server 就有，这里只做**按会话挑**。
 * 长相与交互在 `pickers.tsx` 的 `McpPill`（定时任务表单也用同一颗）—— 这里只负责把
 * `app` 里的数据灌进去。
 */
function McpSelect({ app }: { app: AgentApp }) {
  return (
    <McpPill
      servers={app.mcpServers}
      value={app.mcpServerIds}
      onChange={app.setMcpServerIds}
    />
  );
}

// 供侧边栏「编辑并重发」在消息 hover 栏上复用：把消息文本灌进输入框并标记重发起点。
// 通过 usePromptInputController 在 Provider 内取值，因此这里把逻辑拆到 ChatPanel 内层组件。

/**
 * 对话面板：`PromptInputProvider` 必须在最外层 —— 侧栏「编辑并重发」要把文本灌进这里
 * 的草稿，而草稿持有者（`ChatSurface` 的 `composer`）在面板内部。
 */
/**
 * @param panelKey 这个 ChatPanel 所属**标签**的面板 key（`ConversationTab` 传它自己那个：
 * 会话 id，或「新对话」标签的 `draft:<工作区>`）。消息下方的文档入口要把右侧「文件」面板
 * 挂出来，**必须挂在这个标签自己的面板上** —— 用 Provider 的 `showSideTab`（那是「当前
 * 会话」）会在多标签 / 分屏下把面板开到别的标签上。
 */
export function ChatPanel({
  app,
  panelKey,
}: {
  app: AgentApp;
  panelKey: string;
}) {
  return (
    /*
      `key` + `draftKey` 都绑到标签 key：草稿按会话隔离（真实会话 = 会话 id，
      「新对话」= `draft:<工作区>`），刷新后由 Provider 从 localStorage 读回。
      换标签时必须重挂 Provider —— 它只在挂载时读一次存档（见 prompt-input.tsx）。
    */
    <PromptInputProvider key={panelKey} draftKey={panelKey}>
      <ChatPanelInner app={app} panelKey={panelKey} />
    </PromptInputProvider>
  );
}

/**
 * 主会话面板：把 `useAgentApp` 的状态接到共用的 `ChatSurface` 上。
 *
 * 骨架（消息列表 / 输入区 / 落底指示器 / 消息目录）在 `chat/chat-surface.tsx`，与容器
 * 工作台同一份；这里只给主会话特有的东西：
 * - 消息流上方的 sticky 条（上下文已压缩 / 连接中断提示）；会话累计用量已从顶部移除
 * - 一轮结束后的用量统计行（随消息落盘）；
 * - 消息级操作（编辑重发 / 删除）+ 待发送队列 + 工作区 / 模型 / 权限 pill。
 */
function ChatPanelInner({
  app,
  panelKey,
}: {
  app: AgentApp;
  panelKey: string;
}) {
  const t = useT();
  const { messages, streaming, activeWorkspace } = app;
  const { textInput } = usePromptInputController();
  /**
   * 用户**明确要空态**（点「新建会话」/ 引导页的「直接开始对话」）。
   * 一个项目都没有时靠它区分「首次进来该看引导页」与「用户就是要不绑项目聊」——
   * 两种情况 `activeWorkspaceId` 都是 null，只有这个标记分得开。
   */
  const blankIntent = useAgentStore((s) => s.blankIntent);
  /**
   * 正在编辑重发的消息（null = 没在编辑）。编辑条引的是 `text`（原文），重发起点是 `id`。
   * ⚠️ 这个 id 是**某个会话里的消息 id**，所以连会话 id 一起记 —— 它只在那个会话里成立。
   */
  const [editing, setEditing] = useState<EditingMessage | null>(null);
  /**
   * 正在编辑的插话（null = 没在编辑）。与 `editing`（重发）同款：条上引原文，id 认条。
   * 点 ✎ 时这条已经移出收件箱，所以不按收件箱成员校验 —— 只看「换会话」与「本轮还在跑」。
   */
  const [editingSteer, setEditingSteer] = useState<EditingSteer | null>(null);
  /** 「从此签出」弹窗的终点消息：非空 = 弹窗开着（见 renderActions 的 onFork） */
  const [forkTarget, setForkTarget] = useState<string | null>(null);
  /**
   * 「转为内置 Agent 会话」弹窗的终点消息：非空 = 弹窗开着（见 renderActions 的 onConvert）。
   * 转换是形态变更、且要顺带选新会话落在哪个工作区（当前工作区分叉 / 新建 worktree），
   * 所以先弹确认再执行（`ConvertAcpDialog`）。
   */
  const [convertTarget, setConvertTarget] = useState<string | null>(null);

  /**
   * 面板动作（`showSideTabOf`）：消息下方的文档入口要先把**这个标签自己的**右侧「文件」
   * 面板挂出来，再把「打开哪个文件」的请求交给它（见 `renderArtifacts` 与
   * `features/files/open-file.ts`）。
   *
   * ⚠️ 用 `showSideTabOf(panelKey, …)` 而不是 `showSideTab(…)`：后者按「当前会话」找面板，
   * 多标签 / 分屏下会把面板开到**别的**标签上（那个会话凭空多出一个文件面板，这个标签
   * 却什么都没发生）。
   */
  const { showSideTabOf } = useAppContext();

  // ---------- 附件（图片 / PDF）----------
  /**
   * 待发送附件：占位（本地预览 + 进度）→ 上传完成（服务端 url）。**不落库** ——
   * 刷新 / 切会话即清空（与 ainav 一致）；异步回调（进度 / 完成）读 ref 镜像，
   * 不吃闭包旧值。编辑回显 / 队列回显也是往这里灌（uploaded: true 的服务端引用）。
   */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const setBothAttachments = (next: ChatAttachment[]): void => {
    attachmentsRef.current = next;
    setAttachments(next);
  };
  /** 就地更新一条附件（进度 / 完成 / 失败） */
  const updateAttachment = (
    id: string,
    patch: Partial<ChatAttachment>,
  ): void => {
    setBothAttachments(
      attachmentsRef.current.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );
  };

  // ---------- 上传源（内置存储 + 插件注册的）----------
  /**
   * 当前项目可用的上传源 + 这次用哪个。**按项目现拉**：插件目录是按项目扫的（项目级插件
   * 也能提供上传源），所以换项目要重拉。拉不到就当「只有内置」—— 上传本身照常可用，
   * 不值得为一份清单弹错打扰用户。
   *
   * 选择本身是用户偏好，**不随会话切换重置**（换到别的项目时下面会回落成缺省那个）。
   */
  const [uploadProviders, setUploadProviders] =
    useState<UploadProviderView[]>(NO_UPLOAD_PROVIDERS);
  const [uploadProviderId, setUploadProviderId] = useState<string | null>(null);
  const uploadProvidersApi = app.api;
  const uploadProvidersWorkspaceId = app.activeWorkspaceId;
  /** 代次防护：晚到的旧项目响应不许覆盖当前项目的清单 */
  const uploadProvidersGenRef = useRef(0);
  /**
   * 拉一遍可用上传源。**两个时机**：
   * 1. 换项目时（清单跟着项目走，项目级插件也能提供上传源）；
   * 2. **打开回形针菜单时** —— 这是「刚在设置里启用了上传插件，回到输入框要选文件」
   *    那条路径的**唯一**刷新点。只在换项目时拉的话，用户会以为插件没生效
   *    （菜单里根本没有那一项），而这恰恰是最容易踩的一步。
   */
  const loadUploadProviders = useCallback(async (): Promise<void> => {
    if (!uploadProvidersApi || !uploadProvidersWorkspaceId) return;
    const gen = ++uploadProvidersGenRef.current;
    try {
      const list = await uploadProvidersApi.listUploadProviders(
        uploadProvidersWorkspaceId,
      );
      // 空数组用共享常量：引用不变 → React 直接 bail out，不白跑一轮渲染
      if (gen === uploadProvidersGenRef.current) {
        setUploadProviders(list.length ? list : NO_UPLOAD_PROVIDERS);
      }
    } catch {
      /* 清单拿不到 = 只有内置那一个源，静默处理 */
    }
  }, [uploadProvidersApi, uploadProvidersWorkspaceId]);
  useEffect(() => {
    void loadUploadProviders();
  }, [loadUploadProviders]);
  /** 这次上传用哪个源：显式选的（还在清单里）→ 服务端缺省那个 → 第一个 */
  const selectedUploadProvider = useMemo(
    () =>
      uploadProviders.find((p) => p.id === uploadProviderId) ??
      uploadProviders.find((p) => p.isDefault) ??
      uploadProviders[0],
    [uploadProviders, uploadProviderId],
  );
  // ---------- 引用（划选消息里的文字）----------
  /**
   * 挂在输入框上方的引用片。与附件同款：**不落库**、换会话即清空、发出即清空；
   * 发送时由 `buildQuotedText` 拼进正文（不是独立字段，见 lib/quotes.ts 头注释）。
   */
  const [quotes, setQuotes] = useState<MessageQuote[]>([]);

  // 换会话清空：附件与引用都是「本会话没发出的草稿」，带到别的会话发出去只会发错地方
  const draftConversationId = app.activeConversationId;
  useEffect(() => {
    attachmentsRef.current = [];
    setAttachments([]);
    setQuotes([]);
  }, [draftConversationId]);

  /**
   * 上传入口选中文件：白名单外的 toast 警告，其余占位 + 上传（进度/失败就地更新）。
   * 三个入口共用这一条链路：回形针选文件（`FileList`）、粘贴截图、拖拽文件（`File[]`）。
   */
  const onPickFiles = (picked: FileList | File[]): void => {
    // 知道用哪个上传源时**只按它的 accept 判**（插件可以比契约宽，也可以更窄）；
    // 清单还没拉到就退回契约口径，服务端那一关才是最终判据
    const { ok: okFiles, rejected } = splitUploadable(
      picked,
      selectedUploadProvider
        ? {
            mime: selectedUploadProvider.acceptMime,
            maxBytes: selectedUploadProvider.maxBytes,
          }
        : undefined,
    );
    for (const r of rejected) toast.warning(`${r.name}：${r.reason}`);
    if (okFiles.length === 0) return;
    const api = app.api;
    if (!api) {
      toast.error(t("未连接服务端，无法上传附件"));
      return;
    }
    // 预览是异步的：选完文件到占位上屏之间用户可能已切会话 —— 以 store 的实时快照
    // 判归属（闭包里的 app.activeConversationId 是渲染时旧值，判不了），不一致就丢弃
    const pickedIn = app.activeConversationId;
    // 上传源在**选中文件那一刻**定下来（整批一样）：之后用户改选别的源，不该把已经
    // 在传的那几条挪走 —— 每条附件落到哪儿，是它自己带的信息（见 ChatAttachment.provider）
    const providerAtPick = selectedUploadProvider?.id;
    const workspaceAtPick = app.activeWorkspaceId ?? undefined;
    for (const file of okFiles) {
      const id = nextAttachmentId();
      const placeholder: ChatAttachment = {
        id,
        name: file.name,
        mediaType: file.type,
        url: "",
        uploaded: false,
        progress: 0,
        ...(providerAtPick ? { provider: providerAtPick } : {}),
      };
      // 图片先出本地预览（失败不致命——占位卡退回图标形态），随后立刻开传
      const withPreview: Promise<ChatAttachment> = file.type.startsWith(
        "image/",
      )
        ? readImagePreview(file)
            .then((previewUrl) => ({ ...placeholder, previewUrl }))
            .catch(() => placeholder)
        : Promise.resolve(placeholder);
      void withPreview.then((att) => {
        // 会话已切走：占位不能追加进新会话（useEffect 刚清空的正是它）
        if (useAgentStore.getState().activeConversationId !== pickedIn) return;
        attachmentsRef.current = [...attachmentsRef.current, att];
        setAttachments(attachmentsRef.current);
        void api
          .uploadFile(file, {
            onProgress: (percent) =>
              updateAttachment(id, { progress: percent }),
            provider: providerAtPick,
            workspaceId: workspaceAtPick,
          })
          .then((result) =>
            updateAttachment(id, {
              url: result.url,
              uploaded: true,
              progress: 100,
              // 服务端回的就是它实际用的那个源，以它为准（缺省 / 回落都在那边发生）
              provider: result.provider ?? providerAtPick,
            }),
          )
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : t("上传失败");
            updateAttachment(id, { error: message });
            toast.error(`${file.name}：${message}`);
          });
      });
    }
  };
  /** 发送时提交的附件：剥掉未完成 / 失败的（三处出口共用一份，见 lib/attachments） */
  const collectSendFiles = (): UploadFileRef[] =>
    sendableAttachments(attachments);
  const hasUploadingAttachment = attachments.some(
    (a) => !a.uploaded && !a.error,
  );
  /** 从消息 / 队列条目还原附件回显（uploaded: true 的服务端引用，图片预览走服务端 url） */
  const restoreAttachments = (files: UploadFileRef[], seed: string): void => {
    setBothAttachments(
      files.map((f, i) => ({
        id: `${seed}-${i}`,
        name: f.name,
        mediaType: f.mediaType,
        url: f.url,
        uploaded: true,
        progress: 100,
        // 回显保留它原来是哪个源传的（`undefined` = 该字段出现之前的老附件）
        ...(f.provider ? { provider: f.provider } : {}),
      })),
    );
  };

  // acp 会话的消息在 agent 侧：编辑 / 删除这类「本地历史」操作没有对象，只给「复制」
  const activeIsAcp = activeConversationIsAcp(app);
  // 队列「编辑」把消息写回输入框后，聚焦到 textarea 让用户接着改
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 助手调 `create_conversation` 建好会话后带来的提示词 → 灌进这个会话的输入框。
   *
   * 放在 effect 里而不是派发那一刻：app-shell 是先导航、这边后挂上（见 lib/pending-draft.ts），
   * 单槽里存着不会漏。`takePendingDraft` 只在 id 命中时取走，所以打开别的会话不受影响。
   *
   * ⚠️ 是**替换**草稿不是追加：草稿是全局的、刻意跨会话保留（见下面「编辑态失效」的说明），
   * 这里是例外 —— 用户刚让助手建了个会话，输入框里那半句多半是上一个会话的残留，
   * 替他清掉比留着更糟。「只预填、不自动发」，发送与否交给用户。
   *
   * `setInput` 特意挪进 rAF 回调、不在 effect 体里同步调：同步 setState 会白白多跑一轮
   * 渲染（react-hooks/set-state-in-effect）。本来就要等一帧让 ChatSurface 把文本渲染进
   * textarea 才能聚焦，正好合成一步 —— 焦点早了就落空。
   */
  useEffect(() => {
    const prompt = takePendingDraft(app.activeConversationId);
    if (!prompt) return;
    requestAnimationFrame(() => {
      textInput.setInput(prompt);
      textareaRef.current?.focus();
    });
    // 依赖里的 `textInput` 是整个对象：Provider 拿输入框**字符串**当 useMemo 依赖
    // （prompt-input.tsx），所以每敲一个字它就换一个新引用，本 effect 会跟着重跑 ——
    // 无害，重跑也只是 `takePendingDraft` 的一次空判（单槽取走即清）。
  }, [app.activeConversationId, textInput]);

  /**
   * 编辑态失效的两种情况，都在渲染期直接判掉（React 的「渲染时调整 state」写法：
   * 不把过期状态提交出去，也省掉 effect + setState 的下一轮渲染）：
   *
   * 1. 会话变了：重发起点属于原会话，带到新会话上就是往新会话里发消息、同时把旧会话
   *    从那条起的历史删掉。草稿（`textInput`）是全局的、刻意不动 —— 用户可能自己
   *    敲了半句还没发，替他清掉比留着更糟（标识没了而已，文本还在）；
   * 2. 被编辑的那条不在消息列表里了（历史重拉 / 删过它）：别让重发起点变成野 id
   *    （拿它去 `deleteMessagesFrom` 只会白失败一次）。
   *    ⚠️ 装载窗口里 `messages` 是空的 —— 那不是「消息没了」，所以要等装载完再判。
   */
  if (
    editing &&
    (editing.conversationId !== app.activeConversationId ||
      (!app.messagesLoading && !messages.some((m) => m.id === editing.id)))
  ) {
    setEditing(null);
  }
  // 插话编辑态失效：换会话（id 只在那个收件箱里有意义）/ 本轮跑完了（收件箱语义
  // 已消失 —— 编辑条若还挂着「重新插回当前轮」就是撒谎）。文本留在草稿里不丢。
  if (
    editingSteer &&
    (editingSteer.conversationId !== app.activeConversationId || !streaming)
  ) {
    setEditingSteer(null);
  }

  /** 退出编辑态：清标记 + 清掉输入框里那份草稿 + 清附件（附件正是从这条消息回显来的） */
  const cancelEdit = (): void => {
    setEditing(null);
    textInput.clear();
    setBothAttachments([]);
    textareaRef.current?.focus();
  };

  /** 退出插话编辑态：同上 —— 草稿就是这条插话灌进来的，清掉 */
  const cancelEditSteer = (): void => {
    setEditingSteer(null);
    textInput.clear();
    textareaRef.current?.focus();
  };

  /**
   * 点「插入中」列表的 ✎：与队列编辑同款三步 —— 写回输入框、移出收件箱（agent
   * 从此看不到它，防编辑期间被边界消费掉）、记编辑态（发送时走 steer 重新插回）。
   * 同时摘掉重发编辑态：一次只编辑一个东西，发送路由才不会打架。
   *
   * 附件与队列编辑同款回显：从这条插话的 file parts 还原（`restoreAttachments` 是
   * 整份替换，所以「这条没附件」会顺手清掉输入框里现有的附件 —— 与「编辑」语义一致）。
   */
  const startEditSteer = (item: AgentChatMessage): void => {
    const t = textOf(item);
    setEditing(null);
    setEditingSteer({
      id: item.id,
      text: t,
      conversationId: app.activeConversationId,
    });
    void app.removeSteer(item.id);
    textInput.setInput(t);
    restoreAttachments(fileRefsOfParts(item.parts), `steer-${item.id}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /**
   * 草稿区里那些**一次性资源**（附件 + 引用）的清理。
   *
   * 只在「这一轮确实要发」时才调（作为 store 的 `onStarted` 回调），**不在提交那一刻**：
   * 提交时就清等于赌这一轮一定发得出去 —— 被本地守卫拦下（没选模型 / 配置被删 / 连不上
   * 服务端）时，用户会发现自己不光消息没发出去，连刚拖进来的附件和挂的引用也没了。
   */
  const clearDraftArea = (): void => {
    setBothAttachments([]);
    setQuotes([]);
  };

  /** 输入区接线：发送走重发分支（有编辑起点）/ 插话分支（在编辑插话）还是普通发送 */
  const composer = useMainComposerProps(app, {
    textareaRef,
    editing,
    onCancelEdit: cancelEdit,
    editingSteer,
    onCancelEditSteer: cancelEditSteer,
    onEditSteer: startEditSteer,
    attachments,
    onPickFiles,
    onAttachFiles: onPickFiles,
    uploadProviders,
    uploadProviderId,
    onSelectUploadProvider: setUploadProviderId,
    onRefreshUploadProviders: () => void loadUploadProviders(),
    onRemoveAttachment: (id) =>
      setBothAttachments(attachmentsRef.current.filter((a) => a.id !== id)),
    onRestoreQueueFiles: (files, seed) => restoreAttachments(files, seed),
    quotes,
    onRemoveQuote: (id) => setQuotes((prev) => prev.filter((q) => q.id !== id)),
    // 发送钮选择器的「插话」：附件随插话一起注入当前轮（与队列同款）。
    // 附件区与引用等**确认插进去了再清**（`clearDraftArea` 是 store 的 onStarted 回调）
    // —— 被本地守卫拦下时这一轮什么都没发生，先清掉的话用户得把文件重传一遍。
    onSteer: (text, files, onStarted) =>
      app.steer(buildQuotedText(quotes, text), files, () => {
        onStarted();
        clearDraftArea();
      }),
    onSubmit: (text, onStarted) => {
      const target = editing;
      const steerTarget = editingSteer;
      const files = collectSendFiles();
      // 任一附件还在上传 → 不发（sendDisabled 已拦住按钮与 Enter，这里是兜底）
      if (hasUploadingAttachment) return false;
      // 引用拼进正文（markdown 引用块）：三条出口（普通发送 / 编辑重发 / 编辑插话）
      // 共用这一份拼装 —— 队列、插话因此天然带上引用（都是同一个 text）。
      // 拼一次、后面都递 `body`，别在各分支里各拼一遍（早晚漏一处）。
      const body = buildQuotedText(quotes, text);
      // 先摘掉编辑态再发：发出去的就是「编辑后的新消息」，输入框里不该还挂着编辑条。
      // 被拦下时再放回去（见下面两处的 `started`）—— 那两条消息**没被删**，用户还停
      // 在「编辑它」的语境里，编辑条与高亮就该原样在。
      setEditing(null);
      setEditingSteer(null);
      // 三条出口都把 `onStarted` 透传下去：输入框与草稿区都只在「确认开跑」后清，
      // 被拦下 / 建会话失败时用户写的内容原样还在（见 useMainComposerProps）
      if (target) {
        // 编辑并重发：先删掉该条及其后的全部消息再发（见 ChatPanel 文件头）
        const started = app.resendMessage(target.id, body, files, () => {
          onStarted();
          clearDraftArea();
        });
        // 拦下（没选模型 / 配置被删）：历史没删、消息还在，编辑态一并还回去。
        // 只在这个分支挂 `.then` —— 正常路径上编辑条已经在上面的 setEditing(null)
        // 摘掉了，不能等到 `onStarted` 才摘
        void started
          .then((ok) => {
            if (!ok) setEditing(target);
          })
          .catch(() => {});
        return started;
      }
      if (steerTarget) {
        // 编辑插话：重新走 steer（本轮还在跑 → 插回收件箱；刚好跑完 →
        // steer 自身回落普通发送，消息不离客户端）。附件一起递回 —— 不回传
        // 就会在这条路径上把图丢掉（编辑前明明回显在输入框里）
        const started = app.steer(body, files, () => {
          onStarted();
          clearDraftArea();
        });
        // 同上：拦下时把「正在编辑这条插话」还回去（它进编辑态时已从收件箱摘掉，
        // 这时还没插回去，所以留着编辑条才是诚实的）
        void started
          .then((ok) => {
            if (!ok) setEditingSteer(steerTarget);
          })
          .catch(() => {});
        return started;
      }
      return app.send(body, files, () => {
        onStarted();
        clearDraftArea();
      });
    },
  });

  // 一个项目都没有：给「创建项目」的落点 —— 此时初始页的输入框没有可挂的目录，
  // 只有个工作区下拉也太素，用户不知道下一步该干什么。
  // ⚠️ 但「列表还没拉回来」≠「没有项目」：刷新后的加载窗口先上骨架屏，别闪「还没有项目」。
  // 用户点了引导页上的「直接开始对话」= 明确要空态（`blankIntent`），就进输入页不再拦。
  // 临时工作区不算项目：那是「不选项目」发消息后自动建的，不该把引导页顶掉。
  if (!app.workspaces.some((w) => w.path && !w.scratch) && !blankIntent) {
    if (!app.conversationsLoaded && !app.error) return <NewTaskSkeleton />;
    return <NoProjectsView app={app} />;
  }
  // 初始页：没打开任何会话时（点「新建会话」/ 首次进入），中央输入框 + 下方选工作空间
  if (!app.activeConversationId) return <NewTaskView app={app} />;

  return (
    <>
      <ChatSurface
        list={{
          messages,
          // 错误块（`⚠️ ` 前缀）后面那颗「重新加载」要知道重载哪一条 —— 多标签下
          // 同时挂着好几条会话，不能读「当前会话」
          ...(app.activeConversationId ? { conversationId: app.activeConversationId } : {}),
          streaming,
          // 断线重连的回放窗口：滚动跟随降级成瞬时贴底（否则内容先塌后长时会被
          // 弹簧带着从顶部一路滚下来，观感是「列表像在重新加载」）
          replaying: app.replaying,
          // 模型请求正在重试：在「正在思考…」的位置显示单条「第 N 次重试」
          retryNotice: app.retryNotice,
          // 连接断了但服务端那轮还在跑：在「正在思考…」的位置显示「连接中断，正在重连」
          reconnectNotice: app.reconnectNotice,
          // resetKey：切换会话 / 消息装载完成 / **自己发出新消息**时立刻落底
          // （滚动容器内部同步赋值，无动画）
          resetKey: `${app.activeConversationId ?? ""}#${app.scrollResetSeq}`,
          // 正在编辑重发的那条消息（描边压暗）——与输入框卡片内的编辑条是一对
          editingMessageId: editing?.id ?? null,
          // 正在删消息：消息区压暗 + 不收点击 + 顶部「正在删除…」（删除完成后要整体
          // 回拉历史，中途再点别的消息只会让两边互相盖）
          deleting: app.messagesDeleting,
          header: (
            <>
              {/*
              切换会话的装载窗口：id 已切过去、历史还没拉回来。这里必须显示装载中 ——
              否则会一直挂着上一个会话的消息列表，用户在它上面删除 / 编辑拿的是旧 id
              配新会话，服务端对不上就报错（见 useAgentApp.openConversation 的注释）。
            */}
              {app.reconnectNotice && (
                <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
                  <span className="inline-flex items-center gap-1 font-medium text-foreground">
                    <Unplug className="size-3.5" />
                    {t("连接中断")}
                  </span>
                  <span>
                    {t("正在自动重连（第 {attempt} 次）· 服务端这一轮还在跑，接上就接着出", {
                      attempt: app.reconnectNotice.attempt,
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void app.reconnectRun(app.activeConversationId ?? "")
                    }
                    className="ml-auto rounded border px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-foreground/10"
                  >
                    {t("立即重连")}
                  </button>
                </div>
              )}
              {app.contextNotice && (
                <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
                  <span className="inline-flex items-center gap-1 font-medium text-foreground">
                    <Gauge className="size-3.5" />
                    {t("上下文已压缩")}
                  </span>
                  <span>
                    {t("压缩前 {tokens} token", { tokens: app.contextNotice.beforeTokens.toLocaleString() })}
                  </span>
                  <span>
                    {t("→ 压缩后 {tokens} token", { tokens: app.contextNotice.afterTokens.toLocaleString() })}
                  </span>
                  <span>
                    {t("摘要了 {summarized} 轮，保留 {kept} 轮", {
                      summarized: app.contextNotice.summarizedTurns ?? 0,
                      kept: app.contextNotice.keptTurns ?? 0,
                    })}
                  </span>
                </div>
              )}
            </>
          ),
          // 会话历史加载失败：错误态 + 重试（替代原本静默吞掉的空视图）
          error:
            app.messagesError &&
            !app.messagesLoading &&
            messages.length === 0 ? (
              <MessagesLoadError
                error={app.messagesError}
                onRetry={app.retryLoadMessages}
              />
            ) : undefined,
          loading: app.messagesLoading,
          emptyState: (
            <div className="flex flex-col items-center gap-2 text-center">
              <MessageSquare className="size-8 opacity-40" />
              <div className="text-sm font-medium">
                {activeWorkspace
                  ? t("在「{name}」里说点什么", { name: activeWorkspace.name })
                  : t("先添加一个工作区")}
              </div>
              <div className="text-xs text-muted-foreground">
                {activeWorkspace
                  ? t("Agent 会在该目录内执行命令、读写文件；工作区外的路径一律拒绝")
                  : t("工作区就是 Agent 的边界：只有登记过的目录能被读写")}
              </div>
            </div>
          ),
          followup: {
            requests: app.followupRequests,
            onResolve: (toolCallId, answer) => {
              void app.resolveFollowup(toolCallId, answer);
            },
            /**
             * 补答：那一轮已经结束（应用退出 / 停止 / 进程崩了），提问卡上的答案回填不到
             * 工具里 —— 当一条普通用户消息发出去（文本由 `formatFollowupAnswer` 拼好，
             * 带着题目，模型才知道在回答什么）。会话正在跑时 `send` 会入队，不会插队。
             */
            onResume: (text) => {
              void app.send(text);
            },
          },
          /**
           * 消息下方的**文档入口**：本轮写出 / 改动的 markdown 文档（设计稿 /
           * 方案 / 规格等）各渲染成一颗 chip，点开在右侧「文件」面板里读 ——
           * 先是 `showSideTab('files')` 把面板挂出来（面板可能压根没开过），
           * 再递一条「打开这个文件」的请求。请求是**先存后取**的，面板这一刻
           * 才挂出来也不会丢（见 `features/files/open-file.ts`）。
           *
           * 为什么挂在消息下方而不是正文里：正文是模型说的话，工具卡是过程
           * （一轮结束还会被折叠）——「给你的交付物」需要一个稳定的位置。
           */
          renderArtifacts: (message) => {
            const docs = presentedDocsOf(message);
            if (docs.length === 0) return null;
            return (
              <ArtifactChips
                docs={docs}
                onOpen={(doc) => {
                  showSideTabOf(panelKey, "files");
                  requestOpenWorkspaceFile(
                    app.activeWorkspaceId ?? "",
                    doc.path,
                  );
                }}
              />
            );
          },
          /*
           * 「本轮用量」不再走 `renderFooter`（那一行比正文还宽、把消息列表压得很碎）。
           * 用户要求把它改成**与复制同一形态的一颗图标**、并排在同一行里 ——
           * 现在由 `renderActions` 通过 `usageSlot` 塞进操作行（见下面两处）。
           * `renderFooter` 就此不用了。
           */
          renderActions: ({ message, index, total }) => {
            /*
             * 「本轮用量」那颗图标：所有**助手**消息都给（只要有 usage）。
             * 内置 agent 每轮 finish 一定带 usage；ACP 没有（`acp.ts` 适配层丢弃），
             * 所以 ACP 会话自动就是「不显示」，不需要在这里判 activeIsAcp。
             * 用 `message.usage` 而不是「是不是末条」：历史里每一轮都有账目，
             * 翻上去看某一轮花了多少也是常见用法。
             */
            const usageSlot =
              message.role === "assistant" && message.usage ? (
                <UsageRow usage={message.usage} />
              ) : undefined;
            // acp 会话的历史在 agent 侧，改不了也删不掉 —— 挂「复制」+「从此转为内置会话」
            // （编辑 / 删除都给不了，见 `CopyOnlyActions`）
            if (activeIsAcp) {
              // 跑着 / 等答复时不给「从此转为内置 Agent 会话」：agent 侧那份转录还没落回
              // session，作为终点的历史会缺一段（与侧栏那一项的禁用判据同一道理）。
              return (
                <CopyOnlyActions
                  message={message}
                  index={index}
                  total={total}
                  usageSlot={usageSlot}
                  onConvert={
                    streaming ? undefined : () => setConvertTarget(message.id)
                  }
                />
              );
            }
            // 正在编辑重发的那条不挂 —— 编辑标识在「输入框上的编辑条 + 这条消息的描边」上，
            // 操作行再杵着只会诱导用户对着要重发的内容点删除（「流式末条不挂」由 MessageList 统一挡掉）
            if (message.id === editing?.id) return null;
            return (
              <MessageActionRow
                message={message}
                deleteCount={total - index}
                usageSlot={usageSlot}
                onEdit={() => {
                  const t = textOf(message);
                  const fileParts = message.parts.filter(
                    (p) => p.type === "file",
                  );
                  // 空文本但带附件的历史消息也能编辑（附件回显就是编辑的起点之一）
                  if (!t && fileParts.length === 0) return;
                  // 灌原文 + 记住起点；聚焦到输入框让用户接着改。
                  // 同时摘掉插话编辑态：一次只编辑一个东西
                  setEditingSteer(null);
                  textInput.setInput(t);
                  // 附件回显：编辑带附件的消息时，附件回到输入框附件区（用户明确要求）
                  restoreAttachments(
                    fileParts.map((f) => ({
                      name: f.name,
                      mediaType: f.mediaType,
                      url: f.url,
                    })),
                    `edit-${message.id}`,
                  );
                  setEditing({
                    id: message.id,
                    text: t,
                    conversationId: app.activeConversationId,
                  });
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                onDelete={(mode) => {
                  void (mode === "single"
                    ? app.deleteMessage(message.id)
                    : app.deleteMessagesFrom(message.id));
                }}
                onFork={() => setForkTarget(message.id)}
              />
            );
          },
          // 消息目录：用户消息各占一段，悬停预览、点击跳转
          outline: true,
        }}
        composer={composer}
      />
      {/* 消息区划选 → 浮出「引用」按钮。浮层自挂 body（fixed），放在渲染树哪一层都行 */}
      <MessageQuoteLayer onQuote={(q) => setQuotes((prev) => [...prev, q])} />
      <ForkDialog
        app={app}
        messageId={forkTarget}
        open={forkTarget !== null}
        onOpenChange={(o) => {
          if (!o) setForkTarget(null);
        }}
      />
      {/* 「转为内置 Agent 会话」确认弹窗：与「从此签出」同一个壳（选工作区 / 建 worktree） */}
      <ConvertAcpDialog
        app={app}
        conversationId={app.activeConversationId ?? ""}
        messageId={convertTarget}
        open={convertTarget !== null}
        onOpenChange={(o) => {
          if (!o) setConvertTarget(null);
        }}
      />
    </>
  );
}
