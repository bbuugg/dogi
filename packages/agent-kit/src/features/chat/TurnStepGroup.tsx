/**
 * 已完成一轮的「过程折叠条」：把这轮里的思考、工具调用、提问卡收进一个可展开的分组，
 * 默认只露一行摘要（如「思考 ×1 · 工具调用 ×3」），点击展开 / 收起。
 *
 * 样式与思考条的触发行（ReasoningTrigger 的「思考了 N 秒」）同一口径：**纯文字行** ——
 * 无边框 / 底色、无左侧图标、text-muted-foreground 常规字重、箭头贴在文字右侧，
 * 左缘与思考行对齐（消息 parts 流的最左端）。
 *
 * ⚠️ 必须受控 open：Radix Collapsible 的 defaultOpen 只在**挂载时**取一次初值，而
 * 一轮结束时 loadMessages() 会用服务端权威消息覆盖本地流式那份（消息 id 变化 → 子树
 * 重挂载）。受控写法与 PartView 的 ReasoningView / ToolCallCard 保持一致，
 * 展开 / 收起时同样要 holdScroll() 暂停自动贴底，否则视图会被拽走。
 */
import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useConversationOptional } from '@fizz/agent-kit/shared/ai-elements/conversation'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@fizz/ui/collapsible'
import { ASK_FOLLOWUP_TOOL } from '@fizz/agent-kit/shared/lib/parts'
import { t } from '@fizz/i18n'
import type { AgentMessagePart } from '@fizz/contracts/types'

/** 从一批要折叠的 part 里算出折叠条上的摘要文案（如「思考 ×1 · 工具调用 ×3」；英文见 en.ts） */
export function turnStepSummary(parts: AgentMessagePart[]): string {
  let reasoning = 0
  let tools = 0
  let followups = 0
  for (const p of parts) {
    if (p.type === 'reasoning') {
      reasoning++
    } else if (p.type === 'tool-call' || p.type === 'tool-result') {
      if (p.toolName === ASK_FOLLOWUP_TOOL) followups++
      else tools++
    }
  }
  const segments: string[] = []
  if (reasoning) segments.push(t('思考 ×{count}', { count: reasoning }))
  if (tools) segments.push(t('工具调用 ×{count}', { count: tools }))
  if (followups) segments.push(t('提问 ×{count}', { count: followups }))
  return segments.join(' · ') || t('执行过程')
}

export function TurnStepGroup({
  summary,
  children
}: {
  summary: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // 消息区的滚动上下文（可能不在 Conversation 里，拿不到就退化成空操作）
  const conversation = useConversationOptional()

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        conversation?.holdScroll()
        setOpen(next)
      }}
      className="w-full"
    >
      {/* 触发行照抄 ReasoningTrigger 的口径（去掉思考条的脑图标）：`flex w-fit`
          让箭头贴着摘要文字、不铺满整行；hover 整行提亮。
          ⚠️ 必须是 `flex` 而不是 `inline-flex`：行内级盒子会被父级 line-height 撑出
          一个更高的行盒（多出来的留白掉在下方），这条摘要就会比工具条偏上、
          与下一条的间距也偏松 —— 详见 reasoning.tsx 的 ReasoningTrigger。 */}
      <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-2 rounded-md text-left text-muted-foreground text-sm transition-colors hover:text-foreground">
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="flex flex-col gap-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
