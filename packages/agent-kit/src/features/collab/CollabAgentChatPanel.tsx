'use client'

/**
 * 协作画布**右侧对话区**：正在看某个子 Agent 的消息。
 *
 * 用户在画布上点一个 Agent，右边的 `ChatPanel` 就换成这一页 —— 位置不动、宽度不动、
 * 分栏不重排，只是面板里的内容从「主智能体对话」变成「这个 Agent 的消息」。**不是弹窗**，
 * 也不是新开标签：切回来只要点画布上的主智能体（或头部的返回箭头）。
 *
 * ## 为什么没有输入框
 *
 * 子 Agent 在服务端**没有会话记录**，也不接受用户直连：它每被派一次活就是一个 `CollabTask`
 * （prompt 进、output/error 出），派活由主智能体在左侧（手机上是下方）的对话里发起。
 * 所以这里的消息是**只读的**，底部那行字必须留着——否则用户会一直找输入框。
 *
 * ## 数据从哪来
 *
 * 与画布共用同一个 `app`（当前协作会话的视图），所以 `app.collab.state` 就是实时状态：
 * 任务、流式文本、状态点都会跟着推送走。消息拼装放在 `agent-messages.ts`，
 * 与画布上那套是同一份逻辑。
 */
import { useMemo, useState } from 'react'
import { ArrowLeft, Bot, Pencil } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { CopyOnlyActions, MessageList } from '@fizz/agent-kit/features/chat/chat-surface'
import { AgentConfigDialog } from '@fizz/agent-kit/features/collab/AgentConfigDialog'
import {
  EMPTY_LIVE_PARTS,
  EMPTY_LIVE_TEXT,
  EMPTY_TASKS,
  STATUS_META,
  collabAgentChat
} from '@fizz/agent-kit/features/collab/agent-messages'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { CollabAgentConfig, CollabSettings } from '@fizz/contracts/types'

export function CollabAgentChatPanel({
  app,
  agent,
  settings,
  onBackToMain
}: {
  app: AgentApp
  /** 正在看的子 Agent（父级已确认它还在配置里） */
  agent: CollabAgentConfig
  /** 整份协作配置：编辑弹窗保存时要用它拼回完整对象 */
  settings: CollabSettings
  /** 回到主智能体的对话（点画布主节点、点这里的返回箭头都走它） */
  onBackToMain: () => void
}) {
  const state = app.collab?.state
  const liveText = app.collab?.liveText ?? EMPTY_LIVE_TEXT
  const liveParts = app.collab?.liveParts ?? EMPTY_LIVE_PARTS
  const tasks = state?.tasks ?? EMPTY_TASKS
  /**
   * ⚠️ 依赖只放 `tasks` / `liveText` / `liveParts` / `agent.id`：`state` 每来一帧都是
   * 新对象，而真正会变的是任务数组、实时文本与运行中的工具卡。
   */
  const chat = useMemo(
    () => collabAgentChat(tasks, liveText, agent.id, liveParts),
    [tasks, liveText, liveParts, agent.id]
  )
  const meta = STATUS_META[state?.statuses?.[agent.id]?.status ?? 'idle']
  const [editing, setEditing] = useState(false)

  const save = (next: CollabAgentConfig): void => {
    void app.saveCollabSettings({
      ...settings,
      agents: settings.agents.map((item) => (item.id === next.id ? next : item))
    })
    setEditing(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/*
        一条头部：返回主对话 + 名字 + 状态 + 编辑。
        横向内边距与消息列同一套（`px-2 sm:px-6`，`MessageList` 的默认值），
        名字与下面第一条消息左缘对齐 —— 与主会话里标题 / 消息的关系一致。
        右侧对话区可能只有 320px 宽，所以职责不显示（画布节点上已经有），
        按钮一律 icon-only，只留 tooltip。
      */}
      <div className="shrink-0 border-b">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-1.5 px-2 py-2 sm:px-6">
          <Button
            size="icon-sm"
            variant="ghost"
            className="-ml-1 size-7 shrink-0 text-muted-foreground"
            title={`回到「${settings.mainName}」`}
            aria-label={`回到「${settings.mainName}」`}
            onClick={onBackToMain}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <Bot className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{agent.name}</span>
          <span className={cn('flex shrink-0 items-center gap-1 text-xs', meta.text)}>
            <span className={cn('size-1.5 rounded-full', meta.dot)} />
            {meta.label}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto size-7 shrink-0 text-muted-foreground"
            title="编辑这个 Agent"
            aria-label="编辑这个 Agent"
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3.5" />
          </Button>
        </div>
      </div>
      {/*
        与主会话**同一套** `MessageList`：气泡、代码块、工具卡、滚动跟随、右侧消息目录
        全部复用，只有数据来源不同 —— 子 Agent 的一轮 = 一个任务（问 + 答）。
        ⚠️ 不传 `contentClassName` 且显式 `outline`：主会话那边就是这么配的，
        一改左右留白与目录竖线就跟着变，用户一眼看出「和普通会话不一样」。
      */}
      <MessageList
        messages={chat.messages}
        streaming={chat.streaming}
        resetKey={agent.id}
        outline
        renderActions={({ message, index, total }) => (
          <CopyOnlyActions message={message} index={index} total={total} />
        )}
        emptyState={
          <p className="text-sm text-muted-foreground">
            {state
              ? `「${settings.mainName}」还没有给 ${agent.name} 派过活`
              : '正在读取这个协作会话的状态…'}
          </p>
        }
      />
      {/* 没有输入框是**设计**：子 Agent 不接受用户直连（见文件头），这行字别删 */}
      <div className="shrink-0 border-t px-2 py-2 text-center text-xs text-muted-foreground sm:px-6">
        任务由「{settings.mainName}」派发 —— 这里能看到它的每一轮问答，但不能直接对它说话
      </div>
      {editing && (
        <AgentConfigDialog
          app={app}
          agent={agent}
          isNew={false}
          onOpenChange={(open) => {
            if (!open) setEditing(false)
          }}
          onSave={save}
        />
      )}
    </div>
  )
}
