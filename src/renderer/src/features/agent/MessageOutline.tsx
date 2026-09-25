/**
 * 消息目录：消息区**右侧**（消息列内部）那条竖着的分段条，一条用户消息 = 一段。
 *
 * 形态参考「分段下载进度条」竖过来：整条由若干短段叠成，段高随条数自适应，
 * 鼠标悬停某段时那一段变高、其余段被挤矮（整条总高不变），点击滚到那条消息。
 *
 * 移植自 FishWork（`packages/agent-ui/src/components/MessageOutline.tsx`），仅做了
 * 宿主适配：消息类型换成 dogi 的 `AgentChatMessage`；hover 预览改用 antd `Tooltip`。
 *
 * 几个刻意的选择：
 * - **只收用户消息**（assistant 一条轮次里会拆成思考 / 工具 / 正文好几段，全列出来是噪音）；
 * - 段高用 **flex 分配**而不是写死 px：容器高度固定，每段 `grow basis-0`，
 *   悬停那段 `hover:grow-2` —— 总空间不变，一段变高必然挤压其他段，
 *   而且 `flex-grow` 本身可过渡，动画不用 JS 逐帧算（也就不需要 hover 时 re-render）；
 * - 段与段的视觉间隙用**每段自己的上下 padding**做，不用容器 `gap`：
 *   padding 在段盒子里 → 连间隙一起算可点区域（几 px 的段否则很难点中）；
 * - **定位在消息列内部、贴右缘**：壳与消息列（同 `max-w-3xl`）对齐，竖条 `justify-end` 靠右内边缘。
 *   消息本身是 `max-w-[85%]`，右侧天然空出空间，竖条正好落在这个空档里，不压正文；
 * - **预览气泡开在左侧**（`placement="left"`）：竖条已贴消息列右缘，再往右会顶出面板；
 * - 滚动用 `scrollIntoView` + `scroll-mt-*`，不自己算偏移 —— 消息高度是流式的，算不准。
 */
import { useMemo } from 'react'
import { Tooltip } from 'antd'
import type { AgentChatMessage } from '@shared/types'

/** 整条竖条的目标最高高度（px）：够长，但不至于顶满整屏 */
const TOTAL_MAX = 300
/** 单段最舒服的高度 / 压到不能再压的高度（px） */
const SEG_MAX = 3
const SEG_MIN = 2
/** 每段上下各留多少 padding（= 段间视觉间隙的一半）：舒服档 / 挤压档 */
const PAD_MAX = 2
const PAD_MIN = 0.5

/**
 * 按条数挑一档「段高 + 上下 padding」。
 * 优先保住 5px 段高（条数少时观感最好），条数多了先压段高、再压间隙。
 * 返回的是**每段的基准高度**；总高 = count × (seg + 2×pad)。
 */
function plan(count: number): { seg: number; pad: number } {
  for (const pad of [PAD_MAX, 1, PAD_MIN]) {
    const seg = Math.floor(TOTAL_MAX / count) - 2 * pad
    if (seg >= SEG_MAX) return { seg: SEG_MAX, pad }
    if (seg >= SEG_MIN) return { seg, pad }
  }
  return { seg: SEG_MIN, pad: PAD_MIN }
}

/** 取用户消息里的纯文本（空正文也保留一段，保证目录与实际轮次对应） */
function textOfMessage(message: AgentChatMessage): string {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
}

export function MessageOutline({
  messages,
  onJump
}: {
  messages: AgentChatMessage[]
  /** 点某段：把那条消息滚到可视区顶部（由 AgentPage 实现跳转） */
  onJump: (messageId: string) => void
}) {
  const items = useMemo(
    () =>
      messages
        .filter((message) => message.role === 'user')
        .map((message, index) => ({
          id: message.id,
          index,
          // 空正文（只发了图之类）也给一段，不然「目录」和实际轮次对不上
          text: textOfMessage(message) || '（这条消息没有文字）'
        })),
    [messages]
  )

  // 只有一条时没什么可跳的，整条不出现
  if (items.length < 2) return null

  const { seg, pad } = plan(items.length)
  const total = items.length * (seg + 2 * pad)

  return (
    <div className="pointer-events-none absolute inset-y-0 left-1/2 z-10 hidden w-full max-w-3xl -translate-x-1/2 items-center justify-end px-4 md:flex">
      <div className="pointer-events-auto flex w-6 max-h-full flex-col" style={{ height: total }}>
        {items.map((item) => (
          <Tooltip
            key={item.id}
            placement="left"
            mouseEnterDelay={0.15}
            title={
              <div className="text-left text-pretty">
                <div className="text-xs opacity-60">第 {item.index + 1} 条提问</div>
                <div className="mt-0.5 line-clamp-6 leading-5 whitespace-pre-wrap break-words">
                  {item.text}
                </div>
              </div>
            }
          >
            <button
              type="button"
              aria-label={`跳到第 ${item.index + 1} 条提问：${item.text.slice(0, 60)}`}
              onClick={() => onJump(item.id)}
              // grow + basis-0 + min-h-0：高度完全由容器分配决定，容器被 max-h 压扁时
              // 所有段等比变矮，不会溢出、也不需要滚动条
              className="group/seg flex min-h-0 grow basis-0 cursor-pointer flex-col transition-[flex-grow] duration-200 ease-out hover:grow-2"
              style={{ paddingTop: pad, paddingBottom: pad }}
            >
              <span className="w-full flex-1 rounded-[2px] bg-foreground/10 transition-colors group-hover/seg:bg-foreground/35" />
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}
