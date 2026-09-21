import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from 'cn'

/**
 * 对话消息底部的复制按钮（Agent 页面与终端 AI 助手浮窗共用）。
 *
 * 复制的是**原始文本** —— 助手消息给的是 Markdown 源码而不是渲染后的 DOM 文本，
 * 这样代码块围栏、链接地址等结构都能保留下来。
 *
 * 按钮自身标了 `select-none`：消息区开放了文本选中（见 index.css 的全局
 * `user-select: none` 与各消息区的 `select-text`），不标的话拖选消息时
 * 会把按钮上的「复制」两个字一起选进去。
 */
export function MessageCopyButton({
  text,
  label = '复制',
  title = '复制',
  className
}: {
  text: string
  /** 未复制状态下显示的文字 */
  label?: string
  title?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!text.trim()) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板被拒（窗口失焦等）：静默忽略，不打断对话
    }
  }

  // 没有文本可复制的消息（纯工具调用等）不显示按钮
  if (!text.trim()) return null

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded p-1 text-[10px] select-none',
        'text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
        className
      )}
    >
      {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
      {copied ? '已复制' : label}
    </button>
  )
}
