import { useMemo, useState } from 'react'
import { FileCode2, Play, Plus, Trash2 } from 'lucide-react'
import { Button, Input, Modal, message } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type { ScriptEntry } from '@shared/types'

/** 脚本更新时间的人类可读展示（如「刚刚」「5 分钟前」「昨天」「7/12」） */
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

/** 取脚本正文第一条非空行作为列表副标题预览 */
function previewOf(content: string): string {
  return content.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

/**
 * 脚本侧边栏：列出全部脚本（最近更新在前），支持搜索 / 新建 / 选中 / 删除 / 直接运行。
 * 选中状态存在 store 的 ui.activeScriptId，右侧 ScriptsPage 据此加载编辑器。
 */
export function ScriptsPanel() {
  const scripts = useAppStore((s) => s.scripts)
  const activeScriptId = useAppStore((s) => s.ui.activeScriptId)
  const refreshScripts = useAppStore((s) => s.refreshScripts)
  const selectScript = useAppStore((s) => s.selectScript)
  const setRunScriptDialog = useAppStore((s) => s.setRunScriptDialog)

  const [search, setSearch] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ScriptEntry | null>(null)
  const [creating, setCreating] = useState(false)

  /** 最近更新在前，并按搜索过滤 */
  const filtered = useMemo(() => {
    const sorted = [...scripts].sort((a, b) => b.updatedAt - a.updatedAt)
    const q = search.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q) ||
        s.content.toLowerCase().includes(q)
    )
  }, [scripts, search])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const prevIds = new Set(scripts.map((sc) => sc.id))
      const list = await window.api.scripts.save({
        id: '',
        name: '未命名脚本',
        content: '',
        createdAt: 0,
        updatedAt: 0
      })
      const created = list.find((sc) => !prevIds.has(sc.id))
      if (created) {
        await refreshScripts()
        selectScript(created.id)
      }
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
      await window.api.scripts.remove(target.id)
      await refreshScripts()
      message.success(`已删除「${target.name}」`)
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 py-2">
        <Button
          type="primary"
          block
          icon={<Plus className="size-4" />}
          onClick={handleCreate}
          loading={creating}
        >
          新建脚本
        </Button>
      </div>

      <div className="px-3 pb-2">
        <Input
          placeholder="搜索脚本…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {scripts.length === 0 ? (
              <>
                还没有脚本。
                <br />
                点击上方「新建脚本」开始创建。
              </>
            ) : (
              <>没有匹配「{search}」的脚本。</>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((s) => {
              const active = s.id === activeScriptId
              return (
                <div
                  key={s.id}
                  onClick={() => selectScript(s.id)}
                  className={cn(
                    'group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5',
                    active
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                  )}
                >
                  <FileCode2 className="mt-0.5 size-3.5 shrink-0 opacity-70" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{s.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground/80">
                      {previewOf(s.content)}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60">
                      {formatTime(s.updatedAt)}
                    </div>
                  </div>
                  <div className="invisible flex shrink-0 flex-col gap-0.5 group-hover:visible">
                    <Button
                      type="text"
                      size="small"
                      icon={<Play className="size-3.5" />}
                      className="h-5 w-5 p-0"
                      title="运行脚本"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRunScriptDialog(true, s.id)
                      }}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<Trash2 className="size-3.5 text-destructive" />}
                      className="h-5 w-5 p-0"
                      title="删除脚本"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingDelete(s)
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 删除确认 */}
      <Modal
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        title="删除脚本？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        centered
        width={420}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingDelete?.name}」将被永久删除，该操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}
