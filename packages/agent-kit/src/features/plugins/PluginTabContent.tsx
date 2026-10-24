"use client";

/**
 * 插件界面在主视图区里的**标签页内容**。
 *
 * 与侧栏共用 `PluginSurfaceBody`（取数 / 渲染 / 动作都是同一套），这里只负责
 * 「从标签 key 反查是哪个插件的哪个面 + 它是什么参数开的」。
 *
 * ⚠️ 内容**常挂载**（非活动标签由内容层 `hidden` 藏而不卸，见 `PanelView` 的说明），
 * 所以别在这里做「切换标签就重来一遍」的事 —— 插件面里的状态留在内存里更好。
 */
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { getToolTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { PluginSurfaceBody } from '@fizz/agent-kit/features/plugins/PluginSurfaceBody'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function PluginTabContent({ tabKey }: { tabKey: string }) {
  const t = useT()
  const { app } = useAppContext()
  const tool = getToolTab(tabKey)

  // 登记表里没有它 = 标签与数据不同步（理论上不该发生，见 PanelView 里的同款兜底）
  if (!tool?.pluginId || !tool.surfaceId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t('这个标签的数据已失效，关闭后重新打开即可。')}
      </div>
    )
  }

  return (
    <PluginSurfaceBody
      app={app}
      pluginId={tool.pluginId}
      kind="view"
      id={tool.surfaceId}
      // 参数：同一个面可以用它开出多屏（一个连接一页）
      {...(tool.params ? { params: tool.params } : {})}
      className="h-full"
    />
  )
}
