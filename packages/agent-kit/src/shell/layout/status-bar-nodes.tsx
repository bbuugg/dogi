import { activeTabKey, usePanelState } from '@fizz/agent-kit/shared/lib/panel-store'
import { hostIdOfTabKey } from '@fizz/agent-kit/shared/lib/panel-tabs'
import { HostMonitorBadge } from '@fizz/agent-kit/features/hosts/HostMonitorBadge'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** Tab-specific status follows the focused group, never the global conversation selection. */
export function StatusBarNodes({ app }: { app: AgentApp }) {
  const state = usePanelState()
  const tabKey = activeTabKey(state)
  // 主区域只有一套面板（流程视图已删），不必再判「当前是不是对话视图」
  if (!tabKey) return null

  const hostId = hostIdOfTabKey(tabKey)
  if (!hostId) return null

  return <HostMonitorBadge key={hostId} api={app.api} hostId={hostId} />
}
