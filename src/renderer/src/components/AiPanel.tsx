import { AiMarkdown } from '@/components/AiMarkdown'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAppStore } from '@/stores/app-store'
import type { AiMessagePart, AiPermissionMode } from '@shared/types'
import {
  Check,
  Copy,
  Eraser,
  Loader2,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Wrench
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

const TOOL_LABELS: Record<string, string> = {
  run_in_terminal: '执行终端命令',
  read_terminal_output: '读取终端输出',
  list_terminal_sessions: '查看终端列表'
}

const PERMISSION_MODES: Array<{
  value: AiPermissionMode
  label: string
  icon: typeof ShieldCheck
  hint: string
}> = [
    {
      value: 'full',
      label: '完全访问',
      icon: Terminal,
      hint: 'AI 可直接执行终端命令，无需逐条确认'
    },
    {
      value: 'confirm',
      label: '确认模式',
      icon: ShieldCheck,
      hint: 'AI 执行每条终端命令前都需要你确认，可随时取消'
    }
  ]

function ToolPartCard({ part }: { part: AiMessagePart }) {
  const isCall = part.type === 'tool-call'
  const input = isCall ? part.input : null
  const output = part.type === 'tool-result' ? part.output : null
  const toolName =
    part.type === 'tool-call' || part.type === 'tool-result' ? part.toolName : ''
  const label = TOOL_LABELS[toolName] ?? toolName
  const inputText = input ? JSON.stringify(input, null, 1) : ''
  const outputText =
    typeof output === 'string'
      ? output.slice(0, 1500)
      : output
        ? JSON.stringify(output).slice(0, 1500)
        : ''

  return (
    <details className="my-1.5 rounded-md text-xs">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-muted-foreground hover:text-foreground">
        {part.type === 'tool-result' && part.isError ? (
          <span className="text-destructive">✕</span>
        ) : (
          <Wrench className="size-3 shrink-0" />
        )}
        <span className="font-medium">{label}</span>
        {inputText && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
            {inputText.replace(/\s+/g, ' ').slice(0, 80)}
          </span>
        )}
      </summary>
      <div className="border-t border-border/70 px-2 py-1.5">
        {inputText && (
          <pre className="mb-1 overflow-x-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
            {inputText}
          </pre>
        )}
        {outputText && (
          <pre
            className={`max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10px] ${part.type === 'tool-result' && part.isError ? 'text-destructive' : ''
              }`}
          >
            {outputText}
          </pre>
        )}
      </div>
    </details>
  )
}

function MessageBubble({
  role,
  parts,
  streaming
}: {
  role: 'user' | 'assistant'
  parts: AiMessagePart[]
  streaming?: boolean
}) {
  const [copied, setCopied] = useState(false)

  if (role === 'user') {
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-3 py-2 text-[13px] text-primary-foreground">
          {text}
        </div>
      </div>
    )
  }

  // 复制原始 Markdown 文本（跳过工具卡片，文本段之间以空行衔接）
  const copyRaw = async () => {
    const raw = parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n\n')
      .trim()
    if (!raw) return
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 忽略
    }
  }

  const hasText = parts.some((p) => p.type === 'text')

  return (
    <div className="space-y-1">
      {parts.map((part, i) =>
        part.type === 'text' ? (
          <div key={i} className="px-3 py-2">
            <AiMarkdown content={part.text} />
            {streaming && i === parts.length - 1 && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-middle" />
            )}
          </div>
        ) : (
          <ToolPartCard key={i} part={part} />
        )
      )}
      {parts.length === 0 && streaming && (
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> 思考中...
        </div>
      )}
      {/* 消息下方：复制原始 Markdown */}
      {!streaming && hasText && (
        <div className="px-3">
          <button
            type="button"
            onClick={() => void copyRaw()}
            title="复制原文（Markdown）"
            className="inline-flex items-center gap-1 rounded p-1 text-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {copied ? (
              <Check className="size-3 text-green-500" />
            ) : (
              <Copy className="size-3" />
            )}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      )}
    </div>
  )
}

/** 确认模式下的命令执行确认卡片 */
function CommandConfirmCard() {
  const pendingConfirm = useAppStore((s) => s.pendingConfirm)
  const resolveAiConfirm = useAppStore((s) => s.resolveAiConfirm)
  const sessions = useAppStore((s) => s.sessions)

  if (!pendingConfirm) return null
  const target = sessions.find((s) => s.id === pendingConfirm.sessionId)

  return (
    <div className="mx-3 mb-2 rounded-md border border-amber-500/60 bg-amber-500/10 p-2.5 select-text">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        <ShieldCheck className="size-3.5 shrink-0" />
        允许 AI 执行这条命令？
      </div>
      <pre className="mb-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background/70 px-2 py-1.5 font-mono text-[11px] leading-4">
        {pendingConfirm.command}
      </pre>
      <div className="mb-2 truncate text-[10px] text-muted-foreground">
        目标会话：{target?.title ?? pendingConfirm.sessionId ?? '最近活跃会话'}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-7 flex-1 text-xs"
          onClick={() => void resolveAiConfirm(true)}
        >
          执行
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-1 text-xs"
          onClick={() => void resolveAiConfirm(false)}
        >
          取消
        </Button>
      </div>
    </div>
  )
}

export function AiPanel() {
  const messages = useAppStore((s) => s.messages)
  const aiStreaming = useAppStore((s) => s.aiStreaming)
  const aiConfigs = useAppStore((s) => s.aiConfigs)
  const aiSettings = useAppStore((s) => s.aiSettings)
  const aiError = useAppStore((s) => s.aiError)
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const sendAiMessage = useAppStore((s) => s.sendAiMessage)
  const abortAi = useAppStore((s) => s.abortAi)
  const clearAiMessages = useAppStore((s) => s.clearAiMessages)
  const setActiveAiConfig = useAppStore((s) => s.setActiveAiConfig)
  const setAiPermissionMode = useAppStore((s) => s.setAiPermissionMode)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const aiPanelWidth = useAppStore((s) => s.ui.aiPanelWidth)

  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // 是否贴近底部：用户上翻阅读历史时暂停自动跟随，避免被强制拉回底部
  const nearBottomRef = useRef(true)

  const handleListScroll = () => {
    const el = scrollRef.current
    if (!el) return
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  // Chromium 的滚动锚定（scroll anchoring）在流式内容增长/markdown 重排时会错误修正
  // 滚动位置，造成偶发跳顶、干扰手动滚动；容器上已用 overflow-anchor:none 关闭，
  // 由这里显式管理。useLayoutEffect 在绘制前执行，避免「先画到中间再跳到底」的闪动。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, aiStreaming])

  const hasConfig = Boolean(aiSettings.activeConfigId) && aiConfigs.length > 0
  const permissionMode: AiPermissionMode =
    aiSettings.permissionMode === 'confirm' ? 'confirm' : 'full'
  const modeMeta =
    PERMISSION_MODES.find((m) => m.value === permissionMode) ?? PERMISSION_MODES[0]

  const handleSend = () => {
    if (!input.trim() || aiStreaming) return
    // 用户刚发出新消息：无论当前在哪个位置都跟随到底部
    nearBottomRef.current = true
    void sendAiMessage(input)
    setInput('')
  }

  return (
    <aside className="flex shrink-0 flex-col bg-sidebar" style={{ width: aiPanelWidth }}>
      {/* 头部 */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-semibold">AI 助手</span>
        <div className="flex-1" />
        <Select
          value={aiSettings.activeConfigId ?? ''}
          onValueChange={(v) => void setActiveAiConfig(v)}
        >
          <SelectTrigger className="border-none h-7 min-w-0 flex-1 text-xs" title="切换模型">
            <SelectValue placeholder="选择模型" />
          </SelectTrigger>
          <SelectContent>
            {aiConfigs.map((c) => (
              <SelectItem key={c.id} value={c.id} className="text-xs">
                {c.name}（{c.model}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          title="清空对话"
          onClick={clearAiMessages}
        >
          <Eraser className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          title="AI 设置"
          onClick={() => setSettingsOpen(true, 'ai')}
        >
          <Settings2 className="size-3.5" />
        </Button>
      </div>

      {/* 消息区：AI 回复属于「内容」，保持可选中复制 */}
      <div
        ref={scrollRef}
        onScroll={handleListScroll}
        className="min-h-0 flex-1 overflow-y-auto select-text"
        style={{ overflowAnchor: 'none' }}
      >
        <div className="space-y-3 p-3">
          {messages.length === 0 && (
            <div className="mt-16 flex flex-col items-center gap-3 text-center text-muted-foreground">
              <Sparkles className="size-8 text-primary/40" />
              <div className="text-sm">AI 可以帮你操作终端</div>
              <div className="space-y-1 text-xs leading-5">
                <p>试试：查看当前目录下占用空间最大的文件</p>
                <p>试试：诊断 nginx 为什么启动失败</p>
              </div>
              {!hasConfig && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={() => setSettingsOpen(true, 'ai')}
                >
                  先去配置模型
                </Button>
              )}
            </div>
          )}
          {messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              role={msg.role}
              parts={msg.parts}
              streaming={aiStreaming && i === messages.length - 1 && msg.role === 'assistant'}
            />
          ))}
          {aiError && <p className="text-xs text-destructive">{aiError}</p>}
        </div>
      </div>

      {/* 命令确认（确认模式） */}
      <CommandConfirmCard />

      {/* 输入区：圆角卡片，操作按钮集中在卡片底部（对齐 ChatInput 结构） */}
      <div className="shrink-0 p-3">
        <div className="rounded-lg border border-border bg-card transition-colors focus-within:border-primary">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={
              hasConfig ? '描述你想做的事…（Enter 发送，Shift+Enter 换行）' : '请先在设置中配置模型'
            }
            rows={2}
            className="min-h-14 max-h-40 resize-none overflow-y-auto border-0 bg-transparent px-2.5 pt-2.5 text-[13px] shadow-none outline-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 items-center gap-1">
              <Select
                value={permissionMode}
                onValueChange={(v) => void setAiPermissionMode(v as AiPermissionMode)}
              >
                <SelectTrigger
                  className="border-none w-28 shrink-0 gap-1 px-2 text-xs"
                  title="AI 终端执行权限（可实时切换）"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_MODES.map((m) => {
                    const Icon = m.icon
                    return (
                      <SelectItem key={m.value} value={m.value} className="text-xs">
                        <span className="flex items-center gap-1.5">
                          <Icon className="size-3" />
                          {m.label}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            {aiStreaming ? (
              <Button
                size="icon"
                variant="destructive"
                className="size-8 shrink-0 rounded-full"
                title="停止"
                onClick={() => void abortAi()}
              >
                <Square className="size-4" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-8 shrink-0 rounded-full"
                disabled={!input.trim() || !hasConfig}
                title="发送"
                onClick={handleSend}
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="mt-1.5 truncate text-[10px] text-muted-foreground">
          {activeSession
            ? `AI 将操作当前终端：${activeSession.title}`
            : '提示：打开一个终端会话后，AI 才能执行命令'}
          {' · '}
          {modeMeta.hint}
        </div>
      </div>
    </aside>
  )
}
