import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity } from 'lucide-react'
import { cn } from 'cn'
import { useAppStore } from '@/stores/app-store'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatBytes, formatDuration, formatRate } from '@/lib/format'
import type { ServerMetrics } from '@shared/types'

/** 超过该时长未收到新指标即视为采集已中断，隐藏浮动图标 */
const STALE_MS = 6000

/** 图标与气泡之间的悬停缓冲：鼠标从图标移入气泡所需的宽限时间 */
const CLOSE_DELAY_MS = 120

function barColor(pct: number): string {
  if (pct >= 85) return 'bg-red-500'
  if (pct >= 60) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function textColor(pct: number): string {
  if (pct >= 85) return 'text-red-500'
  if (pct >= 60) return 'text-amber-500'
  return 'text-emerald-500'
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', barColor(pct))}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="text-sm font-medium tabular-nums">{children}</div>
    </div>
  )
}

/** 气泡内的指标详情 */
function MetricsDetail({ metrics }: { metrics: ServerMetrics }) {
  const root = metrics.disk.find((d) => d.mount === '/') ?? metrics.disk[0]
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">服务器指标</span>
        <span className="text-[10px] text-muted-foreground">每 2 秒刷新</span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Stat label="CPU">
          <div className="flex items-baseline gap-1.5">
            <span>{metrics.cpuPercent === null ? '—' : `${metrics.cpuPercent.toFixed(0)}%`}</span>
            <span className="text-[11px] font-normal text-muted-foreground">
              {metrics.cores} 核
            </span>
          </div>
          <div className="mt-1">
            <Bar pct={metrics.cpuPercent ?? 0} />
          </div>
        </Stat>

        <Stat label="内存">
          <div className="flex items-baseline gap-1.5">
            <span>{metrics.memPercent.toFixed(0)}%</span>
            <span className="text-[11px] font-normal text-muted-foreground">
              {formatBytes(metrics.memUsed)}/{formatBytes(metrics.memTotal)}
            </span>
          </div>
          <div className="mt-1">
            <Bar pct={metrics.memPercent} />
          </div>
        </Stat>

        <Stat label="负载">
          <span className="text-[13px]">
            {metrics.load1.toFixed(2)} / {metrics.load5.toFixed(2)} / {metrics.load15.toFixed(2)}
          </span>
          <span className="text-[10px] font-normal text-muted-foreground">1m / 5m / 15m</span>
        </Stat>

        <Stat label="网络">
          <div className="flex flex-col gap-0.5 text-[13px]">
            <span className="text-emerald-500">↓ {formatRate(metrics.netRxRate)}</span>
            <span className="text-sky-500">↑ {formatRate(metrics.netTxRate)}</span>
          </div>
        </Stat>

        <Stat label="磁盘">
          {root ? (
            <>
              <div className="flex items-baseline gap-1.5">
                <span>{root.percent}%</span>
                <span className="text-[11px] font-normal text-muted-foreground">{root.mount}</span>
              </div>
              <div className="mt-1">
                <Bar pct={root.percent} />
              </div>
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Stat>

        <Stat label="运行时长">
          <span className="text-[13px]">{formatDuration(metrics.uptime)}</span>
        </Stat>
      </div>
    </>
  )
}

/**
 * 终端底部的浮动服务器指标图标：
 * - 仅在能采集到当前会话数据时显示（取不到数据或数据已陈旧则完全不渲染）
 * - 鼠标悬停展开气泡（popover）显示详细指标
 */
export function MonitorBadge({ sessionId }: { sessionId: string | null }) {
  const metrics = useAppStore((s) => (sessionId ? s.monitors[sessionId] : undefined))
  const [open, setOpen] = useState(false)
  // 需要按时间重新渲染，才能判断已有指标是否已陈旧
  const [now, setNow] = useState(() => Date.now())
  const closeTimer = useRef<number | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 2000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    },
    []
  )

  // 采不到数据（主机不支持/连接已断开）就不显示
  if (!metrics || now - metrics.timestamp > STALE_MS) return null

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }

  const root = metrics.disk.find((d) => d.mount === '/') ?? metrics.disk[0]
  const worst = Math.max(metrics.cpuPercent ?? 0, metrics.memPercent, root?.percent ?? 0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="服务器指标"
          onPointerEnter={() => {
            cancelClose()
            setOpen(true)
          }}
          onPointerLeave={scheduleClose}
          // 悬停即展开，点击不再切换，避免点击后气泡收起
          onClick={(e) => e.preventDefault()}
          className="absolute right-3 bottom-3 z-20 flex size-8 items-center justify-center rounded-full border border-border/60 bg-card/80 shadow-lg backdrop-blur transition-colors hover:bg-card"
        >
          <Activity className={cn('size-4', textColor(worst))} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-[300px] gap-3 p-3"
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        // 悬停打开时保持终端焦点，避免打断输入
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <MetricsDetail metrics={metrics} />
      </PopoverContent>
    </Popover>
  )
}
