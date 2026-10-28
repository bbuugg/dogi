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
import { ChevronRight, Loader2, Minimize2 } from 'lucide-react'
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
      <ReasoningTrigger>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            {/* 「向内收拢」的图标 = 压缩本身，不再用仪表盘（那是「用量」的语义） */}
            <Minimize2 className="size-3.5" />
            {t('压缩上下文')}
          </span>
          {streaming ? (
            // 进行中不重复文案（工具名已经说了在压缩），只把转圈放到行尾
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <>
              {compaction.beforeTokens !== undefined && (
                <span>
                  {t('压缩前 {tokens} token', {
                    tokens: compaction.beforeTokens.toLocaleString()
                  })}
                </span>
              )}
              {compaction.afterTokens !== undefined && (
                <span>
                  {t('→ 压缩后 {tokens} token', {
                    tokens: compaction.afterTokens.toLocaleString()
                  })}
                </span>
              )}
              {compaction.summarizedTurns !== undefined &&
                compaction.keptTurns !== undefined && (
                  <span>
                    {/*
                      ⚠️ 这两个数数的是**消息条数**，不是「轮」。原来写「摘要了 N 轮」，
                      轮中反复压缩时切点前面常常只剩上一条摘要消息 → 永远显示「摘要了 1 轮」，
                      看起来像「前面那么多消息都没处理」。其实它们早就在摘要里了。
                    */}
                    {t('摘要了 {summarized} 条消息，保留 {kept} 条', {
                      summarized: compaction.summarizedTurns,
                      kept: compaction.keptTurns
                    })}
                  </span>
                )}
            </>
          )}
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
