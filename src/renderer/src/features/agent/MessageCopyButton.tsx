import { useState } from 'react'
import { Tooltip } from 'antd'
import { Check, Copy } from 'lucide-react'
import { cn } from 'cn'

/**
 * 对话消息的复制按钮（Agent 页面与终端 AI 助手浮窗共用）。
 *
 * 只有图标、没有文字 —— 消息下方并排放着复制与删除，带文字太抢眼；
 * 说明放进 tooltip。复制成功用图标变绿勾反馈，不换文案（换文案会改变按钮宽度）。
 *
 * 复制的是**原始文本** —— 助手消息给的是 Markdown 源码而不是渲染后的 DOM 文本，
 * 这样代码块围栏、链接地址等结构都能保留下来。
 *
 * 显隐由外层控制（消息 hover 才出现），这里只管按钮本身。
 */
export function MessageCopyButton({
  text,
  title = '复制',
  className
}: {
  text: string
  /** tooltip 文案（助手消息用它说明复制的是 Markdown 源码） */
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
    <Tooltip title={copied ? '已复制' : title}>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={title}
        className={cn(
          'inline-flex items-center justify-center rounded p-1',
          'text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
          className
        )}
      >
        {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-4" />}
      </button>
    </Tooltip>
  )
}
