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
import { REVEAL_ON_HOVER_ARROW } from '@fizz/agent-kit/shared/lib/hover-reveal-arrow'
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
        {/*
         * ⚠️ **全部靠左、排成一行**，不要 `w-full` + `ml-auto`：
         * 那样会把「状态徽标 + 折叠箭头」推到行的最右端，和标题隔开一整屏，看起来像
         * 两条互不相干的元素（用户明确要求它们紧跟标题）。这里与工具卡 `ToolHeader`
         * 同一套排法：图标 → 标题 → 状态 → 箭头，`inline-flex` 只占内容宽度。
         */}
        <span className="inline-flex min-w-0 max-w-full items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground">
            {/* 「向内收拢」的图标 = 压缩本身，不再用仪表盘（那是「用量」的语义） */}
            <Minimize2 className="size-3.5" />
            {t('压缩上下文')}
          </span>
          /*
           * 状态指示沿用「图标 + 文案 + secondary 底色」：进行中 = 脉冲时钟，完成 = 绿勾。
           * ⚠️ 工具卡（`ToolHeader`）已改成**只留图标、无底色**，这里没跟着改 —— 压缩卡
           * 出现在正文里、没有工具名和明细挤同一行，那点文案反而有用。
           * 压缩前 / 后 token、摘要条数不再铺在头部（详情看上下文圆环）。
           */
          <Badge
            variant="secondary"
            className="shrink-0 gap-1.5 rounded-full text-xs"
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
          {/* 箭头与思考行 / 工具卡同一口径：平时隐形，悬停整行才浮出来（触屏常显） */}
          <ChevronRight
            className={cn(REVEAL_ON_HOVER_ARROW, 'size-4 shrink-0', open && 'rotate-90')}
          />
        </span>
      </ReasoningTrigger>
      <ReasoningContent>
        {compaction.text || t('等待模型输出…')}
      </ReasoningContent>
    </Reasoning>
  )
}
