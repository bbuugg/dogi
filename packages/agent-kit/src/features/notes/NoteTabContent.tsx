'use client'

/**
 * 笔记标签的内容：从登记表取「哪个根 + 哪篇」，交给 `NoteEditor`。
 *
 * ## 为什么要 `useSyncExternalStore`
 *
 * 标签 key 是**不透明的** `note:<n>`，真正的归属记在 `tool-tabs` 的登记表里（见那张表
 * 文件头「为什么这里比别的标签多一套版本订阅」）。表被**就地改**的时候（重命名 →
 * `retargetNoteTab`）`panel-store` 没有变化、不会重渲染，所以这里订阅登记表的版本号，
 * 改完重新读一遍 —— 否则用户重命名一篇正开着的笔记后，界面还停在旧路径上，
 * 下一次「保存」会**按旧路径凭空长出一个文件**。
 *
 * 其余工具标签没有这个问题：它们的归属要么在 key 里（`host:<id>`），要么建好之后不再变。
 */
import { useSyncExternalStore, type ReactElement } from 'react'
import {
  getToolTab,
  getToolTabsVersion,
  subscribeToolTabs
} from '@fizz/agent-kit/shared/lib/tool-tabs'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { NoteEditor } from '@fizz/agent-kit/features/notes/NoteEditor'

export function NoteTabContent({
  tabKey,
  active
}: {
  tabKey: string
  /** 这个标签此刻是不是正被看着 —— `Ctrl/Cmd+S` 只有它该响应（所有标签常挂载） */
  active: boolean
}): ReactElement {
  const { app } = useAppContext()
  useSyncExternalStore(subscribeToolTabs, getToolTabsVersion, getToolTabsVersion)
  const tool = getToolTab(tabKey)

  // 登记表里没有 / 字段不全：与「主机被删」同一套处理，给一句明确的话而不是空壳页面。
  if (!tool?.noteRootId || !tool.notePath) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        这篇笔记已不在笔记树里，关闭标签后重新打开即可。
      </div>
    )
  }

  return (
    <NoteEditor
      app={app}
      tabKey={tabKey}
      rootId={tool.noteRootId}
      path={tool.notePath}
      active={active}
    />
  )
}
