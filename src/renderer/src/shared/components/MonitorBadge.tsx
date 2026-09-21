import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Cpu, MemoryStick, X } from 'lucide-react'
import { cn } from 'cn'
import { useAppStore } from '@/stores/app-store'
import { Popover } from 'antd'
import { formatBytes, formatDuration, formatRate } from '@/lib/format'
import type { ServerMetrics } from '@shared/types'

/** 可选的采集间隔（毫秒），由左/右箭头在两者间切换 */
const INTERVAL_OPTIONS = [200, 500, 1000, 2000, 5000]

/** 采集间隔缺省值（非法持久化值的回退项） */
const DEFAULT_INTERVAL = 2000

/** 数据陈旧判定下限（毫秒）：实际阈值为 max(该值, 采集间隔 × 3)，间隔越长容忍越久 */
const STALE_MS = 6000

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

function intervalLabel(ms: number): string {
  return ms < 1000 ? `${ms} 毫秒` : `${ms / 1000} 秒`
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

/** 刷新间隔切换：左右箭头在选项间循环，中间显示当前间隔 */
function IntervalStepper() {
  const interval = useAppStore((s) => s.preferences.monitorInterval)
  const setMonitorInterval = useAppStore((s) => s.setMonitorInterval)
  const exact = INTERVAL_OPTIONS.indexOf(interval)
  const current = exact >= 0 ? exact : INTERVAL_OPTIONS.indexOf(DEFAULT_INTERVAL)

  // 左箭头 = 更短的间隔（刷新更快），右箭头 = 更长的间隔
  const step = (delta: number): void => {
    const next = (current + delta + INTERVAL_OPTIONS.length) % INTERVAL_OPTIONS.length
    void setMonitorInterval(INTERVAL_OPTIONS[next])
  }

  const arrow = 'flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground'

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border/60 px-0.5 py-px">
      <button type="button" aria-label="刷新更快" className={arrow} onClick={() => step(-1)}>
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="w-14 text-center text-[11px] tabular-nums text-muted-foreground">
        {intervalLabel(INTERVAL_OPTIONS[current])}
      </span>
      <button type="button" aria-label="刷新更慢" className={arrow} onClick={() => step(1)}>
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  )
}

/** 气泡内的指标详情 */
function MetricsDetail({
  metrics,
  intervalMs,
  onClose
}: {
  metrics: ServerMetrics
  intervalMs: number
  onClose: () => void
}) {
  const root = metrics.disk.find((d) => d.mount === '/') ?? metrics.disk[0]
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">服务器指标</span>
        <div className="ml-auto">
          <IntervalStepper />
        </div>
        <button
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={onClose}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* 距下次采集的进度：每次收到新数据重新开始（key 变化触发动画重放） */}
      <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div
          key={metrics.timestamp}
          className="h-full rounded-full bg-primary/60"
          style={{ animation: `monitor-tick ${intervalMs}ms linear forwards` }}
        />
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
          <div className="text-[10px] font-normal text-muted-foreground">1m / 5m / 15m</div>
          <div className="text-[13px]">
            {metrics.load1.toFixed(2)} / {metrics.load5.toFixed(2)} / {metrics.load15.toFixed(2)}
          </div>
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
 * 状态栏中的服务器指标条（渲染在 StatusBar 内）：
 * - 常显 CPU / 内存 / 网速概览，仅在能采集到当前会话数据时出现（数据陈旧则消失）
 * - 点击指标条在上方展开详情气泡：只能通过气泡内的关闭按钮收起
 *   （点击外部 / ESC 均不关闭）；气泡内可切换采集间隔
 */
export function MonitorBadge({ sessionId }: { sessionId: string | null }) {
  const metrics = useAppStore((s) => (sessionId ? s.monitors[sessionId] : undefined))
  const interval = useAppStore((s) => s.preferences.monitorInterval)
  const [open, setOpen] = useState(false)
  // 需要按时间重新渲染，才能判断已有指标是否已陈旧
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // 采不到数据（主机不支持/连接已断开）就不显示；间隔越长，陈旧阈值越宽松
  const staleAfter = Math.max(STALE_MS, interval * 3)
  const visible = !!metrics && now - metrics.timestamp <= staleAfter

  // 数据消失时顺手收起气泡，避免数据恢复后气泡莫名自动弹出
  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])

  if (!visible || !metrics) return null

  return (
    <Popover
      open={open}
      // 仅允许打开：点击外部 / ESC 触发的关闭请求一律忽略，只有气泡内的关闭按钮能收起
      onOpenChange={(next) => {
        if (next) setOpen(true)
      }}
      trigger="click"
      placement="topLeft"
      arrow={false}
      destroyOnHidden
      styles={{ content: { padding: 0 } }}
      content={
        <div className="w-[300px]">
          <MetricsDetail metrics={metrics} intervalMs={interval} onClose={() => setOpen(false)} />
        </div>
      }
    >
      <button
        type="button"
        aria-label="服务器指标详情"
        title="服务器指标"
        className="flex h-6 items-center gap-3 rounded px-1.5 text-[11px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
      >
        <span
          className={cn(
            'flex items-center gap-1 font-medium tabular-nums',
            textColor(metrics.cpuPercent ?? 0)
          )}
        >
          <Cpu className="size-3" />
          {metrics.cpuPercent === null ? '—' : `${metrics.cpuPercent.toFixed(0)}%`}
        </span>
        <span
          className={cn(
            'flex items-center gap-1 font-medium tabular-nums',
            textColor(metrics.memPercent)
          )}
        >
          <MemoryStick className="size-3" />
          {metrics.memPercent.toFixed(0)}%
        </span>
        <span className="flex items-center gap-1 tabular-nums text-emerald-500">
          <ArrowDown className="size-3" />
          {formatRate(metrics.netRxRate)}
        </span>
        <span className="flex items-center gap-1 tabular-nums text-sky-500">
          <ArrowUp className="size-3" />
          {formatRate(metrics.netTxRate)}
        </span>
      </button>
    </Popover>
  )
}
