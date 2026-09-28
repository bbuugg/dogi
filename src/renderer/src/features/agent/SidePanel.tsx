import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Tooltip } from 'antd'
import { X } from 'lucide-react'
import { ResizeHandle } from '@/shared/components/ResizeHandle'
import { cn } from 'cn'

/**
 * Agent 页右侧的**通用多标签面板**。
 *
 * 面板本身不认识任何具体内容，只负责：宽度（可拖）、展开/收起动画、标签条、
 * 活动标签切换 —— 浏览器（`BrowserPane`）与终端（`TerminalView`）都只是挂上来的
 * 一个标签，以后再加别的视图（日志、文件预览…）不必改这个组件。
 *
 * 三条硬约束（都是踩出来的）：
 * 1. **标签内容一律常挂载**，非活动的用 `hidden` 藏起来：浏览器标签卸载重挂等于重新
 *    接一次帧流（黑屏一下），终端卸载则 xterm 重建、会话输出全丢（`terminal:data` 无回放）。
 * 2. **内容区宽度固定、外层只裁剪**（宽度 0 ↔ 目标宽 + `overflow-hidden`）：动画期间
 *    内容不重排，面板是像抽屉一样被「拉出来」；跟着压扁会让内容一路重排（浏览器画面
 *    尤其明显，帧在不停重新缩放）。
 * 3. 拖动期间不加宽度过渡：过渡追不上指针的即时宽度，右侧会露出一条空白。
 * 4. **宽度过渡只服务于「抽屉动作」**（展开 / 收起），随**容器尺寸**变化的那一次不做过渡：
 *    那是「跟着容器走」，有动画就像被挤了一下。切会话标签时最明显 —— 被 `display:none`
 *    藏起来的页面量到的容器宽度是 0，重新露出来才量到真实值，带过渡就会看到面板先短一截、
 *    再挤着长回去。判断方式见下面的 `containerChanged`。
 */
export interface SidePanelTab {
  /** 唯一 key，同时作为「活动标签」的标识 */
  key: string
  /** 标签条上的短名 */
  label: string
  /** 悬停提示：放更完整的描述（如 `终端 · /path/to/ws`） */
  title: string
  icon: ReactNode
  /** 标签内容（常挂载；自己能撑满高度即可） */
  content: ReactNode
  /** 关闭该标签；不传则不显示关闭按钮 */
  onClose?: () => void
}

/**
 * 面板尺寸约束：默认占容器 40%（对话区略宽）。
 *
 * ⚠️ `MIN_CONVERSATION_WIDTH` 同时是**面板拖拽的上限**（`maxWidth = 容器 - 它`）——
 * 它只用来兜住「别把对话区挤没」，所以调小它 = 面板能拖得更宽、对话区能被压得更窄。
 * 340 是「气泡还能正常折行」的实用下限，别再无脑往下调。
 */
const SIDE_PANEL_RATIO = 0.4
const SIDE_PANEL_MIN_WIDTH = 340
const MIN_CONVERSATION_WIDTH = 340

interface SidePanelProps {
  /** 是否展开：收起只把宽度裁到 0，标签内容全部保留 */
  open: boolean
  tabs: SidePanelTab[]
  /** 活动标签 key（应能在 tabs 里找到；展开时才有意义） */
  activeKey: string | null
  onSelect: (key: string) => void
  /** 收起面板（不关任何标签） */
  onCollapse: () => void
  /** 内容区实测宽度：算默认宽度与拖拽上限（保证对话区不被挤没） */
  containerWidth: number
  className?: string
}

export function SidePanel({
  open,
  tabs,
  activeKey,
  onSelect,
  onCollapse,
  containerWidth,
  className
}: SidePanelProps): React.ReactElement {
  /** 用户拖过的宽度；null = 还没拖过，按容器比例算（60/40，对话区略宽） */
  const [userWidth, setUserWidth] = useState<number | null>(null)
  /** 正在拖动：拖动期间关掉宽度过渡（见文件头约束 3） */
  const [dragging, setDragging] = useState(false)
  /**
   * 撑满模式：**每次展开都先撑到上限**（= 把左侧对话区压到最小宽度）。
   *
   * 面板是「看内容」的地方，展开时先给足宽度才不憋屈；一旦用户拖过就交回他，
   * 不再自动撑满（拖窄了再收起展开，也尊重他拖出来的宽度）。用布尔而不是
   * 一次性把 `userWidth` 设成 maxWidth：这样窗口变大时宽度跟着长，不会卡在旧上限。
   */
  const [maximized, setMaximized] = useState(false)
  const wasOpenRef = useRef(open)

  useEffect(() => {
    if (open && !wasOpenRef.current) setMaximized(true)
    wasOpenRef.current = open
  }, [open])

  /**
   * 上一次渲染时的容器宽度。ref **只在 effect 里推进**（渲染期不写 ref —— 那样在
   * StrictMode 的双渲染下第二次会算出不一样的结果），于是「本次提交容器宽度变了吗」
   * 在两次渲染里答案一致。
   *
   * `containerChanged` 为真 = 这次的宽度变化是**跟着容器走**的，不做过渡（见文件头约束 4）。
   */
  const prevContainerRef = useRef(containerWidth)
  const containerChanged = prevContainerRef.current !== containerWidth
  useEffect(() => {
    prevContainerRef.current = containerWidth
  }, [containerWidth])

  const effectiveContainer = containerWidth > 0 ? containerWidth : 1200
  const maxWidth = Math.max(SIDE_PANEL_MIN_WIDTH, effectiveContainer - MIN_CONVERSATION_WIDTH)
  const width = maximized
    ? maxWidth
    : Math.round(
        Math.min(
          maxWidth,
          Math.max(SIDE_PANEL_MIN_WIDTH, userWidth ?? effectiveContainer * SIDE_PANEL_RATIO)
        )
      )

  /** 用户拖宽度 = 他要自己说了算：退出撑满模式 */
  const handleResize = (next: number): void => {
    setMaximized(false)
    setUserWidth(next)
  }

  return (
    <>
      {/* 面板在拖拽条**右侧**：往左拖才是把它拉宽。收起时不渲染，免得留一条无用的抓手 */}
      {open && (
        <ResizeHandle
          orientation="x"
          width={width}
          min={SIDE_PANEL_MIN_WIDTH}
          max={maxWidth}
          onResize={handleResize}
          onDragStart={() => setDragging(true)}
          onDragEnd={() => setDragging(false)}
          invert
        />
      )}
      <div
        aria-hidden={!open}
        className={cn(
          'shrink-0 overflow-hidden',
          // 过渡只在「抽屉动作」上播放：展开 / 收起平滑，随容器尺寸变化的那一次直接跟上
          !dragging && !containerChanged && 'transition-[width] duration-200 ease-out',
          !open && 'pointer-events-none',
          className
        )}
        style={{ width: open ? width : 0 }}
      >
        <div
          style={{ width }}
          className="flex h-full flex-col border-l border-border/70 bg-background"
        >
          {/* 标签条：左边是各标签（图标 + 短名 + 悬停出现的关闭），右边是收起面板。
              标签要能一眼看清、点得准 —— 高度 9、字号 13px、内边距给足 */}
          <div className="flex h-9 shrink-0 items-center gap-1 px-2">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {tabs.map((tab) => {
                const active = tab.key === activeKey
                return (
                  <div
                    key={tab.key}
                    className={cn(
                      'group/tab flex min-w-0 items-center rounded-md pr-1 transition-colors',
                      active
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/60'
                    )}
                  >
                    <button
                      type="button"
                      title={tab.title}
                      aria-pressed={active}
                      onClick={() => onSelect(tab.key)}
                      className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-[13px]"
                    >
                      <span className="shrink-0">{tab.icon}</span>
                      <span className="truncate">{tab.label}</span>
                    </button>
                    {tab.onClose && (
                      <button
                        type="button"
                        title={`关闭${tab.label}`}
                        aria-label={`关闭${tab.label}`}
                        onClick={tab.onClose}
                        className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover/tab:opacity-100"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <Tooltip title="收起面板（不关标签）">
              <Button
                type="text"
                size="small"
                className="shrink-0 px-1.5 text-muted-foreground"
                icon={<X className="size-4" />}
                onClick={onCollapse}
              />
            </Tooltip>
          </div>
          {/* 内容区：所有标签都挂在这里，非活动的藏起来但**不卸载**（见文件头约束 1）。
              overflow-hidden 兜住标签内部的高度溢出，别让内容把面板撑出容器 */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {tabs.map((tab) => (
              <div key={tab.key} className={cn('h-full', tab.key !== activeKey && 'hidden')}>
                {tab.content}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
