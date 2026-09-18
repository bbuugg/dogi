import { useMemo, useState } from 'react'
import { FileText, Plus, Trash2 } from 'lucide-react'
import { Button, Modal, message } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type { NoteEntry } from '@shared/types'

/** 笔记创建时间 / 更新时间的人类可读展示（如「刚刚」「5 分钟前」「昨天」「7/12」） */
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

/** 取笔记正文第一条非空行作为列表副标题预览 */
function previewOf(content: string): string {
  return content.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

/**
 * 笔记侧边栏：列出全部笔记（最近编辑在前），支持新建 / 选中 / 删除。
 * 选中状态存在 store 的 ui.activeNoteId，右侧 NotesPage 据此加载正文。
 */
export function NotesPanel() {
  const notes = useAppStore((s) => s.notes)
  const activeNoteId = useAppStore((s) => s.ui.activeNoteId)
  const createNote = useAppStore((s) => s.createNote)
  const deleteNote = useAppStore((s) => s.deleteNote)
  const selectNote = useAppStore((s) => s.selectNote)

  /** 待确认删除的笔记（非 null 时弹出确认框） */
  const [pendingDelete, setPendingDelete] = useState<NoteEntry | null>(null)
  const [creating, setCreating] = useState(false)

  /** 最近编辑在前的稳定排序（依赖 store.notes，每次更新自动重排） */
  const sorted = useMemo(
    () => [...notes].sort((a, b) => b.updatedAt - a.updatedAt),
    [notes]
  )

  const handleCreate = async () => {
    setCreating(true)
    try {
      await createNote()
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
      await deleteNote(target.id)
      message.success(`已删除「${target.title}」`)
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2">
        <Button type="primary" block icon={<Plus className="size-4" />} onClick={handleCreate} loading={creating}>
          新建笔记
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {sorted.length === 0 ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            还没有笔记。
            <br />
            点击上方「新建笔记」开始记录。
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sorted.map((n) => {
              const active = n.id === activeNoteId
              return (
                <div
                  key={n.id}
                  onClick={() => selectNote(n.id)}
                  className={cn(
                    'group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5',
                    active
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                  )}
                >
                  <FileText className="mt-0.5 size-3.5 shrink-0 opacity-70" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{n.title}</div>
                    <div className="truncate text-[11px] text-muted-foreground/80">
                      {previewOf(n.content)}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60">{formatTime(n.updatedAt)}</div>
                  </div>
                  <Button
                    type="text"
                    size="small"
                    icon={<Trash2 className="size-3.5 text-destructive" />}
                    className="invisible w-6 shrink-0 p-0 text-muted-foreground group-hover:visible"
                    title="删除笔记"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPendingDelete(n)
                    }}
                  />
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
        title="删除笔记？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        centered
        width={420}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingDelete?.title}」将被永久删除，该操作不可撤销。
        </p>
      </Modal>
    </div>
  )
}