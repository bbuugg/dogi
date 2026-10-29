/**
 * 上下文压缩（compaction 摘要）的折叠块。
 *
 * 与思考 part 共用同一套视觉 / 交互：可展开收起、流式时自动展开、结束后按「自动折叠」
 * 偏好决定是否收起。自动压缩展示在触发压缩的那条助手消息里（见 `MessageParts`）；
 * 手动压缩没有绑定消息，展示在消息列表末尾（见 `MessageList` 的 trailing compaction）。
 * 不是独立的 sticky 横幅。
 *
 * ⚠️ 数据仍来自会话级 `compaction` 展示态，不写进消息 parts：摘要不是对话内容，
 * 刷新后的真源是会话上的 `autoSummary` / `contextSummary`。
 */
import { CheckCircleIcon, ChevronRight, ClockIcon, Minimize2 } from 'lucide-react'
import { Badge } from '@fizz/ui/badge'
import { useEffect, useState } from 'react'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger
} from '@fizz/agent-kit/shared/ai-elements/reasoning'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { autoCollapsesReasoning, useAutoCollapse } from '@fizz/agent-kit/shared/lib/auto-collapse'
import { useConversationOptional } from '@fizz/agent-kit/shared/ai-elements/conversation'
import type { ContextCompactionState } from '@fizz/agent-kit/shared/lib/stores/slices/conversation'

export function ContextCompactionCard({
  compaction
}: {
  compaction: ContextCompactionState
}) {
  const t = useT()
  const streaming = compaction.status === 'streaming'
  const autoCollapse = useAutoCollapse()
  const autoClose = autoCollapsesReasoning(autoCollapse)
  const [open, setOpen] = useState(streaming || !autoClose)
  const conversation = useConversationOptional()

  useEffect(() => {
    if (streaming) setOpen(true)
    else if (autoClose) setOpen(false)
  }, [streaming, autoClose])

  return (
    <Reasoning
      className="w-full"
      isStreaming={streaming}
      open={open}
      defaultOpen={false}
      onOpenChange={(next) => {
        conversation?.holdScroll()
        setOpen(next)
      }}
    >
      <ReasoningTrigger className="w-full">
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground">
            {/* 「向内收拢」的图标 = 压缩本身，不再用仪表盘（那是「用量」的语义） */}
            <Minimize2 className="size-3.5" />
            {t('压缩上下文')}
          </span>
          {/*
           * 与工具卡同一套状态指示（`ToolHeader` 的 Badge）：进行中 = 脉冲时钟，
           * 完成 = 绿勾。压缩前 / 后 token、摘要条数不再铺在头部（详情看上下文圆环）。
           */}
          <Badge
            variant="secondary"
            className="ml-auto shrink-0 gap-1.5 rounded-full text-xs"
          >
            {streaming ? (
              <>
                <ClockIcon className="size-4 animate-pulse" />
                {t('压缩中…')}
              </>
            ) : (
              <>
                <CheckCircleIcon className="size-4 text-green-600 dark:text-green-500" />
                {t('完成')}
              </>
            )}
          </Badge>
          <ChevronRight
            className={cn(
              'size-4 shrink-0 transition-transform',
              open && 'rotate-90'
            )}
          />
        </span>
      </ReasoningTrigger>
      <ReasoningContent>
        {compaction.text || t('等待模型输出…')}
      </ReasoningContent>
    </Reasoning>
  )
}
