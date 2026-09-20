import { useMemo, useState } from 'react'
import { ChevronDown, Globe, Plus, Terminal, Trash2 } from 'lucide-react'
import { Button, Dropdown, Input, Modal, message } from 'antd'
import { apiTabId, useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import { methodClass } from '@/lib/api-client'
import type { ApiRequestEntry } from '@shared/types'

/** 请求的副标题：优先展示地址，没填地址时给个提示 */
function subtitleOf(req: ApiRequestEntry): string {
  const url = req.url.trim()
  return url || '尚未填写请求地址'
}

/** 相对时间（列表里显示「刚刚」「5 分钟前」…） */
function formatTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${mm}/${day}`
}

/**
 * 接口请求侧边栏：列出保存的请求（最近更新在前），支持搜索 / 新建 / 打开 / 删除。
 *
 * 与脚本管理一致：点击列表项即在 PanelView 中打开该请求的标签页，
 * 列表高亮跟随「当前激活组的激活标签」。
 */
export function ApiPanel() {
  const apiRequests = useAppStore((s) => s.apiRequests)
  /** 当前激活组的激活标签 id（用于列表高亮） */
  const activeTabId = useAppStore((s) => {
    const gid = s.activeGroupId
    return gid ? (s.groups[gid]?.activeTabId ?? null) : null
  })
  const createApiRequest = useAppStore((s) => s.createApiRequest)
  const importCurlRequest = useAppStore((s) => s.importCurlRequest)
  const deleteApiRequest = useAppStore((s) => s.deleteApiRequest)
  const openApiTab = useAppStore((s) => s.openApiTab)

  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ApiRequestEntry | null>(null)
  /** 导入 cURL 弹窗 */
  const [curlOpen, setCurlOpen] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [importing, setImporting] = useState(false)

  /** 最近更新在前，并按搜索过滤 */
  const filtered = useMemo(() => {
    const sorted = [...apiRequests].sort((a, b) => b.updatedAt - a.updatedAt)
    const q = search.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.url.toLowerCase().includes(q) ||
        r.method.toLowerCase().includes(q)
    )
  }, [apiRequests, search])

  /** 新建：先落盘再打开标签（一个请求 = 一个标签，不存在未保存的草稿标签） */
  const handleCreate = async () => {
    setCreating(true)
    try {
      const id = await createApiRequest()
      if (id) openApiTab(id)
    } catch (e) {
      message.error(`新建失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCreating(false)
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    try {
      await deleteApiRequest(target.id)
      message.success('已删除该请求')
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 导入 cURL：解析成一条新的保存请求并打开它的标签 */
  const handleImportCurl = async () => {
    setImporting(true)
    try {
      const id = await importCurlRequest(curlText)
      if (id) openApiTab(id)
      setCurlOpen(false)
      setCurlText('')
      message.success('已导入 cURL 命令')
    } catch (e) {
      message.error('导入失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 py-2">
        {/* 新建入口带下拉：空白请求与「从 cURL 导入」都从这里进 */}
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'blank', icon: <Plus className="size-3.5" />, label: '新建请求' },
              { key: 'curl', icon: <Terminal className="size-3.5" />, label: '导入 cURL' }
            ],
            onClick: ({ key }) => {
              if (key === 'blank') void handleCreate()
              else setCurlOpen(true)
            }
          }}
        >
          <Button
            type="primary"
            block
            loading={creating}
            icon={<Plus className="size-4" />}
            title="新建请求 / 导入 cURL"
          >
            <span className="inline-flex items-center gap-1">
              新建
              <ChevronDown className="size-3.5 opacity-60" />
            </span>
          </Button>
        </Dropdown>
      </div>

      <div className="px-3 pb-2">
        <Input
          placeholder="搜索请求…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {apiRequests.length === 0 ? (
              <>
                还没有保存的请求。
                <br />
                点击上方「新建」创建请求，或导入 cURL 命令。
              </>
            ) : (
              <>没有匹配「{search}」的请求。</>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((r) => {
              const active = activeTabId === apiTabId(r.id)
              return (
                <div
                  key={r.id}
                  onClick={() => openApiTab(r.id)}
                  title={`${r.method} ${r.url}`}
                  className={cn(
                    'group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5',
                    active
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                  )}
                >
                  <Globe className="mt-0.5 size-3.5 shrink-0 opacity-70" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'shrink-0 font-mono text-[10px] font-semibold',
                          methodClass(r.method)
                        )}
                      >
                        {r.method}
                      </span>
                      <span className="truncate text-[13px] font-medium">
                        {r.name.trim() || subtitleOf(r)}
                      </span>
                    </div>
                    {r.name.trim() && (
                      <div className="truncate text-[11px] text-muted-foreground/80">
                        {subtitleOf(r)}
                      </div>
                    )}
                    <div className="text-[10px] text-muted-foreground/60">
                      {formatTime(r.updatedAt)}
                    </div>
                  </div>
                  <Button
                    type="text"
                    size="small"
                    icon={<Trash2 className="size-3.5 text-destructive" />}
                    className="invisible h-5 w-5 shrink-0 p-0 group-hover:visible"
                    title="删除请求"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPendingDelete(r)
                    }}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* cURL 导入：解析成新请求并打开其标签 */}
      <Modal
        centered
        open={curlOpen}
        onCancel={() => setCurlOpen(false)}
        width={576}
        title={
          <div>
            <div className="text-sm">导入 cURL 命令</div>
            <div className="text-[11px] text-muted-foreground">
              粘贴 curl 命令，解析后保存为一条新的请求并打开
            </div>
          </div>
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setCurlOpen(false)}>
              取消
            </Button>
            <Button
              type="primary"
              loading={importing}
              disabled={!curlText.trim()}
              onClick={() => void handleImportCurl()}
            >
              导入
            </Button>
          </div>
        }
      >
        <Input.TextArea
          value={curlText}
          onChange={(e) => setCurlText(e.target.value)}
          placeholder={
            'curl -X POST https://api.example.com/users \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"foo"}\''
          }
          className="h-48! font-mono text-xs"
          spellCheck={false}
          autoFocus
        />
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        title="删除接口请求？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        centered
        width={420}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingDelete?.name.trim() || pendingDelete?.url || '未命名请求'}」将被永久删除，
          该操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}
