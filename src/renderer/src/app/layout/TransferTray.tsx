import { useEffect, useMemo } from 'react'
import { ArrowRightLeft, Copy, Download, ListX, Upload, X } from 'lucide-react'
import { Badge, Button, Popover, Progress, Tooltip } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { STATUS_ITEM_CLASS } from '@/app/layout/StatusBar'
import type { SftpTransferProgress } from '@shared/types'

/** 传输类型 → 图标 / 中文标签 */
function kindMeta(kind: SftpTransferProgress['kind']): { icon: typeof Upload; label: string } {
  switch (kind) {
    case 'upload':
      return { icon: Upload, label: '上传' }
    case 'download':
      return { icon: Download, label: '下载' }
    case 'copy':
      return { icon: Copy, label: '复制' }
    case 'move':
      return { icon: ArrowRightLeft, label: '移动' }
  }
}

function formatSize(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 状态栏右下角的「传输任务」入口 + 任务面板。
 *
 * 所有 SFTP 传输（上传 / 下载 / 文件夹下载 / 复制 / 移动）的进度都汇聚到全局 store 的
 * transfers，这里统一展示并支持多任务并发、逐条取消、清除已完成。
 *
 * 组件常驻挂载（保持进度订阅生效），但仅当有传输任务（含刚结束、尚未自动移除的）时
 * 才在状态栏显示入口；任务全部清空后入口自动消失。
 */
export function TransferTray() {
  const transfers = useAppStore((s) => s.transfers)
  const open = useAppStore((s) => s.transferTrayOpen)
  const setOpen = useAppStore((s) => s.setTransferTrayOpen)
  const removeTransfer = useAppStore((s) => s.removeTransfer)
  const clearFinished = useAppStore((s) => s.clearFinishedTransfers)

  // 全局唯一订阅：把主进程广播的 sftp:progress 收进 store，供本面板统一展示。
  // 因为状态栏常驻，这里订阅一次即可覆盖所有 SFTP 标签的传输。
  useEffect(() => {
    const off = window.api.sftp.onProgress((p) => {
      useAppStore.getState().upsertTransfer(p)
    })
    return off
  }, [])

  const list = useMemo(() => Object.values(transfers), [transfers])
  const activeCount = list.filter((t) => !t.done && !t.error).length
  const finishedCount = list.length - activeCount

  const panel = (
    <div className="flex w-80 flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-medium text-foreground">
          传输任务{activeCount > 0 ? `（${activeCount} 进行中）` : ''}
        </span>
        <Button
          type="text"
          size="small"
          className="h-6 px-1 text-xs text-muted-foreground hover:text-foreground"
          icon={<ListX className="size-3.5" />}
          disabled={finishedCount === 0}
          onClick={clearFinished}
        >
          清除已完成
        </Button>
      </div>
      {list.length === 0 ? (
        <div className="px-1 py-6 text-center text-xs text-muted-foreground">暂无传输任务</div>
      ) : (
        <div className="flex max-h-80 flex-col gap-2 overflow-auto pr-1">
          {list.map((t) => {
            const { icon: Icon, label } = kindMeta(t.kind)
            const finished = t.done || Boolean(t.error)
            return (
              <div
                key={t.transferId}
                className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs text-foreground" title={t.name}>
                      {t.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
                  </div>
                  {t.error ? (
                    <span className="mt-0.5 block truncate text-xs text-destructive">
                      失败：{t.error}
                    </span>
                  ) : (
                    <div className="mt-0.5 flex items-center gap-2">
                      {t.total > 0 && (
                        <Progress
                          className="min-w-0 flex-1"
                          size="small"
                          percent={Math.min(100, Math.round((t.bytes / t.total) * 100))}
                          status={t.done ? 'success' : 'active'}
                          showInfo={false}
                        />
                      )}
                      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                        {t.done
                          ? '（完成）'
                          : `${formatSize(t.speed)}/s${t.total === 0 ? ` · ${formatSize(t.bytes)}` : ''}`}
                      </span>
                    </div>
                  )}
                </div>
                {!finished && (
                  <Tooltip title="取消该传输">
                    <Button
                      type="text"
                      size="small"
                      className="h-5 w-5 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                      icon={<X className="size-3.5" />}
                      onClick={() => void window.api.sftp.abortTransfer(t.transferId)}
                    />
                  </Tooltip>
                )}
                {finished && (
                  <Button
                    type="text"
                    size="small"
                    className="h-5 w-5 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                    title="移除"
                    icon={<X className="size-3.5" />}
                    onClick={() => removeTransfer(t.transferId)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  // 没有传输任务时不占状态栏入口（组件仍常驻挂载，进度订阅保持生效，
  // 一旦有新任务 list 变非空，入口立刻出现）
  if (list.length === 0) return null

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topRight"
      arrow={false}
      styles={{ content: { padding: 8 } }}
      content={panel}
    >
      <Button type="text" className={STATUS_ITEM_CLASS} title="传输任务">
        <Badge count={activeCount} size="small" offset={[-2, 2]}>
          <Upload className="size-3.5" />
        </Badge>
        <span>传输</span>
        {finishedCount > 0 && activeCount === 0 && (
          <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50" title="有已完成的任务" />
        )}
      </Button>
    </Popover>
  )
}
