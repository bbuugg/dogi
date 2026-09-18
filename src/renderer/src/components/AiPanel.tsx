import { AiMarkdown } from '@/components/AiMarkdown'
import { Button, Input, Select } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type {
  AiChatMessage,
  AiConfirmRequest,
  AiMessagePart,
  AiPermissionMode
} from '@shared/types'
import {
  ArrowDown,
  Ban,
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
  X
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

const TOOL_LABELS: Record<string, string> = {
  run_in_terminal: '执行终端命令',
  send_keys: '发送按键',
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

type ToolCallPart = Extract<AiMessagePart, { type: 'tool-call' }>
type ToolResultPart = Extract<AiMessagePart, { type: 'tool-result' }>

/** 工具渲染单元：一次调用及其结果合为一处展示 */
interface ToolUnit {
  kind: 'tool'
  call: ToolCallPart
  result?: ToolResultPart
}

type RenderUnit = ToolUnit | { kind: 'text'; text: string }

/** 把消息 parts 整理为渲染单元：文本独立成块；tool-call 与对应 tool-result 按 toolCallId 合并 */
function buildRenderUnits(parts: AiMessagePart[]): RenderUnit[] {
  const units: RenderUnit[] = []
  const toolsById = new Map<string, ToolUnit>()
  for (const part of parts) {
    if (part.type === 'text') {
      units.push({ kind: 'text', text: part.text })
    } else if (part.type === 'tool-call') {
      const unit: ToolUnit = { kind: 'tool', call: part }
      toolsById.set(part.toolCallId, unit)
      units.push(unit)
    } else if (part.type === 'tool-result') {
      const unit = toolsById.get(part.toolCallId)
      if (unit) {
        unit.result = part
      } else {
        // 无对应调用的孤儿结果：兜底成完整工具单元，保证结果不丢
        units.push({
          kind: 'tool',
          call: {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: null
          },
          result: part
        })
      }
    }
  }
  return units
}

/** 工具调用状态：待批准（确认模式等待用户）/ 调用中 / 已完成 / 失败 / 已取消 */
type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

const TOOL_STATUS_META: Record<
  ToolStatus,
  { label: string; icon: typeof Loader2; cls: string; spin?: boolean }
> = {
  pending: { label: '待批准', icon: ShieldCheck, cls: 'text-amber-500' },
  running: { label: '调用中', icon: Loader2, cls: 'text-muted-foreground', spin: true },
  done: { label: '已完成', icon: Check, cls: 'text-green-500' },
  error: { label: '失败', icon: X, cls: 'text-destructive' },
  cancelled: { label: '已取消', icon: Ban, cls: 'text-muted-foreground' }
}

/** 工具调用卡片：参数与结果同卡展示，头部带状态；待批准时确认按钮就在卡内 */
function ToolPartCard({
  unit,
  streaming,
  pendingConfirm
}: {
  unit: ToolUnit
  streaming: boolean
  pendingConfirm: AiConfirmRequest | null
}) {
  const resolveAiConfirm = useAppStore((s) => s.resolveAiConfirm)
  const { call, result } = unit
  // 本工具对应的待批准确认（确认模式下）
  const confirm = pendingConfirm?.toolCallId === call.toolCallId ? pendingConfirm : null
  const status: ToolStatus = confirm
    ? 'pending'
    : result
      ? result.isError
        ? 'error'
        : 'done'
      : streaming
        ? 'running'
        : 'cancelled'
  const meta = TOOL_STATUS_META[status]
  const StatusIcon = meta.icon
  const label = TOOL_LABELS[call.toolName] ?? call.toolName
  const inputText = call.input ? JSON.stringify(call.input, null, 1) : ''
  const outputText =
    typeof result?.output === 'string'
      ? result.output.slice(0, 1500)
      : result?.output
        ? JSON.stringify(result.output).slice(0, 1500)
        : ''

  return (
    <details className="my-1.5 rounded-md text-xs" open={!!confirm}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-muted-foreground hover:text-foreground">
        <StatusIcon
          className={cn('size-3.5 shrink-0', meta.cls, meta.spin && 'animate-spin')}
        />
        <span className={cn('shrink-0 font-medium', meta.cls)}>{meta.label}</span>
        <span className="shrink-0 text-muted-foreground/50">·</span>
        <span className="shrink-0 font-medium">{label}</span>
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
            className={cn(
              'max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10px]',
              result?.isError && 'text-destructive'
            )}
          >
            {outputText}
          </pre>
        )}
        {confirm && (
          <div className="mt-2 flex gap-2">
            <Button
              size="small"
              type="primary"
              className="h-7 flex-1 text-xs"
              onClick={() => void resolveAiConfirm(confirm.id, true)}
            >
              执行
            </Button>
            <Button
              size="small"
              className="h-7 flex-1 text-xs"
              onClick={() => void resolveAiConfirm(confirm.id, false)}
            >
              取消
            </Button>
          </div>
        )}
      </div>
    </details>
  )
}

function MessageBubble({
  role,
  parts,
  streaming,
  pendingConfirm
}: {
  role: 'user' | 'assistant'
  parts: AiMessagePart[]
  streaming?: boolean
  pendingConfirm: AiConfirmRequest | null
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
  // 工具调用与结果合并成单张卡片展示
  const units = buildRenderUnits(parts)

  return (
    <div className="space-y-1">
      {units.map((unit, i) =>
        unit.kind === 'text' ? (
          <div key={i} className="px-3 py-2">
            <AiMarkdown content={unit.text} />
            {streaming && i === units.length - 1 && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-middle" />
            )}
          </div>
        ) : (
          <ToolPartCard
            key={i}
            unit={unit}
            streaming={!!streaming}
            pendingConfirm={pendingConfirm}
          />
        )
      )}
      {units.length === 0 && streaming && (
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

/** 稳定的空消息数组：避免每次渲染新引用导致滚动 effect 误触发 */
const NO_MESSAGES: AiChatMessage[] = []

/** 终端组内嵌的 AI 助手面板：展示并驱动 sessionId 所属会话的独立对话 */
export function AiPanel({ sessionId }: { sessionId: string | null }) {
  const aiConfigs = useAppStore((s) => s.aiConfigs)
  const aiSettings = useAppStore((s) => s.aiSettings)
  const sessions = useAppStore((s) => s.sessions)
  const activeSession = sessions.find((s) => s.id === sessionId)
  // 每个终端会话一个独立的 AI 对话：面板展示所属会话的上下文
  const chat = useAppStore((s) => (sessionId ? s.aiChats[sessionId] : undefined))
  const messages = chat?.messages ?? NO_MESSAGES
  const aiStreaming = chat?.streaming ?? false
  const aiError = chat?.error ?? null
  // 本会话待批准的确认请求：多实例下各会话独立，显示在对应工具卡内
  const pendingConfirm = useAppStore((s) => {
    for (const c of Object.values(s.pendingConfirms)) {
      if (c.sessionId === sessionId) return c
    }
    return null
  })
  const sendAiMessage = useAppStore((s) => s.sendAiMessage)
  const abortAi = useAppStore((s) => s.abortAi)
  const clearAiMessages = useAppStore((s) => s.clearAiMessages)
  const setActiveAiConfig = useAppStore((s) => s.setActiveAiConfig)
  const setAiPermissionMode = useAppStore((s) => s.setAiPermissionMode)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const aiPanelWidth = useAppStore((s) => s.ui.aiPanelWidth)

  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // 是否跟随底部：用户上翻阅读历史时暂停自动跟随，避免被强制拉回底部
  const nearBottomRef = useRef(true)
  const prevScrollTopRef = useRef(0)
  const [showJump, setShowJump] = useState(false)

  const handleListScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    // 只要发生向上的滚动即视为用户要阅读历史，立即暂停跟随；
    // 滚回底部附近（48px 内）才恢复——避免流式输出和滚动互抢位置
    if (el.scrollTop < prevScrollTopRef.current - 2) {
      nearBottomRef.current = false
    } else if (distance < 48) {
      nearBottomRef.current = true
    }
    prevScrollTopRef.current = el.scrollTop
    setShowJump(distance > 48)
  }

  const jumpToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    nearBottomRef.current = true
    el.scrollTop = el.scrollHeight
    setShowJump(false)
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
    if (!input.trim() || aiStreaming || !sessionId) return
    // 用户刚发出新消息：无论当前在哪个位置都跟随到底部
    nearBottomRef.current = true
    void sendAiMessage(input, sessionId)
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
          size="small"
          variant="borderless"
          className="min-w-0 flex-1"
          value={aiSettings.activeConfigId ?? ''}
          onChange={(v) => void setActiveAiConfig(v)}
          placeholder="选择模型"
          popupMatchSelectWidth={false}
          options={aiConfigs.map((c) => ({ value: c.id, label: `${c.name}（${c.model}）` }))}
        />
        <Button
          type="text"
          size="small"
          className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
          title="清空对话"
          onClick={() => sessionId && clearAiMessages(sessionId)}
        >
          <Eraser className="size-3.5" />
        </Button>
        <Button
          type="text"
          size="small"
          className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
          title="AI 设置"
          onClick={() => setSettingsOpen(true, 'ai')}
        >
          <Settings2 className="size-3.5" />
        </Button>
      </div>

      {/* 消息区：AI 回复属于「内容」，保持可选中复制 */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleListScroll}
          className="h-full overflow-y-auto select-text"
          style={{ overflowAnchor: 'none' }}
        >
        <div className="space-y-3 p-3">
          {messages.length === 0 && (
            <div className="mt-16 flex flex-col items-center gap-3 text-center text-muted-foreground">
              <Sparkles className="size-8 text-primary/40" />
              {activeSession ? (
                <>
                  <div className="text-sm">这个终端拥有独立的 AI 助手</div>
                  <div className="space-y-1 text-xs leading-5">
                    <p>试试：查看当前目录下占用空间最大的文件</p>
                    <p>试试：诊断 nginx 为什么启动失败</p>
                  </div>
                </>
              ) : (
                <div className="space-y-1 text-xs leading-5">
                  <p>打开一个终端会话后开始对话</p>
                  <p>每个终端都有独立、互不影响的 AI 上下文</p>
                </div>
              )}
              {!hasConfig && (
                <Button
                  size="small"
                  variant="filled"
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
              pendingConfirm={pendingConfirm}
            />
          ))}
          {aiError && <p className="text-xs text-destructive">{aiError}</p>}
        </div>
        </div>
        {/* 不在底部时显示：一键滚动到底部 */}
        {showJump && (
          <button
            type="button"
            onClick={jumpToBottom}
            title="滚动到底部"
            className="absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-secondary hover:text-foreground"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
      </div>

      {/* 输入区：圆角卡片，操作按钮集中在卡片底部（对齐 ChatInput 结构） */}
      <div className="shrink-0 p-3">
        <div className="rounded-lg border border-border bg-card transition-colors focus-within:border-primary">
          {/* antd 的 cssinjs 是非 @layer 样式，会压过 Tailwind 的 border-0/outline-none，
              用内联样式强制去掉内层边框与焦点描边，避免与外层圆角卡片形成双边框 */}
          <Input.TextArea
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
            autoSize={{ minRows: 2, maxRows: 6 }}
            className="min-h-14 max-h-40 overflow-y-auto px-2.5 pt-2.5 text-[13px] no-scrollbar"
            variant="borderless"
            style={{ border: 'none', background: 'transparent', boxShadow: 'none', outline: 'none' }}
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 items-center gap-1">
              <Select
                size="small"
                variant="borderless"
                className="w-28 shrink-0"
                value={permissionMode}
                onChange={(v) => void setAiPermissionMode(v as AiPermissionMode)}
                popupMatchSelectWidth={false}
                options={PERMISSION_MODES.map((m) => ({
                  value: m.value,
                  label: (
                    <span className="flex items-center gap-1.5">
                      <m.icon className="size-3" />
                      {m.label}
                    </span>
                  )
                }))}
              />
            </div>
            {aiStreaming ? (
              <Button
                type="text"
                className="size-8 shrink-0 rounded-full text-destructive"
                title="停止"
                onClick={() => sessionId && void abortAi(sessionId)}
              >
                <Square className="size-4" />
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<Send className="size-4" />}
                className="ai-send-btn size-8 shrink-0 rounded-full"
                disabled={!input.trim() || !hasConfig || !sessionId}
                title="发送"
                onClick={handleSend}
              />
            )}
          </div>
        </div>
        <div className="mt-1.5 truncate text-[10px] text-muted-foreground">
          {activeSession
            ? `本对话绑定终端：${activeSession.title}（各终端对话互相独立）`
            : '提示：打开一个终端会话后，AI 才能执行命令'}
          {' · '}
          {modeMeta.hint}
        </div>
      </div>
    </aside>
  )
}
