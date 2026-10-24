/**
 * 两个主视图（对话 / 流程）**共用**的那一条顶部工具条。
 *
 * 之前三个视图各手写一份 `h-12`，于是「高度一样、细节全不一样」：流程那条多一条
 * `border-b`、标题是 `text-sm font-semibold px-2`、按钮 `h-8`；任务那条干脆不是一个
 * 工具条（`px-5 py-3` 的标题块 + 工作台自带的第二条 `h-12`）。抽出来之后「顶栏长
 * 什么样」只有这一处定义 —— 改一处，三个视图一起变。
 *
 * 结构固定：**左**是两行（名字 + 名字下面那行次要信息）/ **右**是操作区。
 * 两行是跟根应用（dogi `AgentPage`）学的：名字下面挂分支 / 路径这类
 * 「同一个标题下换了个环境」的信息，比挤在名字右边清楚得多（右边的空间要留给按钮）。
 *
 * ## 手机端顶栏不再有「展开侧栏」按钮
 *
 * 早先最左有一颗 `PanelLeft`（打开侧栏抽屉）。手机上侧栏的入口已经收拢到底部状态栏
 * （「侧栏」直接拉出当前功能区的抽屉、「功能区」开功能区列表）—— 顶栏这颗是第三个
 * 入口，纯冗余，且它把标题往右挤了一格。拆掉之后手机与桌面的顶栏长得一样。
 */
import type { ReactNode } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function ViewHeader({
  title,
  titleHint,
  afterTitle,
  subtitle,
  subtitleHint,
  leading,
  trailing,
  className
}: {
  /** 名字（会被截断，长名字靠 `titleHint` 看全） */
  title: ReactNode
  /** 名字的 hover 提示 */
  titleHint?: string
  /** 紧贴名字右侧的东西（状态徽标 / 连接状态点） */
  afterTitle?: ReactNode
  /**
   * 名字**下面**那一行（分支 / 基线 / 时间…）。不传就只有一行，块本身仍占两行的高度：
   * 三个视图的顶栏高度必须一致，否则切视图时整页会跳一下。
   */
  subtitle?: ReactNode
  /** 第二行的 hover 提示（第二行同样会被截断） */
  subtitleHint?: string
  /** 名字左侧的额外内容 */
  leading?: ReactNode
  /** 右侧操作区 */
  trailing?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex shrink-0 items-start gap-1 p-2 sm:px-3', className)}>
      {leading}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-base font-medium leading-tight" title={titleHint}>
            {title}
          </span>
          {afterTitle}
        </div>
        <div
          className="h-4 flex min-w-0 items-center gap-3 overflow-hidden text-xs leading-tight text-muted-foreground"
          title={subtitleHint}
        >
          {subtitle}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{trailing}</div>
    </header>
  )
}
