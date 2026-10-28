/**
 * 会话详情那颗「模型 / 后端」pill —— `ModelPicker` 的**会话版薄壳**。
 *
 * 职责只有两件，别往这里加第三件：
 * 1. 把 `app` 里的清单灌给 `ModelPicker`（`models` / `acpAgents` / 默认窗口）；
 * 2. 按**活动会话**算出「该不该锁后端」：acp 会话只显示它绑定的那个 agent，
 *    已有 内置会话时不出 ACP 组（换类型 = 新建会话）；
 * 3. 读写 `chatTarget`（`setChatTarget` 会顺手探 ACP 档位、把目标持久化到会话目录）。
 *
 * 控件本身（分组 / 齿轮 / 手机拍平 / 勾选）全在 `ModelPicker` 里，定时任务表单复用的
 * 就是同一份 —— 那边没有 `AgentApp`，只多了一层局部状态。
 */
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { ModelPicker } from '@fizz/agent-kit/features/chat/ModelPicker'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { t } from '@fizz/i18n'

export function ModelSelect({ app }: { app: AgentApp }) {
  // 订阅语言：tooltip 文案是渲染期求值的
  useT()
  const { openSettingsTab } = useAppContext()

  const activeConversation = app.conversations.find((c) => c.id === app.activeConversationId)
  // acp 会话绑定的 agent 被删了（会话里记的还是旧 id）→ 当作没锁：`lockedAgent` 为
  // undefined 时两组全出，用户能看到「原来那个已经不在清单里」并重选
  const lockedAgent =
    activeConversation?.backend === 'acp'
      ? app.acpAgents.find((a) => a.id === activeConversation.configId)
      : undefined

  return (
    <ModelPicker
      models={app.models}
      acpAgents={app.acpAgents}
      value={app.chatTarget}
      onChange={app.setChatTarget}
      {...(lockedAgent ? { lockedAgent } : {})}
      // 内置会话 / 空态之外不出 ACP 组：有会话就换不了类型
      showAcp={!activeConversation}
      emptyTitle={t('这一轮用哪个模型 / 哪个外部 Agent（下一轮生效）')}
      // `defaultContextWindow` 是 `number | null`（服务端没配就是 null），
      // 这里转成 undefined 让 `ModelPicker` 走它自己的 DEFAULT_CONTEXT_WINDOW 兜底
      defaultContextWindow={app.defaultContextWindow ?? undefined}
      onOpenSettings={openSettingsTab}
    />
  )
}
