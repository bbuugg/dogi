import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRightLeft,
  ArrowUp,
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  Upload
} from 'lucide-react'
import { Button, Dropdown, Input, Modal, Spin, message, type MenuProps } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import { joinSftpPath, normalizeSftpPath } from '@shared/sftp-path'
import type { SftpEntry } from '@shared/types'

/** 字节数的可读展示 */
function formatSize(n: number): string {
  if (!n) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 远端时间戳 → 本地可读时间 */
function formatTime(ts: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString()
}

/**
 * SFTP 文件管理页（主区域标签）：浏览远程主机文件系统。
 *
 * 一个标签 = 一个到主机的 SFTP 连接（connId 页面生成，卸载时关闭）；
 * 凭据复用主机配置（主进程按 profileId 解密），渲染端不接触密码。
 * 支持进入目录 / 返回上级 / 跳转路径 / 刷新 / 新建文件夹 / 上传（多选并发）/
 * 下载（文件 / 整个文件夹）/ 复制 / 移动（跨目录）/ 重命名 / 删除（目录递归）。
 * 所有传输进度汇聚到全局 store（见 TransferTray），在状态栏右下角统一展示。
 */
export function SftpPage({ profileId }: { profileId: string }) {
  const profile = useAppStore((s) => s.profiles.find((p) => p.id === profileId))

  /** 连接 id：一个标签一个连接，页面卸载时关闭 */
  const [connId] = useState(
    () => `sftp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  )
  const [path, setPath] = useState('/')
  const [pathInput, setPathInput] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [connecting, setConnecting] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 新建文件夹 / 重命名 / 删除确认的弹窗状态 */
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const [renaming, setRenaming] = useState<SftpEntry | null>(null)
  const [renameText, setRenameText] = useState('')
  const [pendingRemove, setPendingRemove] = useState<SftpEntry | null>(null)
  /** 复制 / 移动的目标目录弹窗状态（entry + 模式）；目标路径 = targetDir + entry.name */
  const [targetOp, setTargetOp] = useState<{ entry: SftpEntry; mode: 'move' | 'copy' } | null>(null)
  const [targetDir, setTargetDir] = useState('')

  /** 挂载/卸载标记：防止异步回包写到已卸载的组件上（还得多关一次连接） */
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      void window.api.sftp.close(connId)
    }
  }, [connId])

  const load = useCallback(
    async (dir: string) => {
      setLoading(true)
      setError(null)
      try {
        const list = await window.api.sftp.list(connId, dir)
        if (!aliveRef.current) return
        setEntries(list)
        setPath(dir)
        setPathInput(dir)
      } catch (e) {
        if (!aliveRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (aliveRef.current) setLoading(false)
      }
    },
    [connId]
  )

  // 建连 + 初始列目录
  useEffect(() => {
    setConnecting(true)
    ;(async () => {
      try {
        await window.api.sftp.open(connId, profileId)
        if (!aliveRef.current) {
          void window.api.sftp.close(connId)
          return
        }
        setConnecting(false)
        await load('/')
      } catch (e) {
        if (!aliveRef.current) return
        setConnecting(false)
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [connId, profileId, load])

  // 连接断开（进度已改为全局订阅，由 TransferTray 收进 store，这里只管本连接的错误提示）
  useEffect(() => {
    const offClosed = window.api.sftp.onClosed((p) => {
      if (p.connId === connId && aliveRef.current) setError('连接已断开，请关闭标签后重新打开')
    })
    return () => {
      offClosed()
    }
  }, [connId])

  /** 进入目录（仅目录）；文件无操作 */
  const enter = (entry: SftpEntry): void => {
    if (entry.isDir && !error) void load(entry.path)
  }

  const goUp = (): void => {
    if (path === '/' || error) return
    const idx = path.lastIndexOf('/')
    void load(idx <= 0 ? '/' : path.slice(0, idx))
  }

  const submitPath = (): void => {
    // 归一化：`data`、`//data`、`/data/` 都走同一个入口（主进程侧还会再归一一次兜底）
    const target = normalizeSftpPath(pathInput)
    if (target !== path && !error) void load(target)
  }

  const refresh = (): void => {
    if (!error) void load(path)
  }

  const submitMkdir = async (): Promise<void> => {
    const name = mkdirName.trim()
    if (!name) return
    try {
      await window.api.sftp.mkdir(connId, joinSftpPath(path, name))
      setMkdirOpen(false)
      setMkdirName('')
      message.success('已创建文件夹')
      void load(path)
    } catch (e) {
      message.error('创建失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const submitRename = async (): Promise<void> => {
    const entry = renaming
    const name = renameText.trim()
    if (!entry || !name || name === entry.name) {
      setRenaming(null)
      return
    }
    try {
      const parent = entry.path.slice(0, entry.path.lastIndexOf('/'))
      await window.api.sftp.rename(connId, entry.path, joinSftpPath(parent, name))
      setRenaming(null)
      void load(path)
    } catch (e) {
      message.error('重命名失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const confirmRemove = async (): Promise<void> => {
    const entry = pendingRemove
    if (!entry) return
    setPendingRemove(null)
    try {
      await window.api.sftp.remove(connId, entry.path)
      message.success(`已删除「${entry.name}」`)
      void load(path)
    } catch (e) {
      message.error('删除失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const download = (entry: SftpEntry): void => {
    void (async () => {
      try {
        const result = await window.api.sftp.download(connId, entry.path, entry.name)
        if (result.ok) message.success(`已下载到 ${result.savedPath}`)
        else if (!result.canceled) message.error('下载失败：' + (result.error ?? ''))
      } catch (e) {
        message.error('下载失败：' + (e instanceof Error ? e.message : String(e)))
      }
    })()
  }

  /** 递归下载整个文件夹（目录内每个文件各算一笔传输，进度见状态栏右下角） */
  const downloadDir = (entry: SftpEntry): void => {
    void (async () => {
      try {
        const result = await window.api.sftp.downloadDir(connId, entry.path, entry.name)
        if (result.ok) message.success(`已开始下载文件夹「${entry.name}」，进度见右下角状态栏`)
        else if (!result.canceled) message.error('下载失败：' + (result.error ?? ''))
      } catch (e) {
        message.error('下载失败：' + (e instanceof Error ? e.message : String(e)))
      }
    })()
  }

  /** 打开「复制 / 移动到…」弹窗，目标目录默认当前目录 */
  const openTargetOp = (entry: SftpEntry, mode: 'move' | 'copy'): void => {
    setTargetDir(path)
    setTargetOp({ entry, mode })
  }

  /** 确认复制 / 移动：to = targetDir + entry.name（与移动/复制同名的文件会被覆盖） */
  const submitTargetOp = async (): Promise<void> => {
    const op = targetOp
    if (!op) return
    const dir = targetDir.trim()
    if (!dir) return
    setTargetOp(null)
    const to = joinSftpPath(dir, op.entry.name)
    try {
      const result =
        op.mode === 'move'
          ? await window.api.sftp.move(connId, op.entry.path, to)
          : await window.api.sftp.copy(connId, op.entry.path, to)
      // 用户手动取消（进度条上的取消按钮）：不打扰、也不报错
      if (result.canceled) return
      message.success(`${op.mode === 'move' ? '已移动' : '已复制'}「${op.entry.name}」到 ${dir}`)
      void load(path)
    } catch (e) {
      message.error(
        `${op.mode === 'move' ? '移动' : '复制'}失败：` + (e instanceof Error ? e.message : String(e))
      )
    }
  }

  const upload = (): void => {
    void (async () => {
      try {
        const result = await window.api.sftp.upload(connId, path)
        if (result.ok) {
          message.success(`已上传 ${result.count} 个文件`)
          void load(path)
        } else if (result.canceled) {
          // 用户在进度条上点了取消（也可能只是关掉了文件选择框）——不算失败
          if (result.count) message.info(`已取消上传，本次完成 ${result.count} 个文件`)
          void load(path)
        } else {
          message.error('上传失败：' + (result.error ?? ''))
        }
      } catch (e) {
        message.error('上传失败：' + (e instanceof Error ? e.message : String(e)))
      }
    })()
  }

  const rowMenu = (entry: SftpEntry): MenuProps => ({
    items: [
      ...(entry.isDir
        ? [
            { key: 'open', icon: <Folder className="size-3.5" />, label: '打开' },
            { key: 'downloadDir', icon: <Download className="size-3.5" />, label: '下载文件夹' }
          ]
        : [{ key: 'download', icon: <Download className="size-3.5" />, label: '下载' }]),
      { key: 'copy', icon: <Copy className="size-3.5" />, label: '复制到…' },
      { key: 'move', icon: <ArrowRightLeft className="size-3.5" />, label: '移动到…' },
      { key: 'rename', icon: <Pencil className="size-3.5" />, label: '重命名' },
      { type: 'divider' as const },
      { key: 'delete', icon: <Trash2 className="size-3.5" />, label: '删除', danger: true }
    ],
    onClick: ({ key }) => {
      if (key === 'open') enter(entry)
      else if (key === 'download') download(entry)
      else if (key === 'downloadDir') downloadDir(entry)
      else if (key === 'copy') openTargetOp(entry, 'copy')
      else if (key === 'move') openTargetOp(entry, 'move')
      else if (key === 'rename') {
        setRenaming(entry)
        setRenameText(entry.name)
      } else if (key === 'delete') setPendingRemove(entry)
    }
  })

  const title = profile ? `${profile.name}（${profile.username}@${profile.host}）` : 'SFTP'

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* 工具栏：返回上级 + 路径 + 刷新 / 新建文件夹 / 上传 */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="shrink-0 text-xs font-medium text-muted-foreground" title={title}>
          {title}
        </span>
        <Button
          type="text"
          className="shrink-0"
          title="返回上级目录"
          icon={<ArrowUp className="size-4" />}
          disabled={path === '/' || Boolean(error)}
          onClick={goUp}
        />
        <Input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onPressEnter={submitPath}
          placeholder="远程路径，如 /var/www"
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          type="text"
          className="shrink-0"
          title="刷新"
          icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />}
          disabled={connecting || Boolean(error)}
          onClick={refresh}
        />
        <Button
          type="text"
          className="shrink-0"
          title="新建文件夹"
          icon={<FolderPlus className="size-4" />}
          disabled={connecting || Boolean(error)}
          onClick={() => {
            setMkdirName('')
            setMkdirOpen(true)
          }}
        />
        <Button
          className="shrink-0 gap-1.5"
          icon={<Upload className="size-3.5" />}
          disabled={connecting || Boolean(error)}
          onClick={upload}
        >
          上传
        </Button>
      </div>

      {/* 文件列表 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {connecting ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spin />
            正在连接 {profile?.username}@{profile?.host}:{profile?.port || 22}…
          </div>
        ) : error ? (
          <div className="mx-4 mt-10 rounded-md border border-dashed border-destructive/40 px-4 py-6 text-center text-sm text-destructive">
            {error}
          </div>
        ) : (
          <>
            {/* 表头 */}
            <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border/60 bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground">
              <span className="min-w-0 flex-1">名称</span>
              <span className="w-24 shrink-0 text-right">大小</span>
              <span className="w-44 shrink-0">修改时间</span>
              <span className="w-10 shrink-0" />
            </div>
            {entries.length === 0 ? (
              <div className="mx-4 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                目录为空。
              </div>
            ) : (
              <div className="flex flex-col">
                {entries.map((entry) => (
                  <Dropdown
                    key={entry.path}
                    trigger={['contextMenu']}
                    menu={rowMenu(entry)}
                  >
                    <div
                      className={cn(
                        'flex cursor-pointer items-center gap-3 border-b border-border/40 px-3 py-2 hover:bg-secondary/60',
                        loading && 'opacity-60'
                      )}
                      onDoubleClick={() => enter(entry)}
                      title={entry.isDir ? '双击进入' : undefined}
                    >
                      {entry.isDir ? (
                        <Folder className="size-5 shrink-0 text-sky-500" />
                      ) : (
                        <FileIcon className="size-5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
                      <span className="w-24 shrink-0 text-right font-mono text-xs text-muted-foreground">
                        {entry.isDir ? '-' : formatSize(entry.size)}
                      </span>
                      <span className="w-44 shrink-0 truncate text-xs text-muted-foreground">
                        {formatTime(entry.mtime)}
                      </span>
                      <span className="w-10 shrink-0 text-center">
                        {!entry.isDir && (
                          <Button
                            type="text"
                            className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                            title="下载"
                            icon={<Download className="size-3.5" />}
                            onClick={(e) => {
                              e.stopPropagation()
                              download(entry)
                            }}
                          />
                        )}
                      </span>
                    </div>
                  </Dropdown>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 新建文件夹 */}
      <Modal
        open={mkdirOpen}
        onCancel={() => setMkdirOpen(false)}
        title="新建文件夹"
        okText="创建"
        cancelText="取消"
        centered
        width={400}
        destroyOnHidden
        okButtonProps={{ disabled: !mkdirName.trim() }}
        onOk={() => void submitMkdir()}
      >
        <Input
          autoFocus
          placeholder="文件夹名称"
          value={mkdirName}
          onChange={(e) => setMkdirName(e.target.value)}
          onPressEnter={() => void submitMkdir()}
        />
        <p className="mt-2 text-xs text-muted-foreground">将创建在 {path}</p>
      </Modal>

      {/* 复制 / 移动到…（填目标目录，目标路径 = 目标目录 + 原名称） */}
      <Modal
        open={targetOp !== null}
        onCancel={() => setTargetOp(null)}
        title={targetOp?.mode === 'move' ? '移动到…' : '复制到…'}
        okText="确定"
        cancelText="取消"
        centered
        width={420}
        destroyOnHidden
        okButtonProps={{ disabled: !targetDir.trim() }}
        onOk={() => void submitTargetOp()}
      >
        <p className="mb-2 text-sm text-muted-foreground">
          「{targetOp?.entry.name}」{targetOp?.entry.isDir ? '（含其全部内容）' : ''}{' '}
          将{targetOp?.mode === 'move' ? '移动' : '复制'}到：
        </p>
        <Input
          autoFocus
          placeholder="目标目录，如 /var/www"
          value={targetDir}
          onChange={(e) => setTargetDir(e.target.value)}
          onPressEnter={() => void submitTargetOp()}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          目标路径：{targetDir.trim() ? joinSftpPath(targetDir.trim(), targetOp?.entry.name ?? '') : '—'}
          （同名文件会被覆盖）
        </p>
      </Modal>

      {/* 重命名 */}
      <Modal
        open={renaming !== null}
        onCancel={() => setRenaming(null)}
        title="重命名"
        okText="确定"
        cancelText="取消"
        centered
        width={400}
        destroyOnHidden
        okButtonProps={{ disabled: !renameText.trim() }}
        onOk={() => void submitRename()}
      >
        <Input
          autoFocus
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onPressEnter={() => void submitRename()}
        />
      </Modal>

      {/* 删除确认（目录会递归删除，必须明确警示） */}
      <Modal
        open={pendingRemove !== null}
        onCancel={() => setPendingRemove(null)}
        title="删除？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        centered
        width={440}
        destroyOnHidden
        onOk={() => void confirmRemove()}
      >
        <p className="text-sm text-muted-foreground">
          「{pendingRemove?.name}」将被{pendingRemove?.isDir ? '递归删除（包括目录内全部内容）' : '删除'}
          ，该操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}
