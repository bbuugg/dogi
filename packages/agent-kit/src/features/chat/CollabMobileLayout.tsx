import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { CollabWorkspace } from '@fizz/agent-kit/features/collab/CollabWorkspace'
import { CollabAgentChatPanel } from '@fizz/agent-kit/features/collab/CollabAgentChatPanel'
import { ChatPanel } from '@fizz/agent-kit/features/chat/ChatPanel'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type { CollabAgentConfig, CollabSettings } from '@fizz/contracts/types'

/**
 * 手机上的协作布局：画布在上、对话固定在下方 45dvh。
 *
 * 手机**不进 `ResizablePanelGroup`**：竖排 Group 会给面板内层写
 * `touch-action: pan-x`（库对竖排的取值，且 style 盖不掉），聊天记录就滑不动了。
 *
 * 下方那块与桌面右侧是**同一件事**：点画布上任意一个 Agent，就把下方换成它的消息
 * （`viewingAgent` 为 null 时是主智能体对话）。桌面的分栏宽度 / 手机上的高度都不变。
 */
export function CollabMobileLayout({
  app,
  panelKey,
  viewingAgent,
  collabSettings,
  onViewAgent
}: {
  app: AgentApp
  /** 拼面板现场用的 key（与会话 id 同源） */
  panelKey: string
  /** 下方正在看的子 Agent（null = 主智能体） */
  viewingAgent: CollabAgentConfig | null
  /** 协作配置：Agent 面板里编辑时要拼回完整对象 */
  collabSettings: CollabSettings
  /** 画布请求切换下方面板的内容（null = 回主智能体） */
  onViewAgent: (agentId: string | null) => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CollabWorkspace
        app={app}
        viewingAgentId={viewingAgent?.id ?? null}
        onViewAgent={onViewAgent}
      />
      <div className="flex h-[45dvh] min-h-0 shrink-0 flex-col border-t">
        {/* 与桌面同理：主对话常驻，被 Agent 面板盖住时只是 `hidden`（草稿 / 滚动位置不丢） */}
        <div
          className={cn('min-h-0 flex-1 flex-col', viewingAgent ? 'hidden' : 'flex')}
        >
          <ChatPanel app={app} panelKey={panelKey} />
        </div>
        {viewingAgent && (
          <CollabAgentChatPanel
            app={app}
            agent={viewingAgent}
            settings={collabSettings}
            onBackToMain={() => onViewAgent(null)}
          />
        )}
      </div>
    </div>
  )
}
