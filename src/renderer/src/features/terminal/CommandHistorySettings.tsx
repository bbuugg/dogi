import { useMemo, useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { Input, Popconfirm } from 'antd'
import { Trash2, X } from 'lucide-react'

/**
 * 终端命令历史的管理卡片（设置 → 终端）：搜索、单条删除、一键清空。
 * 数据读全局 store 的 commandHistory 镜像（真源在主进程，跨会话共享）；
 * 是否「记录」由上面的偏好开关控制，这里只管已有的历史。
 */
export function CommandHistorySettings() {
  const commandHistory = useAppStore((s) => s.commandHistory)
  const removeCommandHistory = useAppStore((s) => s.removeCommandHistory)
  const clearCommandHistory = useAppStore((s) => s.clearCommandHistory)
  const [keyword, setKeyword] = useState('')

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return commandHistory
    return commandHistory.filter((e) => e.cmd.toLowerCase().includes(kw))
  }, [commandHistory, keyword])

  return (
    <div className="rounded-md">
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm font-medium">命令历史</div>
        <Popconfirm
          title="清空全部命令历史？"
          description={`共 ${commandHistory.length} 条，清空后不可恢复。`}
          okText="清空"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => void clearCommandHistory()}
          disabled={commandHistory.length === 0}
        >
          <button
            type="button"
            disabled={commandHistory.length === 0}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
            清空
          </button>
        </Popconfirm>
      </div>
      <p className="mt-1 mb-2 text-xs leading-4 text-muted-foreground">
        记录你在终端里按回车执行的命令，所有终端会话共享、重启后保留，供命令预测与管理使用。共 {commandHistory.length} 条。
      </p>
      {commandHistory.length > 0 && (
        <Input
          size="small"
          placeholder="搜索命令"
          allowClear
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="mb-2"
        />
      )}
      {commandHistory.length === 0 ? (
        <div className="rounded border border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
          暂无命令历史，在终端里执行命令后会出现在这里。
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto rounded border border-border/60">
          {filtered.map((entry) => (
            <div
              key={entry.cmd}
              className="group flex items-center gap-2 border-b border-border/40 px-2.5 py-1.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={entry.cmd}>
                {entry.cmd}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {formatHistoryTime(entry.ts)}
              </span>
              <button
                type="button"
                aria-label={`删除 ${entry.cmd}`}
                onClick={() => void removeCommandHistory(entry.cmd)}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-destructive group-hover:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              没有匹配「{keyword.trim()}」的命令。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 历史时间展示：当天只看时刻，跨天带日期 */
function formatHistoryTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hm
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
