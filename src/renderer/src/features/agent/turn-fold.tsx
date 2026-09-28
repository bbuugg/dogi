import { ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from 'cn'
import { ASK_FOLLOWUP_TOOL } from '@shared/ask-followup'

/**
 * 已完成的轮次折叠（参考 fishwork 的 TurnStepGroup）。
 *
 * 思路：一轮 assistant 消息**已完成**（不是正在流式的末条）时，把「末尾连续正文之前」的
 * 全部过程（思考 / 工具调用 / 提问卡 / 中途正文）收进**一个**可展开分组，默认只露一行摘要
 * （如「思考 ×1 · 工具调用 ×3」），点击展开 / 收起；末尾连续的正文（最终回答）始终可见。
 *
 * 这与 reasoning / tool 各自的 CollapsibleRow 是两层：每个工具仍是一条可点的横条，而它们整体
 * 再被这一层「过程折叠条」收住，让长轮次的对话流不至于被一堆工具横条淹没。
 */

/** 末尾连续正文块的起点：它之前的一切收进折叠组 */
export function findTailStart(units: { kind: string }[]): number {
  let tailStart = units.length
  while (tailStart > 0 && units[tailStart - 1].kind === 'text') {
    tailStart--
  }
  return tailStart
}

/** 折叠条摘要：思考 ×N · 工具调用 ×N · 提问 ×N */
export function turnStepSummary(
  units: { kind: string; call?: { toolName?: string } }[]
): string {
  let reasoning = 0
  let tools = 0
  let followups = 0
  for (const u of units) {
    if (u.kind === 'reasoning') reasoning++
    else if (u.kind === 'tool') {
      if (u.call?.toolName === ASK_FOLLOWUP_TOOL) followups++
      else tools++
    }
  }
  const segments: string[] = []
  if (reasoning) segments.push(`思考 ×${reasoning}`)
  if (tools) segments.push(`工具调用 ×${tools}`)
  if (followups) segments.push(`提问 ×${followups}`)
  return segments.join(' · ') || '执行过程'
}

/**
 * 过程折叠条：默认收起，点击展开 / 收起。
 *
 * 受控 open 默认 false（dogi 没有 fishwork 那种 loadMessages 覆盖导致的子树重挂载问题，
 * 但保持受控更稳）。展开体用 grid-rows 0fr/1fr 做高度过渡，外层 overflow-hidden 兜住收起态。
 * 不额外处理滚动：dogi 的尾部跟随只在用户贴底时生效，展开时若已贴底就继续贴底，符合预期。
 */
export function TurnFold({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2.5 py-1.5 text-left',
          'text-xs text-muted-foreground transition-colors hover:bg-muted/70'
        )}
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-200',
            open && 'rotate-90'
          )}
        />
        <span className="min-w-0 truncate">{summary}</span>
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-5 py-2 pl-1">{children}</div>
        </div>
      </div>
    </div>
  )
}
