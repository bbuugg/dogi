/**
 * 设置项的**内容区**：给一个 tab id，渲染对应表单。
 *
 * 导航形态（桌面两栏 / 手机两级）不进这里 —— 两个壳只负责「选中了哪一项、滚动容器
 * 多大」，内容由这一份统一渲染，免得两边的表单各漂一份。
 * 新增设置项 = `sections.ts` 登记一行 + 这里加一个分支。
 */
import type { SettingsCommonProps, SettingsExtraGroup } from '@fizz/agent-kit/features/settings/types'
import { AcpTab } from '@fizz/agent-kit/features/settings/AcpTab'
import { AiPreferencesTab } from '@fizz/agent-kit/features/settings/AiPreferencesTab'
import { AppearanceTab } from '@fizz/agent-kit/features/settings/AppearanceTab'
import { BrowserTab } from '@fizz/agent-kit/features/settings/BrowserTab'
import { ContainerTab } from '@fizz/agent-kit/features/settings/ContainerTab'
import { GeneralTab } from '@fizz/agent-kit/features/settings/GeneralTab'
import { HistoryTab } from '@fizz/agent-kit/features/settings/HistoryTab'
import { McpTab } from '@fizz/agent-kit/features/settings/McpTab'
import { ModelsTab } from '@fizz/agent-kit/features/settings/ModelsTab'
import { PluginsTab } from '@fizz/agent-kit/features/settings/PluginsTab'
import { ShortcutsTab } from '@fizz/agent-kit/features/settings/ShortcutsTab'
import { SkillsTab } from '@fizz/agent-kit/features/settings/SkillsTab'
import { TerminalTab } from '@fizz/agent-kit/features/settings/TerminalTab'
import { UsageTab } from '@fizz/agent-kit/features/settings/UsageTab'

export function SettingsContent({
  tab,
  extraGroups,
  app,
  shortcuts,
  onSaveShortcuts,
  onShortcutRecordingChange
}: SettingsCommonProps & {
  /** 当前选中项；扩展分组的 id 也在这里出现，所以是 string */
  tab: string
  /** 只有手机壳会传（内置项之外的那几项）；动作项没有 content，自然是 undefined */
  extraGroups?: SettingsExtraGroup[]
}) {
  /** 宿主扩展项的内容（手机版的「数据」）；动作项（「退出」）没有内容页 */
  const extraContent = extraGroups
    ?.flatMap((group) => group.items)
    .find((item) => item.id === tab)?.content

  return (
    <>
      {tab === 'general' && <GeneralTab app={app} />}
      {tab === 'history' && <HistoryTab app={app} />}
      {tab === 'appearance' && <AppearanceTab />}
      {tab === 'terminal' && <TerminalTab app={app} />}
      {tab === 'container' && <ContainerTab app={app} />}
      {tab === 'ai-prefs' && <AiPreferencesTab app={app} />}
      {tab === 'models' && <ModelsTab app={app} />}
      {tab === 'acp' && <AcpTab app={app} />}
      {tab === 'skills' && <SkillsTab app={app} />}
      {tab === 'plugins' && <PluginsTab app={app} />}
      {tab === 'mcp' && <McpTab app={app} />}
      {tab === 'browser' && <BrowserTab app={app} />}
      {tab === 'usage' && <UsageTab app={app} />}
      {tab === 'shortcuts' && (
        <ShortcutsTab
          shortcuts={shortcuts}
          onSave={onSaveShortcuts}
          onRecordingChange={onShortcutRecordingChange}
        />
      )}
      {extraContent}
    </>
  )
}
