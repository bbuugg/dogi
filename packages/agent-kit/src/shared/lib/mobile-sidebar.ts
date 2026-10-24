/**
 * 手机形态的**侧栏抽屉开合**（模块级 + 订阅，与 `sidebar-collapsed` 同款），落盘在
 * localStorage，重开保持。
 *
 * ## 为什么只有这一份状态：竖条与侧栏是**一个整体**
 *
 * 手机上「活动栏竖条」和「侧栏抽屉」必须**同进同出**，所以它们**不能各有一份开关** ——
 * 两份状态迟早不同步，而不同步的那个瞬间就是「竖条没了、侧栏还开着」这种半截形态：
 * 手机上只剩一片内容区，用户连自己在哪个功能区都看不出来（用户明确要求过「一起」）。
 *
 * 于是这里**只留抽屉那一份**，竖条在不在由它**派生**（`AppShell` 的
 * `railHidden = isMobile && !mobileSidebarOpen`、`activity-sidebar.tsx` 的左边内缩）——
 * 「派生出两个地方」不是「两份状态」：它们读的是同一个值，不存在写回不同步的可能。
 *
 * ⚠️ 早先还并存过 `activityBarHidden`（竖条自己那份偏好），已删。两个开关、两个键、
 * 两条内缩分支，正是这个坑的来源 —— **别再加回来**。
 *
 * ## 展开时是**占位**的，不是浮层
 *
 * 早先手机侧栏是「点一下 → 从左边滑出一层 `fixed` 浮层 + 半透明遮罩」（`MobileActivityRail`）。
 * 用户明确反馈不要浮层：要它像桌面那样在页面左侧**占位**、把内容挤过去。所以现在只有两种
 * 状态 —— **在**（参与横向 flex 布局）或 **不在**（完全不渲染，见 `AppShell`）。
 *
 * ## 默认展开
 *
 * 早先按形态给过「手机默认收起」，现在**默认展开**：竖条与侧栏是一个整体，首屏就只剩
 * 内容区反而费事（要展开得先按那颗顶栏按钮）。老用户落盘的那份仍然生效。
 *
 * 只在手机形态生效（`AppShell` 里判 `isMobile`）：桌面 / web 的侧栏走 `sidebar-collapsed`
 * 那一套，这个偏好对它们无效 —— 否则「拖窄窗口」会把桌面布局也一起改掉。
 */
import { useSyncExternalStore } from 'react'

const KEY = 'fizz.agent.mobileSidebarOpen'

const listeners = new Set<() => void>()

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

let open = readStored() === '1'

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getMobileSidebarOpen(): boolean {
  return open
}

/** 开 / 关抽屉（落盘）。竖条在不在由它派生 —— 别再引入第二个开关。 */
export function setMobileSidebarOpen(next: boolean): void {
  if (next === open) return
  open = next
  try {
    localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
    // 存不进去就只保留本次会话（与 usePersistedNumber 一致）
  }
  emit()
}

export function useMobileSidebarOpen(): boolean {
  return useSyncExternalStore(subscribe, getMobileSidebarOpen, () => false)
}
