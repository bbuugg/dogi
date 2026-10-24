/**
 * Markdown 文件预览：把工作区里的 `.md` 渲染成和聊天正文**同一套**样子。
 *
 * 共用 `lib/streamdown.ts` 的 `useStreamdownOptions()` —— 代码高亮主题 / 表格 / mermaid / cjk
 * 与 `MessageResponse`（正文）、`ReasoningContent`（思考）完全一致，不会出现「文件里的代码块
 * 和聊天里的代码块两个配色」。外壳带 `sd-md`：`styles.css` 里「代码块 / 表格收敛」那组覆盖
 * 的作用域锚点（拆卡片、单层描边、13px）。
 *
 * 图片走 Streamdown 默认渲染之外的 `MarkdownImage`（可放大 + 悬浮下载），它已被
 * `useStreamdownOptions().components.img` 接管，这里不用再配。
 */
import { Streamdown } from 'streamdown'
import { useStreamdownOptions } from '@fizz/agent-kit/shared/lib/streamdown'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function FileMarkdownPreview({
  markdown,
  className
}: {
  markdown: string
  className?: string
}) {
  const streamdownOptions = useStreamdownOptions()
  return (
    <div className={cn('px-4 py-3', className)}>
      <Streamdown
        className="sd-md [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        {...streamdownOptions}
      >
        {markdown}
      </Streamdown>
    </div>
  )
}
