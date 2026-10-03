import { useMemo, useState } from 'react'
import { FolderOpen, RefreshCw, ScrollText, Trash2 } from 'lucide-react'
import { Button, Input, Popconfirm, Segmented, Tag, Tooltip, message } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type { HostLogEntry, HostLogLevel, HostLogScope } from '@shared/types'

/** 级别展示元数据：状态点颜色 + 文本颜色 */
const LEVEL_META: Record<HostLogLevel, { dot: string; text: string; label: string }> = {
  info: { dot: 'bg-sky-500', text: '', label: '信息' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-500', label: '警告' },
  error: { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-500', label: '错误' }
}

/** 作用域展示元数据：行内标签文本 + antd Tag 颜色 */
const SCOPE_META: Record<HostLogScope, { label: string; color: string }> = {
  ssh: { label: 'SSH', color: 'blue' },
  terminal: { label: '终端', color: 'green' },
  tunnel: { label: '隧道', color: 'purple' },
  sftp: { label: 'SFTP', color: 'cyan' },
  rdp: { label: 'RDP', color: 'orange' },
  app: { label: '应用', color: 'geekblue' }
}

type ScopeFilter = 'all' | HostLogScope

const SCOPE_OPTIONS: Array<{ label: string; value: ScopeFilter }> = [
  { label: '全部', value: 'all' },
  { label: 'SSH', value: 'ssh' },
  { label: '终端', value: 'terminal' },
  { label: '隧道', value: 'tunnel' },
  { label: 'SFTP', value: 'sftp' },
  { label: 'RDP', value: 'rdp' },
  { label: '应用', value: 'app' }
]

/** 单条日志：时间（悬停看完整日期）+ 级别点 + 作用域标签 + 正文；有 detail 时补一行等宽详情 */
function LogRow({ entry }: { entry: HostLogEntry }) {
  const meta = LEVEL_META[entry.level]
  const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })
  const full = new Date(entry.ts).toLocaleString('zh-CN', { hour12: false })
  return (
    <div
      className="rounded px-2 py-1 transition-colors hover:bg-sidebar-accent/50"
      data-log-scope={entry.scope}
      data-log-level={entry.level}
    >
      <div className="flex items-baseline gap-2 text-xs">
        <span
          className={cn('size-1.5 shrink-0 self-center rounded-full', meta.dot)}
          title={meta.label}
        />
        <Tooltip title={full}>
          <span className="shrink-0 font-mono text-muted-foreground/70">{time}</span>
        </Tooltip>
        <Tag color={SCOPE_META[entry.scope].color} className="m-0 shrink-0">
          {SCOPE_META[entry.scope].label}
        </Tag>
        <span className={cn('min-w-0 flex-1 break-all whitespace-pre-wrap', meta.text)}>
          {entry.message}
        </span>
      </div>
      {entry.detail && (
        <pre className="mt-1 ml-12 rounded bg-muted/50 p-1.5 font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
          {entry.detail}
        </pre>
      )}
    </div>
  )
}

/**
 * 「主机日志」页（主区域单例标签）：SSH 连接 / 终端命令 / 隧道 / SFTP 等主机相关事件记录。
 *
 * 记录在主进程产生（services/log/logger.ts），内存环形缓冲上限 1000 条 + JSONL 落盘
 * （userData/logs/host.log，跨重启保留）；本页只读，倒序展示（最新在最上），
 * 支持按作用域过滤 / 关键字搜索 / 清空 / 打开日志目录。
 *
 * 终端命令条目（scope: 'terminal'）由 services/terminal/recording.ts 产生：
 * 一条命令一条记录，输出以同 seq 增量回填（本页表现为条目就地长出 detail）。
 */
export function HostLogsPanel() {
  const hostLogs = useAppStore((s) => s.hostLogs)
  const refreshHostLogs = useAppStore((s) => s.refreshHostLogs)
  const clearHostLogs = useAppStore((s) => s.clearHostLogs)

  const [scope, setScope] = useState<ScopeFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const errorCount = hostLogs.filter((e) => e.level === 'error').length

  /** 倒序（最新在前）+ 过滤：数据量上限 1000，直接全量换算即可 */
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return hostLogs
      .filter((e) => scope === 'all' || e.scope === scope)
      .filter((e) => !kw || e.message.toLowerCase().includes(kw))
      .slice()
      .reverse()
  }, [hostLogs, scope, keyword])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshHostLogs()
    } finally {
      setRefreshing(false)
    }
  }

  const reveal = async (): Promise<void> => {
    const r = await window.api.logs.reveal()
    if (!r.ok) message.error(r.error ?? '打开日志目录失败')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具条 */}
      <div className="flex items-center justify-between px-5 py-3">
        <div>
          <h1 className="text-base font-semibold">主机日志</h1>
          <p className="text-xs text-muted-foreground">
            共 {hostLogs.length} 条 · 错误 {errorCount} 条 ·{' '}
            SSH 连接 / 终端命令 / 隧道 / SFTP 的最近事件（重启后保留，更早的看落盘文件）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="text"
            icon={<RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            刷新
          </Button>
          <Button type="text" icon={<FolderOpen className="size-4" />} onClick={() => void reveal()}>
            打开目录
          </Button>
          <Popconfirm
            title="清空主机日志？"
            description="内存、落盘日志与终端会话原始记录都会被清空，且不可恢复"
            okText="清空"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void clearHostLogs()}
          >
            <Button type="text" danger icon={<Trash2 className="size-4" />}>
              清空
            </Button>
          </Popconfirm>
        </div>
      </div>

      {/* 过滤行 */}
      <div className="flex items-center gap-2 px-5 pb-3">
        <Segmented
          value={scope}
          onChange={(v) => setScope(v as ScopeFilter)}
          options={SCOPE_OPTIONS}
        />
        <Input
          allowClear
          placeholder="搜索日志…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="max-w-[240px]"
        />
      </div>

      {/* 日志列表（倒序：最新在最上，不用管自动滚动） */}
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-6">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <ScrollText className="size-12 opacity-30" />
            <div className="text-sm">{hostLogs.length === 0 ? '还没有日志' : '没有匹配的日志'}</div>
            <div className="text-xs text-muted-foreground/70">
              连接主机、在终端执行命令、启动隧道、打开 SFTP 时产生的事件都会记录在这里
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((e) => (
              <LogRow key={e.seq} entry={e} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
