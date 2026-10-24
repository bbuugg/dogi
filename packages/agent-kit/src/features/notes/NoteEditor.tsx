'use client'

/**
 * 一篇**笔记**的编辑器 —— `MarkdownEditor` 的瘦包装。
 *
 * 这里只负责「笔记这条数据通路」：`app.readNoteFile` / `writeNoteFile`（走登记根 +
 * `resolveInside`，是**服务端**那台机器上的相对路径）。编辑器的全部交互（双模式、
 * 手动保存、防抖取正文、关闭守卫、脏计数）都在 `shared/components/MarkdownEditor.tsx`。
 *
 * ⚠️ 与「外部文件」标签（`features/local-file`）的差别只有三处：数据通路、`label` 文案、
 * `defaultMode`。**别把两个包装合并** —— 那条走主进程 fs + 绝对路径，跟「服务端登记根」
 * 完全不是一回事（服务端可能根本不在用户这台机器上）。
 *
 * ## `load` / `save` 的引用不稳定是有意的
 *
 * 这里**没有**把它们包成稳定引用：`app` 每次渲染都是新对象（见 `useAgentApp`），包了也
 * 稳不住。真正保证「不重读正文、冲掉未保存修改」的是 `MarkdownEditor` 内部——
 * 它把两个回调放进 ref、只在挂载时读一次。改那边时要一起想清楚。
 */
import type { ReactElement } from 'react'
import { MarkdownEditor } from '@fizz/agent-kit/shared/components/MarkdownEditor'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export function NoteEditor({
  app,
  tabKey,
  rootId,
  path,
  active
}: {
  app: AgentApp
  /** 本标签的 key（关闭守卫与脏计数按它登记） */
  tabKey: string
  /** 所属笔记根的 id */
  rootId: string
  /**
   * 相对所属根的路径。**重命名后会变**（标签被 `retargetNoteTab` 改到新路径）——
   * 编辑器保存时读的是最新值，正文不会因此重读（见文件头）。
   */
  path: string
  /** 是不是正被看着的标签 —— `Ctrl/Cmd+S` 只有它该响应（所有标签常挂载） */
  active: boolean
}): ReactElement {
  return (
    <MarkdownEditor
      tabKey={tabKey}
      active={active}
      label={path}
      // 笔记是**自建**的文件，没有 git diff 洁癖：所见即所得更好用，所以富文本起步
      defaultMode="rich"
      load={async () => (await app.readNoteFile(rootId, path)).content}
      save={async (content) => {
        await app.writeNoteFile(rootId, path, content)
      }}
    />
  )
}
