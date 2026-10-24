/**
 * AI 助手面板。
 *
 * ## 两种挂载形态（工具集**互斥**，由 `scope` 决定）
 *
 * - **全局**（`scope = 'project'`）：挂在 app-shell 右侧停靠。只挂项目管理工具
 *   （建 / 删项目、worktree、定时任务…），**没有终端工具** —— 它没有绑定任何终端。
 * - **标签页内嵌**（`scope = 'terminal'`）：终端标签里挂一份，绑定那个终端。只挂那个
 *   终端的工具（执行命令 / 读输出 / 发按键），**没有项目工具** —— 一条绑定终端的会话里
 *   出现「建项目 / 删 worktree」没有语境。
 *
 * ## 会话是**共享的一份池子**，不是「一个面板一段」
 *
 * 两种形态读写的是同一份 `assistantConversations` + `assistantActiveId`（见
 * `slices/assistant.ts`）：在终端助手里聊的内容，打开项目助手照样看得到、能接着聊；
 * 顶栏那个下拉能在历史会话之间切换，也可以开一段新的。落盘在 localStorage
 * （`lib/assistant-history.ts`），重启后仍在同一段上。
 *
 * 挂载只 `ensureAssistantSession`（有当前会话就复用），卸载**不**清 —— 收起 / 展开、
 * 切标签都保持同一段对话。
 *
 * 其余（消息渲染 / 审批卡 / 模型 pill）两种形态完全一致。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  PanelRightClose,
  Plus,
  Sparkles,
  Terminal,
  Trash2
} from 'lucide-react'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { setAssistantPanelOpen } from '@fizz/agent-kit/shared/lib/assistant-panel'
import { assistantConversationTitle } from '@fizz/agent-kit/shared/lib/assistant-history'
import { ConfirmDeleteDialog } from '@fizz/agent-kit/shared/components/ConfirmDeleteDialog'
import {
  loadAssistantTarget,
  saveAssistantTarget,
  type AssistantTarget
} from '@fizz/agent-kit/shared/lib/assistant-target'
import { ChatSurface, CopyOnlyActions } from '@fizz/agent-kit/features/chat/chat-surface'
import { ConfirmQueue } from '@fizz/agent-kit/features/chat/ConfirmCard'
import { CHAT_PILL, PermissionPill } from '@fizz/agent-kit/features/chat/composer'
import { Button } from '@fizz/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuGroup
} from '@fizz/ui/dropdown-menu'

/**
 * 切换器里那一行的时间戳：今天给 `HH:mm`、昨天给「昨天」、更早给 `M-D`。
 *
 * 只用来区分「哪段是哪段」（同一句话开头聊出来的两段会话标题会一样），不做精确到秒的
 * 还原 —— 所以不引日期库。
 */
function shortTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return '昨天'
  return `${d.getMonth() + 1}-${d.getDate()}`
}

export function AssistantPanel({
  className,
  /** 工具作用域：`project` = 只有项目工具；`terminal` = 只有该终端的工具 */
  scope,
  /** `scope === 'terminal'` 时：绑定的终端标签 key（取终端工具 + 工具默认目标） */
  boundTerminalTabKey,
  /** 内嵌形态：收起面板（全局形态不传，收起走全局开关） */
  onClose
}: {
  className?: string
  scope: 'project' | 'terminal'
  boundTerminalTabKey?: string
  onClose?: () => void
}) {
  const embedded = scope === 'terminal'
  const conversations = useAgentStore((s) => s.assistantConversations)
  const activeId = useAgentStore((s) => s.assistantActiveId)
  const ensureAssistantSession = useAgentStore((s) => s.ensureAssistantSession)
  const newAssistantSession = useAgentStore((s) => s.newAssistantSession)
  const switchAssistantSession = useAgentStore((s) => s.switchAssistantSession)
  const deleteAssistantSession = useAgentStore((s) => s.deleteAssistantSession)
  const setAssistantDraft = useAgentStore((s) => s.setAssistantDraft)
  const sendAssistant = useAgentStore((s) => s.sendAssistant)
  const stopAssistant = useAgentStore((s) => s.stopAssistant)
  // 模型清单镜像(state-ws 快照,设置页增删模型后自动到)
  const modelConfigs = useAgentStore((s) => s.models)
  /**
   * 工具权限档：**直接用全局那一份**（主会话那颗 pill / 「设置 → 通用」改的就是它），
   * 助手面板不另存一个偏好 —— 「工具权限」在 Fizz 里是应用级概念，两处各记一份必然分叉。
   *
   * 生效范围随 scope 不同（见 `AssistantSendInput.permissionMode`）：终端助手三档全生效，
   * 项目助手只认 `readonly`（项目工具的审批是刻意写死的，不受档位放松）。
   */
  const permissionMode = useAgentStore((s) => s.permissionMode)
  const setPermissionMode = useAgentStore((s) => s.setPermissionMode)
  const setAssistantPermissionMode = useAgentStore((s) => s.setAssistantPermissionMode)
  /**
   * 切档：既存全局偏好（下一轮用），也把**这一轮正在跑的助手 run** 的活档改掉 ——
   * 工具闸每次调用现取，切完下一次工具调用立刻生效（与主会话同一套语义）。
   */
  const handlePermissionChange = (mode: typeof permissionMode): void => {
    setPermissionMode(mode)
    setAssistantPermissionMode(mode)
  }

  const session = activeId ? conversations[activeId] : undefined

  /**
   * 挂载 = **确保有当前会话**，不是「开新会话」；卸载也不清。
   *
   * ⚠️ 依赖只有这个函数：面板重渲染不该动对话。全局面板由 app-shell 按开关条件渲染、
   * 内嵌的由 TerminalTabView 按展开状态渲染 —— 所以「重新挂载」恰好就是用户眼里的
   * 「重新打开」，而这里要保证的正是「重开还在」。
   */
  useEffect(() => {
    ensureAssistantSession()
  }, [ensureAssistantSession])

  // 模型偏好:全局一份(跨助手会话),存 localStorage;清单里被删掉的配置视为未选
  const [target, setTarget] = useState<AssistantTarget | null>(() => loadAssistantTarget())
  useEffect(() => {
    saveAssistantTarget(target)
  }, [target])

  const modelOptions = useMemo(
    () => modelConfigs.filter((m) => m.models.length > 0),
    [modelConfigs]
  )
  const targetValue =
    target && modelOptions.some((o) => o.id === target.configId && o.models.some((model) => model.id === target.modelId))
      ? `${target.configId}:${target.modelId}`
      : ''
  /**
   * 触发器上的短标签：与主会话那颗模型 pill（`ChatPanel` 的 `ModelSelect`）**同构** ——
   * 面上只给模型名，提供商（配置名）挪进 title（见 `targetTitle`），超长靠 title 看全。
   * 面板本来就窄，pill 还带 `max-w-48`（`CHAT_PILL`），「配置 · 模型」会被截掉尾巴。
   */
  const targetLabel = targetValue && target ? target.modelId : '选择模型'
  /** 悬停提示：`配置 · 模型`（与主会话 `targetLabel(app)` 那颗 title 同构） */
  const targetTitle =
    targetValue && target
      ? `${modelOptions.find((o) => o.id === target.configId)?.name ?? target.configId} · ${target.modelId}`
      : '未选时由服务端取第一份可用模型'

  /**
   * 切换器里的清单：按更新时间倒序。**空会话不列**（新建了还没说话的那些是噪音），
   * 只有当前这段例外 —— 它得在列表里带着勾，否则用户看不到「我在哪一段」。
   */
  const historyList = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => c.messages.length > 0 || c.sessionId === activeId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations, activeId]
  )
  const activeTitle = session ? assistantConversationTitle(session.messages) : '助手'

  /**
   * 草稿存在现场里（不是本地 `useState`）：收起面板 = 卸载，`useState` 会跟着没，
   * 打了一半的话就白打了。`''` 兜底只是首次挂载那一瞬（`ensure` 还没跑完）。
   */
  const draft = session?.draft ?? ''
  const streaming = !!session?.streaming
  const hasMessages = (session?.messages.length ?? 0) > 0
  /** 「删除这段会话」的二次确认（与设置里删模型 / 删密钥同一个弹窗） */
  const [confirmDelete, setConfirmDelete] = useState(false)

  const submit = (): void => {
    const text = draft.trim()
    if (!text || streaming) return
    void sendAssistant(
      text,
      scope,
      target ?? undefined,
      boundTerminalTabKey ?? null,
      permissionMode
    )
    setAssistantDraft('')
  }

  const closePanel = (): void => {
    if (onClose) onClose()
    else setAssistantPanelOpen(false)
  }

  return (
    <div className={className}>
      {/* 顶栏：会话切换器（标题 + 历史会话 + 新建）+ 删除当前会话 + 收起 */}
      <div className="flex items-center gap-2 px-3 py-2">
        {embedded ? (
          <Terminal className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="切换助手会话"
              title={`${embedded ? '终端助手' : '项目助手'} · ${activeTitle}`}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-[state=open]:bg-accent/60"
            >
              <span className="truncate">{activeTitle}</span>
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6} className="max-h-80 min-w-64 overflow-y-auto">
            <DropdownMenuItem onSelect={() => newAssistantSession()}>
              <Plus className="size-3.5 shrink-0" />
              新建会话
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="px-2 text-xs font-normal text-muted-foreground">
                历史会话
              </DropdownMenuLabel>
              {historyList.map((item) => (
                <DropdownMenuItem
                  key={item.sessionId}
                  onSelect={() => switchAssistantSession(item.sessionId)}
                  // 正在跑的那段给个记号：切走之后它还在后台继续（帧仍落到自己那段上）
                  title={assistantConversationTitle(item.messages)}
                  className="gap-2"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {assistantConversationTitle(item.messages)}
                  </span>
                  {item.streaming && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">进行中</span>
                  )}
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {shortTime(item.updatedAt)}
                  </span>
                  {item.sessionId === activeId && <Check className="size-3.5 shrink-0" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* 删除 = 把这段会话从本地存档里删掉（想开新的用切换器里的「新建会话」） */}
        <Button
          size="icon-sm"
          variant="ghost"
          title={hasMessages ? '删除这段会话' : '还没有对话内容'}
          aria-label="删除这段会话"
          disabled={!hasMessages}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="size-4 text-muted-foreground" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          title="收起助手面板"
          aria-label="收起助手面板"
          onClick={closePanel}
        >
          <PanelRightClose className="size-4 text-muted-foreground" />
        </Button>
      </div>

      <ConfirmDeleteDialog
        open={confirmDelete}
        title="删除这段会话？"
        // 说清「丢什么、怎么办」：助手历史只有本地一份，删了没有回收站；想留就新建一段
        description={
          // 用字符串表达式拼，而不是把中文散在 JSX 行间：换行会被折叠成一个空格，
          // 「删除后 无法恢复」里多出那个空格很扎眼
          <>
            {'这段对话会从本地存档里删除，助手历史只有本地一份，删除后'}
            <span className="font-medium text-foreground">无法恢复</span>
            {'。只想开一段新的，用标题栏下拉里的「新建会话」。'}
            {streaming && '正在生成的那一轮也会被停止。'}
          </>
        }
        confirmLabel="删除"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          if (activeId) deleteAssistantSession(activeId)
        }}
      />

      <ChatSurface
        list={{
          messages: session?.messages ?? [],
          streaming,
          // 自己发送 / 开始新一轮时同帧落底（seq 在切片里 bump，流式追加不碰它）
          resetKey: `${session?.sessionId ?? ''}#${session?.scrollResetSeq ?? 0}`,
          contentClassName: 'mx-auto w-full px-4 py-4 max-w-3xl',
          error:
            session?.error && !streaming ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {session.error}
              </div>
            ) : undefined,
          emptyState: (
            <div className="flex flex-col items-center gap-2 text-center">
              {embedded ? (
                <Terminal className="size-8 opacity-40" />
              ) : (
                <Sparkles className="size-8 opacity-40" />
              )}
              <div className="text-sm font-medium">
                {embedded ? '让助手操作这个终端' : '让助手帮你管项目'}
              </div>
              <div className="max-w-64 text-xs text-muted-foreground">
                {embedded
                  ? '试试:「看看当前目录」「列出最近的日志文件」「跑一下测试」'
                  : '试试:「列出我的项目」「把 github.com/xxx/yyy 克隆到默认目录」「打开某个项目」'}
              </div>
            </div>
          ),
          // 助手历史在本地内存里、改不了，只留复制
          renderActions: CopyOnlyActions
        }}
        composer={{
          value: draft,
          onChange: (text) => setAssistantDraft(text),
          onSubmit: submit,
          onCancel: () => stopAssistant(),
          streaming,
          // 占位文案只留「要它干什么」这半句：面板最窄 320px，带上
          // 「(Enter 发送,Shift+Enter 换行)」会折成两行 —— 而紧凑态空态高度被钉成一行，
          // 折行的那半截就被裁掉了。Enter 发送 / Shift+Enter 换行是 Composer 的固定行为
          // （见其文件头注释），面板里不再用占位文案复述。
          placeholder: embedded ? '让助手执行 / 读取这个终端…' : '让助手创建 / 打开 / 删除项目…',
            variant: 'panel',
            // 窄面板：输入框初始收成一行高（内容变长仍会自己长高）
            compact: true,
            // 工具权限：与主会话同一颗 pill（`PermissionPill`，图标编码档位、档名进 tooltip）。
            // 助手面板是「一句话就让 agent 动手」的入口，没有这一档就等于默认裸跑 ——
            // 终端助手的 run_in_terminal / send_keys 会直接在你眼前那台终端里执行。
            // 只用图标（`CHAT_ICON_PILL`，32px）：面板本来就窄，一颗带文字的 pill 会把
            // 模型 pill 挤掉。
            leading: <PermissionPill value={permissionMode} onChange={handlePermissionChange} />,
            // 模型 pill：与主会话（ChatPanel 的 ModelSelect）同一颗皮（`CHAT_PILL`）——
            // 无边框胶囊 + 前置 Sparkles + 不画右侧箭头。助手只有内置 mastra 的
            // 「配置 × 模型」，没有 ACP 那层，所以一个下拉按配置分组铺开即可。
            trailing: (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="助手模型"
                    title={targetTitle}
                    className={CHAT_PILL}
                  >
                    <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{targetLabel}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="end"
                  sideOffset={6}
                  className="max-h-80 min-w-56 overflow-y-auto"
                >
                  {modelOptions.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">还没有可用模型</div>
                  ) : (
                    modelOptions.map((config) => (
                      <DropdownMenuGroup key={config.id}>
                        {/* 组名用与主会话同款的小号灰字（避免和模型项混成一片） */}
                        <DropdownMenuLabel className="px-2 text-xs font-normal text-muted-foreground">
                          {config.name}
                        </DropdownMenuLabel>
                        {config.models.map((model) => {
                          const modelId = model.id
                          const value = `${config.id}:${modelId}`
                          return (
                            <DropdownMenuItem
                              key={value}
                              onSelect={() => setTarget({ configId: config.id, modelId })}
                            >
                              <span className="truncate">{modelId}</span>
                              {targetValue === value && <Check className="ml-auto size-3.5" />}
                            </DropdownMenuItem>
                          )
                        })}
                      </DropdownMenuGroup>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          above: (
            <>
              {/* 待答复的审批:与主会话同一张卡、同一个答复端点 */}
              {session && session.pendingConfirms.length > 0 && (
                <ConfirmQueue
                  confirms={session.pendingConfirms}
                  onResolve={(id, approved, optionId) => {
                    const api = useAgentStore.getState().getApi()
                    void api?.resolveConfirm(id, approved, optionId)
                  }}
                />
              )}
            </>
          )
        }}
      />
    </div>
  )
}
