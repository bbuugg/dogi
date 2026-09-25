import { useEffect, useState } from 'react'
import { Button, Checkbox, Modal, message } from 'antd'
import { FolderOpen } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import type { TransferEntry, TransferKind } from '@shared/types'

/** 对话框模式：null = 关闭 */
export type TransferMode = 'export' | 'import' | null

/** 三类数据的显示名 */
const KIND_LABEL: Record<TransferKind, string> = {
  hosts: '主机',
  notes: '笔记',
  api: '接口请求'
}

const ALL_KINDS: TransferKind[] = ['hosts', 'notes', 'api']

/**
 * 数据导入 / 导出对话框（左下角菜单进入）。
 *
 * 导出：勾选类型 → 保存对话框选 zip 路径 → 主进程把每类写成一个 JSON 再打包。
 * 导入：先选 zip（主进程解析出有哪些可导入项）→ 勾选要导入的类型 → 写回库。
 *
 * ⚠️ 主机只导出连接元数据：密码 / 私钥 / 口令是 safeStorage 加密的、绑本机与系统账号，
 * 拷到别处也解不开，所以不带出去 —— 导入后需要重新填。
 */
export function DataTransferDialog({
  mode,
  onClose
}: {
  mode: TransferMode
  onClose: () => void
}) {
  const hostCount = useAppStore((s) => s.profiles.length)
  const noteCount = useAppStore((s) => s.notes.length)
  const apiCount = useAppStore((s) => s.apiRequests.length)
  const exportData = useAppStore((s) => s.exportData)
  const pickImportBundle = useAppStore((s) => s.pickImportBundle)
  const applyImport = useAppStore((s) => s.applyImport)
  const cancelImport = useAppStore((s) => s.cancelImport)

  /** 勾选的类型 */
  const [selected, setSelected] = useState<TransferKind[]>(ALL_KINDS)
  /** 已解析的导入包（bundleId 指向主进程里暂存的内容） */
  const [bundle, setBundle] = useState<{ bundleId: string; entries: TransferEntry[] } | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)

  const exporting = mode === 'export'
  const countOf = (kind: TransferKind): number =>
    kind === 'hosts' ? hostCount : kind === 'notes' ? noteCount : apiCount

  // 每次打开都回到初始勾选，避免上一次的选择残留
  useEffect(() => {
    setSelected(ALL_KINDS)
    setBusy(false)
  }, [mode])

  const toggle = (kind: TransferKind, checked: boolean): void => {
    setSelected((prev) => (checked ? [...prev, kind] : prev.filter((k) => k !== kind)))
  }

  /** 关闭 / 取消：顺手丢掉主进程里暂存的解析结果 */
  const handleClose = (): void => {
    if (bundle) void cancelImport(bundle.bundleId)
    setBundle(null)
    onClose()
  }

  const handlePick = async (): Promise<void> => {
    setPicking(true)
    try {
      const result = await pickImportBundle()
      if (result.canceled) return
      if (!result.ok || !result.bundleId || !result.entries) {
        message.error('解析失败：' + (result.error ?? '未知错误'))
        return
      }
      setBundle({ bundleId: result.bundleId, entries: result.entries })
      setSelected(result.entries.map((e) => e.kind))
    } finally {
      setPicking(false)
    }
  }

  const handleExport = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await exportData(selected)
      if (result.canceled) return
      if (!result.ok) {
        message.error('导出失败：' + (result.error ?? '未知错误'))
        return
      }
      const parts = selected.map((k) => `${KIND_LABEL[k]} ${result.counts?.[k] ?? 0} 条`)
      message.success(`已导出（${parts.join('、')}）到 ${result.path}`)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    if (!bundle) return
    setBusy(true)
    try {
      const result = await applyImport(bundle.bundleId, selected)
      if (!result.ok) {
        message.error('导入失败：' + (result.error ?? '未知错误'))
        return
      }
      const parts = selected.map(
        (k) => `${KIND_LABEL[k]} 新增 ${result.added?.[k] ?? 0} / 更新 ${result.updated?.[k] ?? 0}`
      )
      message.success(`导入完成：${parts.join('；')}`)
      setBundle(null)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={mode !== null}
      onCancel={handleClose}
      title={exporting ? '导出数据' : '导入数据'}
      okText={exporting ? '导出' : '导入'}
      cancelText="取消"
      centered
      width={460}
      destroyOnHidden
      confirmLoading={busy}
      okButtonProps={{
        disabled: exporting ? selected.length === 0 : !bundle || selected.length === 0
      }}
      onOk={() => void (exporting ? handleExport() : handleImport())}
    >
      {exporting ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">勾选要导出的数据，每类会写成一个 JSON 文件并打包成 zip。</p>
          <div className="space-y-1">
            {ALL_KINDS.map((kind) => (
              <label
                key={kind}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-foreground/5"
              >
                <Checkbox
                  checked={selected.includes(kind)}
                  onChange={(e) => toggle(kind, e.target.checked)}
                />
                <span className="text-sm">{KIND_LABEL[kind]}</span>
                <span className="ml-auto text-xs text-muted-foreground">{countOf(kind)} 条</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            主机只导出连接信息（地址 / 端口 / 账号 / 分组），密码与私钥不导出 ——
            它们由系统钥匙串加密、仅本机可用，导入后需要重新填写。
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {bundle ? (
            <>
              <p className="text-sm text-muted-foreground">勾选要导入的数据（同 id 会覆盖现有条目）：</p>
              <div className="space-y-1">
                {bundle.entries.map((entry) => (
                  <label
                    key={entry.kind}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-foreground/5"
                  >
                    <Checkbox
                      checked={selected.includes(entry.kind)}
                      onChange={(e) => toggle(entry.kind, e.target.checked)}
                    />
                    <span className="text-sm">{KIND_LABEL[entry.kind]}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {entry.itemCount} 条 · {entry.groupCount} 个分组
                    </span>
                  </label>
                ))}
              </div>
              <Button
                size="small"
                icon={<FolderOpen className="size-3.5" />}
                onClick={() => {
                  void cancelImport(bundle.bundleId)
                  setBundle(null)
                }}
              >
                重新选择文件
              </Button>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 py-4">
              <p className="text-sm text-muted-foreground">选择一个之前导出的 zip 数据包</p>
              <Button icon={<FolderOpen className="size-3.5" />} loading={picking} onClick={() => void handlePick()}>
                选择数据包…
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
