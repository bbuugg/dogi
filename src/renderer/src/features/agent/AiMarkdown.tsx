import 'streamdown/styles.css'
import '@/assets/css/streamdown.css'
import { cn } from 'cn'
import { Streamdown } from 'streamdown'
import { code as codePlugin } from '@streamdown/code'
import { math as mathPlugin } from '@streamdown/math'
import { mermaid as mermaidPlugin } from '@streamdown/mermaid'
import { cjk as cjkPlugin } from '@streamdown/cjk'

/**
 * AI 输出 Markdown 渲染。
 * 用 streamdown 替代 react-markdown：对「流式增量输出」更友好（能容错解析未完成的
 * Markdown，例如还在写入的代码块围栏），并内置 GFM、代码高亮（shiki）、LaTeX 公式、
 * Mermaid 图与 CJK 标点优化，开箱带代码/表格的复制、Mermaid 下载等控件。
 */
export function AiMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <Streamdown
      mode="streaming"
      animated={false}
      className={cn('sd-md text-[15px] leading-relaxed break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      shikiTheme={['github-light', 'github-dark']}
      plugins={{
        code: codePlugin,
        math: mathPlugin,
        mermaid: mermaidPlugin,
        cjk: cjkPlugin
      }}
    >
      {content}
    </Streamdown>
  )
}
