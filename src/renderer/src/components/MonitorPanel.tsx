import { useEffect } from 'react'
import { cn } from 'cn'
import { useAppStore } from '@/stores/app-store'
import { formatBytes, formatDuration, formatRate } from '@/lib/format'

function barColor(pct: number): string {
  if (pct >= 85) return 'bg-red-500'
  if (pct >= 60) return 'bg-amber-500'
  return 'bg-emerald-500'
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

function Stat({
  label,
  children,
  className
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-w-[120px] flex-col gap-1', className)}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="text-sm font-medium tabular-nums">{children}</div>
    </div>
  )
}

export function MonitorPanel({ sessionId }: { sessionId: string }) {
  const metrics = useAppStore((s) => s.monitors[sessionId])

  useEffect(() => {
    void window.api.monitor.start(sessionId)
    return () => {
      void window.api.monitor.stop(sessionId)
    }
  }, [sessionId])

  if (!metrics) {
    return (
      <div className="border-b border-border bg-card/40 px-4 py-3 text-xs text-muted-foreground">
        正在采集服务器指标…
      </div>
    )
  }

  const root = metrics.disk.find((d) => d.mount === '/') ?? metrics.disk[0]

  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b border-border bg-card/40 px-4 py-3">
      <Stat label="CPU">
        <div className="flex items-baseline gap-1.5">
          <span>{metrics.cpuPercent === null ? '—' : `${metrics.cpuPercent.toFixed(0)}%`}</span>
          <span className="text-[11px] font-normal text-muted-foreground">
            {metrics.cores} 核
          </span>
        </div>
        <div className="mt-1 w-28">
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
        <div className="mt-1 w-28">
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
            <div className="mt-1 w-28">
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
  )
}
