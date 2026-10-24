'use client'

/**
 * 侧栏的**顶部栏**：左边一个名字，右边一组操作。
 *
 * ⚠️ **内置功能区侧栏已经全部不用它了** —— 它现在唯一的消费者是**插件面**
 * （`features/plugins/PluginSurfaceBody`）：那一面的顶栏由插件自己声明（左边插件名、
 * 右边它 `headerActions` 里的按钮），是插件与宿主之间的契约，不是内置功能区的版式。
 *
 * 内置的三个（AI Agent / 主机 / 接口请求）**曾经**都挂着一条：写着各自的面板名
 * （「工作区」/「主机」/「接口请求」），左边塞名字、右边给面板级按钮。它们先后被删掉了，
 * 理由是一样的：
 * - 那行字不携带信息 —— 用户点的是活动栏那颗图标，谁都知道自己在哪个功能区里，
 *   名字只是把图标提示词又抄了一遍；
 * - 它当初的实际用途是给面板级按钮当底座，而那些按钮现在都下移到了各自分区标题栏的
 *   `extra`（操作贴着它所作用的清单，见 `features/hosts/HostsSidebar`、`SidebarScaffold`）；
 * - 它让三条侧栏**顶部对不齐**：带顶栏的从 40px 处开始、不带的从 0 开始，切功能区时
 *   清单会整体上下跳一下。
 *
 * 现在三个侧栏的第一行都是**分区标题**（`SectionHeader`）。
 *
 * ⚠️ **不带图标**：这行是一个文字标签，不是「一个东西 + 它的名字」；加了图标反而让几个侧栏的
 * 顶部重量对不齐。
 *
 * ⚠️ 这里也**不放**「收起侧栏 / 关闭侧栏」按钮。收起 / 展开的入口是**活动栏里那颗当前功能区的
 * 图标**（`ActivityBar` 的 `onClick`：桌面 = 折叠 / 展开侧栏，手机 = 开关抽屉），
 * 手机另有遮罩可点 —— 同一个动作不必在两处渲染。
 *
 * 与 `AppBrand` 的分工：那是**应用**的身份（logo + 名字），只该出现在窗口最顶
 * （desktop 自绘标题栏）；这里是**插件面**的身份。
 */
import type { ReactNode } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function SidebarTopBar({
  label,
  title,
  extra,
  className
}: {
  /** 左侧文字：面板自己的名字（与活动栏那颗图标的提示词一致） */
  label: string
  /** 悬停提示：放 `label` 里没有的信息；不给就用 `label` */
  title?: string
  /**
   * 右侧操作组。**目前三个侧栏都不传** —— 面板级操作（主机的「添加」、插件面的刷新）
   * 都下移到了各自分区的标题栏（`SectionHeader` 的 `extra`）：操作按钮贴着它所作用的
   * 那份清单，比悬在顶栏更近。这里保留插槽以备将来真有「整面板级」的动作。
   */
  extra?: ReactNode
  className?: string
}) {
  return (
    // 间距与原来的 AI Agent 顶栏一致（`px-3 pt-3 pb-1`）：换掉左边内容，不该让整条挪位
    <div className={cn('flex shrink-0 items-center gap-1.5 px-3 pt-3 pb-1 h-8', className)}>
      {/*
        `flex-1` 把 `extra` 推到最右（不再需要 `ml-auto`）；`min-w-0` + `truncate` 兜住长文案，
        别把右侧按钮挤出去 —— 侧栏本来就窄。
      */}
      <span
        className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
        title={title ?? label}
      >
        {label}
      </span>
      {extra ? <div className="flex shrink-0 items-center">{extra}</div> : null}
    </div>
  )
}
