'use client'

/**
 * 用本应用打开的一篇**本机 Markdown 文档**（主区域标签的内容）。
 *
 * ## 与「笔记」标签的区别（别把两者合并）
 *
 * | | 笔记（`features/notes`） | 本地文件（这里） |
 * |---|---|---|
 * | 数据通路 | `app.readNoteFile` / `writeNoteFile` → **服务端** API + 登记根 + `resolveInside` | `host.readLocalFile` / `writeLocalFile` → **本机主进程** fs + 路径闸 |
 * | 路径 | 相对某个登记根的 `a/b.md` | 绝对路径 `C:\notes\a.md` |
 * | 默认模式 | 富文本 | **源码**（用户自己的文件多半在 git 里，富文本保存会整篇重排） |
 *
 * 上一轮建笔记时提过一个判断「工作区登记的都是**跑 Agent 那台机器**上的路径」——
 * 这里反过来：这个文件在**用户本机**，服务端可能根本不在同一台机器上。所以两条通路
 * 不能共用一套读写。
 *
 * ## 归属只从登记表读，不从 props 传
 *
 * 标签 key 是不透明的 `file:<n>`（绝对路径不能编进 key，见 `panel-tabs.ts`），
 * 真正的路径记在 `tool-tabs` 的 `ToolTab.externalPath`。与 `NoteTabContent` 同一套。
 * 这里**不需要**订阅登记表的版本：外部文件不会被重命名（改名不是这个功能的一部分）。
 */
import type { ReactElement } from 'react'
import { getToolTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { MarkdownEditor } from '@fizz/agent-kit/shared/components/MarkdownEditor'
import { getAgentHostOrNull } from '@fizz/agent-client/host'

/** 归属丢了 / 宿主不支持时给一句人话，而不是一个空壳页面 */
function Notice({ children }: { children: string }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

export function LocalFileTabContent({
  tabKey,
  active
}: {
  tabKey: string
  /** 是不是正被看着的标签 —— `Ctrl/Cmd+S` 只有它该响应（所有标签常挂载） */
  active: boolean
}): ReactElement {
  const path = getToolTab(tabKey)?.externalPath
  const host = getAgentHostOrNull()

  if (!path) {
    return <Notice>这个标签已经找不到对应的文件，关掉它重新打开即可。</Notice>
  }
  /**
   * 宿主不提供这两个方法 = 跑在没有本机文件系统的地方（web）。
   *
   * 正常情况下走不到这里：「用本应用打开 .md」在 web 上入口直接不出现。留着这一支是
   * 为了宿主能力探测失败时给一句明确的话，而不是让编辑器去 `undefined` 上崩掉。
   */
  if (!host?.readLocalFile || !host.writeLocalFile) {
    return <Notice>当前环境不支持打开本机文件（只有桌面端可以）。</Notice>
  }

  /*
   * 解构出来是为了让 TS 收窄掉「可选方法」—— 上面那两行 if 的收窄**进不了闭包**。
   * 这两个实现都是箭头函数（不依赖 `this`），脱离 host 调用是安全的。
   */
  const { readLocalFile, writeLocalFile } = host

  return (
    <MarkdownEditor
      tabKey={tabKey}
      active={active}
      // 头部显示完整绝对路径：同名文件（一堆 README.md）只看文件名分不清是哪一个
      label={path}
      defaultMode="source"
      load={async () => {
        const result = await readLocalFile(path)
        // 失败要抛出去：编辑器那边会把它显示成一条可重试的错误，而不是「一篇空文档」
        if (!result.ok) throw new Error(result.error)
        return result.content
      }}
      save={async (content) => {
        const result = await writeLocalFile(path, content)
        if (!result.ok) throw new Error(result.error)
      }}
    />
  )
}
