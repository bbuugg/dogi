/**
 * 「导入 OpenAPI / Swagger」弹窗：两种取数来源（本地 JSON / YAML 文件 / URL），
 * 取回文本后先在本地解析并预览（格式 / 标题 / 请求数 / 分组），确认后才落库。
 *
 * 解析（`parseOpenApiSpec`）是纯函数，这里只做「取数 → 预览 → 调 store 落库」的编排：
 * 文件与 URL 的读取都在主进程（`api:openapi:pick` / `api:openapi:fetch`），
 * 渲染端拿到的始终是原始 JSON / YAML 文本，跨格式（OpenAPI 3.x / Swagger 2.0）的逻辑只有一份。
 */
import { parseOpenApiSpec, type OpenApiImportResult } from '@/features/api/openapi-import'
import { useAppStore } from '@/stores/app-store'
import { Alert, Button, Input, Modal, Segmented, Tag, message } from 'antd'
import { FileUp, Link2 } from 'lucide-react'
import { useState } from 'react'

type SourceMode = 'file' | 'url'

export function OpenApiImportModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const importOpenApi = useAppStore((s) => s.importOpenApi)
  const openApiTab = useAppStore((s) => s.openApiTab)

  const [mode, setMode] = useState<SourceMode>('file')
  const [fileName, setFileName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [parsed, setParsed] = useState<OpenApiImportResult | null>(null)
  const [error, setError] = useState('')

  const reset = () => {
    setMode('file')
    setFileName('')
    setUrl('')
    setParsed(null)
    setError('')
  }

  /** 取回文本后做解析：成功进预览态，失败给错误文案 */
  const afterAcquire = (text: string): void => {
    try {
      setParsed(parseOpenApiSpec(text))
      setError('')
    } catch (e) {
      setParsed(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handlePick = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.apiClient.openApiPickFile()
      if (!res.ok) {
        // 用户主动取消不算失败，不弹错误
        if (!res.canceled) setError(res.error ?? '读取文件失败')
        setParsed(null)
        return
      }
      setFileName(res.name ?? '')
      afterAcquire(res.text ?? '')
    } finally {
      setBusy(false)
    }
  }

  const handleFetch = async (): Promise<void> => {
    const target = url.trim()
    if (!target) return
    setBusy(true)
    try {
      const res = await window.api.apiClient.openApiFetch(target)
      if (!res.ok) {
        setError(res.error ?? '抓取失败')
        setParsed(null)
        return
      }
      afterAcquire(res.text ?? '')
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    if (!parsed) return
    setImporting(true)
    try {
      const ids = await importOpenApi(parsed)
      const groupsText = parsed.groups.length ? `、${parsed.groups.length} 个分组` : ''
      onClose()
      reset()
      if (ids.length) {
        message.success(`已导入 ${ids.length} 个请求${groupsText}`)
        openApiTab(ids[0])
      }
    } catch (e) {
      message.error('导入失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      centered
      open={open}
      onCancel={() => {
        reset()
        onClose()
      }}
      width={560}
      destroyOnHidden
      title={
        <div>
          <div className="text-sm">导入 OpenAPI / Swagger</div>
<div className="text-xs font-normal text-muted-foreground">
  支持 OpenAPI 3.x 与 Swagger 2.0 的 JSON / YAML 规格，导入后按接口的 tag 分组
</div>
        </div>
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              reset()
              onClose()
            }}
          >
            取消
          </Button>
          <Button
            type="primary"
            loading={importing}
            disabled={!parsed || parsed.entries.length === 0}
            onClick={() => void handleImport()}
          >
            导入{parsed && parsed.entries.length > 0 ? ` ${parsed.entries.length} 个请求` : ''}
          </Button>
        </div>
      }
    >
      <Segmented
        block
        className="mb-3!"
        value={mode}
        onChange={(v) => setMode(v as SourceMode)}
        options={[
          { label: '从文件', value: 'file' },
          { label: '从 URL', value: 'url' }
        ]}
      />

      {mode === 'file' ? (
        <div className="flex items-center gap-2">
          <Button icon={<FileUp className="size-4" />} loading={busy} onClick={() => void handlePick()}>
            {fileName || '选择 JSON / YAML 文件'}
          </Button>
          <span className="text-xs text-muted-foreground">本地 OpenAPI / Swagger 文件（JSON / YAML）</span>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPressEnter={() => void handleFetch()}
            placeholder="https://petstore.swagger.io/v2/swagger.json"
            prefix={<Link2 className="size-3.5 text-muted-foreground" />}
            spellCheck={false}
          />
          <Button loading={busy} disabled={!url.trim()} onClick={() => void handleFetch()}>
            获取文档
          </Button>
        </div>
      )}

      {error && (
        <Alert className="mt-3" type="error" showIcon message={error} />
      )}

      {parsed && (
        <div className="mt-3 rounded-md border border-border bg-primary/5 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">
              {parsed.title || '未命名接口'}
              {parsed.version ? ` v${parsed.version}` : ''}
            </span>
            <Tag color={parsed.format === 'OpenAPI 3.x' ? 'blue' : 'green'} className="shrink-0!">
              {parsed.format}
            </Tag>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            将导入 <span className="font-semibold text-foreground">{parsed.entries.length}</span>{' '}
            个请求{parsed.groups.length ? `，按 ${parsed.groups.length} 个分组：` : '。'}
          </div>
          {parsed.groups.length > 0 && (
            <div className="mt-2 flex max-h-20 flex-wrap gap-1 overflow-y-auto">
              {parsed.groups.map((g) => (
                <Tag key={g}>{g}</Tag>
              ))}
            </div>
          )}
          {parsed.entries.some((e) => !e.group) && (
            <div className="mt-1 text-xs text-muted-foreground">
              没有 tag 的请求会放进「未分组」。
            </div>
          )}
          {parsed.skipped > 0 && (
            <div className="mt-1 text-xs text-muted-foreground">
              另有 {parsed.skipped} 个操作无法解析，已跳过
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}