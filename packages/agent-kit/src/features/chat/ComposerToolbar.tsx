/**
 * 输入框卡片**上方**的工具条：一排「给这一轮对话装 / 卸能力」的开关。
 *
 * 这一排是「**给这一轮装能力**」的开关，与输入框卡片内 `leading` / `trailing` 那排
 * 「这一轮用什么」的紧凑 pill（工作区 / 权限 / 模型 / 上下文）分开：
 *
 * - **浏览器**：内置的 `browser_*` 工具集（连同系统提示词里那段浏览器说明）。它原本是
 *   设置页「通用 → 浏览器」里的一个开关，挪到这里是为了「想用浏览器时随手就能开」，
 *   不必再钻进设置；设置页那一节已随之移除，**来源偏好**也一并搬到了这颗按钮的下拉里
 *   （否则移除设置就等于把选择来源的能力也删了）。**开关与渠道收进同一个下拉**（见
 *   `BrowserToggle`）：两颗并排时「当前是开着还是关着、用哪个渠道」要靠两个位置的视觉去拼，
 *   且渠道那颗在关闭时还占位，整排 pill 的宽度会随开关跳。触发器**只放一枚地球图标**
 *   （开关状态由图标颜色表达、渠道名进 tooltip 与下拉），与旁边的 MCP 那颗同宽同高。
 * - **MCP**：按会话挑要用哪几个 MCP server（原先挂在 `trailing` 里紧挨模型选择器，
 *   那是「用什么」的 pill，与浏览器分家；同属能力装配，挪到这里与浏览器并排）。
 *
 * 位置对齐由 `ChatComposer` 的 `above` 壳保证（与输入框、消息列同一宽度）。
 *
 * ⚠️ 开关与来源都是**按会话**的（存在会话自己身上，`AgentConversation.browserSettings`）：
 * 每个会话可以各不相同，新建会话以全局默认值为初值。改完**下一轮对话**生效。
 *
 * 与外部 `playwright-mcp` 的同名冲突**不用手动处理**：装配时若这个会话挂了带同名工具的
 * MCP，内置的 `browser_*` 会自动让位（见 `apps/server/src/server/chat-turn.ts`）。
 */
import { DEFAULT_BROWSER_SETTINGS } from '@fizz/contracts'
import { BrowserPicker } from '@fizz/agent-kit/features/chat/BrowserPicker'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import { Globe, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * 工具条容器：横排一排能力开关。
 *
 * 浏览器与 MCP 都是「给这一轮装能力」，语义同族，所以并排放在这里（MCP 原先挂在输入框
 * 右侧 `trailing` 那排 pill 里，紧挨模型选择器 —— 那是「这一轮用什么」的紧凑 pill，
 * 而「挑哪几个 MCP server」是**能力装配**，混进去既挤又与浏览器分家）。
 * `children` 留给后续同类开关（`ChatPanel` 把 `McpSelect` 从原处搬过来放这儿）。
 */
export function ComposerToolbar({ app, children }: { app: AgentApp; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <BrowserToggle app={app} />
      {children}
    </div>
  )
}

/**
 * ACP 会话下的**同高占位**：这一排（浏览器 / MCP）是「给 内置 链路装能力」的开关，
 * 外部 Agent 自带工具、不读这两个字段，所以按钮不能给。
 *
 * 但**不能整行不渲染**：`ChatPanel` 的 `above` 槽位里少了这一行，输入框卡片会往上跳
 * 32px —— 在「开始新对话」页切换「内置模型 ↔ 外部 Agent」时整块输入区上下抖（用户反馈过）。
 * 所以画两颗灰掉、不可点的图标把高度占住，tooltip 说明为什么点不了。
 *
 * 尺寸必须与 `CHAT_ICON_PILL` 对齐（`size-8`），否则占位高度和真工具条差几像素；
 * 这里不复用 `CHAT_ICON_PILL` 是因为它带 hover 变色，灰占位被 hover 染色会像「能点」。
 */
export function ComposerToolbarPlaceholder({ mcp = true }: { mcp?: boolean }) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      title="外部 Agent 自带工具，浏览器 / MCP 开关对它不生效"
      aria-hidden
    >
      <span className="flex size-8 shrink-0 cursor-not-allowed items-center justify-center text-muted-foreground/40">
        <Globe className="size-3.5 shrink-0" />
      </span>
      {/* 与 `McpSelect` 同一条规矩：一个 server 都没配时那颗本来就不出现，占位也跟着不画，
          宽度才和切回内置 agent 时一致 */}
      {mcp && (
        <span className="flex size-8 shrink-0 cursor-not-allowed items-center justify-center text-muted-foreground/40">
          <Wrench className="size-3.5 shrink-0" />
        </span>
      )}
    </div>
  )
}

/**
 * 浏览器开关 + 开启后的来源下拉（**按会话**，见文件头）。
 *
 * 长相与全部交互在 `BrowserPicker`（定时任务表单也用同一颗 —— 浏览器工具跑在服务端，
 * 无人值守的任务一样能用）。这里只负责把 `app` 里的「这个会话的偏好 + 各来源探测
 * 结果」灌进去，并把改动落回会话。
 */
function BrowserToggle({ app }: { app: AgentApp }) {
  return (
    <BrowserPicker
      // `null`（这个会话没设过）= 用全局默认，与界面显示一致
      value={app.browserSettings ?? DEFAULT_BROWSER_SETTINGS}
      detected={app.browserDetected}
      // 乐观更新 + fire-and-forget 持久化到会话，与 MCP 的 `setMcpServerIds` 同一套
      onChange={app.saveBrowserSettings}
    />
  )
}
