import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** AI 输出 Markdown 渲染（GFM：表格 / 代码块 / 删除线） */
export function AiMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-2 list-disc space-y-1 pl-4 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 list-decimal space-y-1 pl-4 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li>{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 underline underline-offset-2"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => <h1 className="mb-2 text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 text-sm font-medium">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          pre: ({ children }) => (
            <pre
              className="mb-2 overflow-x-auto rounded-md border border-border p-3 text-xs leading-relaxed"
              style={{ backgroundColor: 'var(--code-bg)' }}
            >
              {children}
            </pre>
          ),
          code: ({ children, className }) => {
            const isBlock = /language-/.test(className ?? '') || String(children).includes('\n')
            if (isBlock) {
              return <code className={`${className ?? ''} font-mono`}>{children}</code>
            }
            return (
              <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">
                {children}
              </code>
            )
          },
          table: ({ children }) => (
            <div className="mb-2 overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border bg-secondary px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border/50 px-2 py-1">{children}</td>
          ),
          hr: () => <hr className="my-2 border-border" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
