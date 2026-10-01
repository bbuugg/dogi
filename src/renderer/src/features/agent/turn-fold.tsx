import { ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from 'cn'
import { ASK_FOLLOWUP_TOOL } from '@shared/ask-followup'

/**
 * 已完成的轮次折叠（参考 fishwork 的 TurnStepGroup）。
 *
 * 思路：一轮 assistant 消息**已完成**（不是正在流式的末条）时，把「最终回答之前」的
 * 全部过程（思考 / 工具调用 / 提问卡 / 中途正文）收进**一个**可展开分组，默认只露一行摘要
 * （如「思考 ×1 · 工具调用 ×3」），点击展开 / 收起；最终回答（末尾那段正文）始终可见。
 * ⚠️「末尾不是正文」的回落规则见 `findTailStart` —— **正文绝不能被折进折叠条**。
 *
 * 这与 reasoning / tool 各自的 CollapsibleRow 是两层：每个工具仍是一条可点的横条，而它们整体
 * 再被这一层「过程折叠条」收住，让长轮次的对话流不至于被一堆工具横条淹没。
 *
 * 样式口径与 fishwork 的 TurnStepGroup 一致，也与本目录的 `CollapsibleRow`（思考行 / 工具行）
 * **完全同款**：**纯文字行** —— 无边框、无底色、无左侧图标，常规字重 + text-muted-foreground，
 * hover 只提亮文字（不铺底色），箭头 size-4 贴在摘要文字**右侧**，整行按内容宽度收（w-fit）。
 * 此前这里是个带 `border` + `bg-muted/40` 的方块、箭头还在**左边**、字号 text-xs，三层横条
 * 摆在一起时折叠条像个卡片，与里面的工具行不是一套东西。
 */

/**
 * 折叠组的终点（= 可见尾巴的起点）：它之前的一切收进折叠组。
 *
 * 首选「**末尾连续正文**的起点」—— 那是最终回答，必须整段可见。
 *
 * ⚠️ 但**末尾不是正文时不能把正文一起折进去**（用户报告）：ACP 导入的历史里
 * 「正文说完 → 后面还跟着几步工具调用」很常见（甚至因为工具结果的归属问题被排到正文之后），
 * 只按「末尾连续正文」算，`tailStart` 会等于 `units.length` —— **整条消息（含正文）全被折进
 * 折叠条**，界面上看不到任何输出，却能点到复制按钮（复制出一条你看不见的正文）。
 * 所以退一步：拿**最后一个正文块**当答案的锚点，它之后的工具行留在可见区。
 * 整条消息一个正文块都没有（纯思考 + 工具调用）时折叠全部 —— 那是正常形态，不是 bug。
 */
export function findTailStart(units: { kind: string }[]): number {
  let tailStart = units.length
  while (tailStart > 0 && units[tailStart - 1].kind === 'text') {
    tailStart--
  }
  // 末尾本来就是正文：末尾连续正文全部可见（原行为）
  if (tailStart < units.length) return tailStart
  // 末尾不是正文：回到最后一个正文块，把它（及它之后的工具行）留在外面
  for (let i = units.length - 1; i >= 0; i--) {
    if (units[i].kind === 'text') return i
  }
  return units.length
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
 *
 * ⚠️ 触发行必须是 `flex` 而不是 `inline-flex`：行内级盒子会被父级 line-height 撑出一个更高的
 * 行盒（多出来的留白掉在下方），这条摘要就会比旁边的工具条偏上、与下一条的间距也偏松。
 */
export function TurnFold({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          // w-fit 让箭头贴着摘要文字、不铺满整行；max-w-full 封顶，过长由 truncate 吃掉
          'flex w-fit max-w-full items-center gap-1.5 rounded text-left text-sm',
          'text-muted-foreground transition-colors hover:text-foreground'
        )}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronRight
          className={cn(
            'size-4 shrink-0 opacity-40 transition-transform duration-200',
            open && 'rotate-90'
          )}
        />
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-4 pt-2">{children}</div>
        </div>
      </div>
    </div>
  )
}
