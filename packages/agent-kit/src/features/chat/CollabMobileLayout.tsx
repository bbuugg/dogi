import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { CollabWorkspace } from '@fizz/agent-kit/features/collab/CollabWorkspace'
import { ChatPanel } from '@fizz/agent-kit/features/chat/ChatPanel'

/**
 * 手机上的协作布局：画布在上、主智能体对话固定在下方 45dvh。
 *
 * 手机**不进 `ResizablePanelGroup`**：竖排 Group 会给面板内层写
 * `touch-action: pan-x`（库对竖排的取值，且 style 盖不掉），聊天记录就滑不动了。
 */
export function CollabMobileLayout({ app, panelKey }: { app: AgentApp; panelKey: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CollabWorkspace app={app} />
      <div className="flex h-[45dvh] min-h-0 shrink-0 flex-col border-t">
        <ChatPanel app={app} panelKey={panelKey} />
      </div>
    </div>
  )
}
