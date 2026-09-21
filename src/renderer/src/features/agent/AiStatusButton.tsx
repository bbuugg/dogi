import { Sparkles } from 'lucide-react'
import { cn } from 'cn'
import { groupTerminalSessionId, useAppStore } from '@/stores/app-store'
import { STATUS_ITEM_CLASS } from '@/app/layout/StatusBar'

/**
 * 状态栏里的 AI 助手开关（纯图标，不带文字）。
 *
 * AI 助手属于**终端页面**（终端标签 = 一个会话），既不是全局也不是面板组：
 * 这里操作的是当前聚焦组里激活的那个终端标签，切标签就换实例，
 * 每个终端页面各自记住自己的开关（对话状态见 `aiChats`，同样按会话隔离）。
 *
 * 当前激活标签不是终端时（脚本/笔记/接口请求…）没有可绑定的页面，不渲染 ——
 * 即「终端打开后才出现」。放在状态栏而不是标签条上，是因为标签条右侧的空间
 * 要留给标签本身，而状态栏本来就是放「与当前上下文相关」的状态项的地方。
 */
export function AiStatusButton() {
  /** 当前聚焦组激活标签对应的终端会话（非终端时为 undefined） */
  const sessionId = useAppStore((s) => groupTerminalSessionId(s, s.activeGroupId))
  const aiOpen = useAppStore((s) => {
    const sid = groupTerminalSessionId(s, s.activeGroupId)
    return sid ? Boolean(s.ui.aiOpenSessions[sid]) : false
  })
  const setSessionAiOpen = useAppStore((s) => s.setSessionAiOpen)

  if (!sessionId) return null

  return (
    <button
      type="button"
      title={aiOpen ? '隐藏 AI 助手' : '显示 AI 助手'}
      aria-label="AI 助手"
      aria-pressed={aiOpen}
      onClick={() => setSessionAiOpen(sessionId, !aiOpen)}
      className={cn(STATUS_ITEM_CLASS, aiOpen && 'text-primary hover:text-primary')}
    >
      <Sparkles className="size-3.5" />
    </button>
  )
}
