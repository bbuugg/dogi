"use client";

/**
 * 全局传输托盘：右下角浮层，列出所有进行中 / 刚结束的 SFTP 上传下载。
 *
 * **为什么是全局的**：传输活得比发起它的组件长 —— 用户把 SFTP 面板关掉、切到别的标签，
 * 传输仍在跑。没有一个常驻的可见入口，那些传输就成了「看不见也停不掉」的后台任务。
 * 所以它挂在应用外壳里（`app-shell.tsx`），数据来自 store 的 `transfer` slice。
 *
 * ⚠️ **不持久化**（见 `slices/transfer.ts` 文件头）：活跃传输绑在进程上，刷新后本来就断了。
 *
 * 定位用 `fixed`：状态栏是视口底部那条 `h-9`，托盘要落在它**上沿再留 8px**。
 * 和抽屉一样，高度取自 `--status-bar-height` token（安卓壳整条不渲染状态栏、把
 * token 覆盖成 `0`），再叠加底部的导航条（`--app-tabbar-height`，目前各端都是 0）
 * 与系统栏安全区 —— `fixed` 不走外壳容器的 padding。
 * 刻意不给外壳容器加 `relative` —— 那会改变里面所有 `absolute` 后代的包含块，
 * 为了一个浮层去动全局布局不划算。
 *
 * ⚠️ **`z-40`，不要往上加**：Radix 的 Dialog / DropdownMenu 是 `z-50`，托盘盖上去会挡住
 * 弹窗（看起来像「弹窗打不开」）。它只是个浮层，不配压在弹窗上面。
 */
import { useState, type ReactNode } from 'react'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eraser,
  FolderOpen,
  Loader2,
  X
} from 'lucide-react'
import type { AgentHost } from '@fizz/agent-client/host'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import type { TransferTask } from '@fizz/agent-kit/shared/lib/stores/slices/transfer'
import { cancelTransfer } from '@fizz/agent-kit/shared/lib/file-transfer/engine'
import { formatBytes, formatRate } from '@fizz/agent-kit/shared/components/monitor-parts'
import { Button } from '@fizz/ui/button'
import { Progress } from '@fizz/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@fizz/ui/tooltip'

/** 图标按钮统一成这一档尺寸：行高与标题行对齐，别各自定 */
const ICON_BUTTON_CLASS = 'size-6 shrink-0'

function TrayIconButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={onClick}
          className={ICON_BUTTON_CLASS}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function TransferRow({ task, host }: { task: TransferTask; host: AgentHost | null }) {
  const percent = task.size > 0 ? Math.min(100, Math.round((task.done / task.size) * 100)) : 0
  /** 总大小未知（远端目录项没给 size）时走不确定态 —— 画一条 0% 的死进度更糟 */
  const indeterminate = task.status === 'active' && task.size <= 0

  const canReveal =
    task.status === 'done' && !!task.localPath && typeof host?.revealInFileManager === 'function'

  return (
    <div className="flex flex-col gap-1.5 border-b px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        {task.kind === 'upload' ? (
          <ArrowUpFromLine className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ArrowDownToLine className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={task.name}>
          {task.name}
        </span>
        {task.status === 'active' && (
          <TrayIconButton label="取消传输" onClick={() => cancelTransfer(task.id)}>
            <X className="size-3.5" />
          </TrayIconButton>
        )}
        {canReveal && (
          <TrayIconButton
            label="在文件管理器中显示"
            onClick={() => {
              void host?.revealInFileManager?.(task.localPath!)
            }}
          >
            <FolderOpen className="size-3.5" />
          </TrayIconButton>
        )}
      </div>

      {indeterminate ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
      ) : (
        <Progress value={task.status === 'active' ? percent : 100} className="h-1.5" />
      )}

      <div className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{task.hostLabel}</span>
        <span className="shrink-0 tabular-nums">{describeRight(task, percent)}</span>
      </div>

      {task.status === 'failed' && task.error && (
        <div className="flex items-start gap-1.5 text-[0.6875rem] text-destructive">
          <AlertCircle className="mt-px size-3 shrink-0" />
          <span className="min-w-0 break-words">{task.error}</span>
        </div>
      )}
    </div>
  )
}

/** 行尾那段：按状态给不同信息，都用 `tabular-nums` 对齐数字 */
function describeRight(task: TransferTask, percent: number): string {
  switch (task.status) {
    case 'active':
      return task.size > 0
        ? `${percent}% · ${formatBytes(task.done)} / ${formatBytes(task.size)}${
            task.speed > 0 ? ` · ${formatRate(task.speed)}` : ''
          }`
        : '传输中…'
    case 'done':
      return `${formatBytes(task.size)} · 已完成`
    case 'canceled':
      return task.size > 0 ? `${formatBytes(task.done)} / ${formatBytes(task.size)} · 已取消` : '已取消'
    case 'failed':
      return task.size > 0 ? `${formatBytes(task.done)} / ${formatBytes(task.size)}` : ''
  }
}

export function TransferTray() {
  const transfers = useAgentStore((s) => s.transfers)
  const clearFinished = useAgentStore((s) => s.clearFinishedTransfers)
  const [collapsed, setCollapsed] = useState(false)

  // 一条都没有时完全不渲染：托盘是「有活干才出现」的东西，常驻一个空壳只会挡视线
  if (transfers.length === 0) return null

  const activeCount = transfers.filter((t) => t.status === 'active').length
  const hasFinished = transfers.some((t) => t.status !== 'active')
  const host = getAgentHostOrNull()

  return (
    <div className="fixed right-3 bottom-[calc(var(--safe-area-inset-bottom,0px)_+_var(--status-bar-height)_+_var(--app-tabbar-height)_+_0.5rem)] z-40 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
      <div className="flex items-center gap-2 px-3 py-1.5">
        {activeCount > 0 ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {activeCount > 0 ? `传输中 ${activeCount} 项` : `传输结束 ${transfers.length} 项`}
        </span>
        {/* 只在真有已结束的行时才给「清空」——否则那颗按钮点下去什么都不会发生 */}
        {hasFinished && (
          <TrayIconButton label="清空已结束" onClick={clearFinished}>
            <Eraser className="size-3.5" />
          </TrayIconButton>
        )}
        <TrayIconButton
          label={collapsed ? '展开传输列表' : '收起传输列表'}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </TrayIconButton>
      </div>

      {!collapsed && (
        <div className={cn('overflow-y-auto', transfers.length > 4 && 'max-h-64')}>
          {transfers.map((task) => (
            <TransferRow key={task.id} task={task} host={host} />
          ))}
        </div>
      )}
    </div>
  )
}
