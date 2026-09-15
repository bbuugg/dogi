import { useState } from 'react'
import { ArrowLeft, Pencil, Plus, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAppStore } from '@/stores/app-store'
import type { ScriptEntry } from '@shared/types'

/** 脚本管理页：列出 / 新增 / 编辑 / 删除用户脚本（持久化到本地存储） */
export function ScriptsPage() {
  const scripts = useAppStore((s) => s.scripts)
  const refreshScripts = useAppStore((s) => s.refreshScripts)
  const setView = useAppStore((s) => s.setView)
  const setScriptPaletteOpen = useAppStore((s) => s.setScriptPaletteOpen)

  // null = 列表视图；非 null = 编辑/新增表单（持有待保存内容）
  const [editing, setEditing] = useState<ScriptEntry | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)

  const startAdd = () => {
    setEditing({ id: '', name: '', content: '', createdAt: 0, updatedAt: 0 })
    setName('')
    setDescription('')
    setContent('')
  }

  const startEdit = (s: ScriptEntry) => {
    setEditing(s)
    setName(s.name)
    setDescription(s.description ?? '')
    setContent(s.content)
  }

  const cancel = () => setEditing(null)

  const save = async () => {
    if (!name.trim() || !content.trim()) return
    setSaving(true)
    try {
      await window.api.scripts.save({
        id: editing?.id || '',
        name: name.trim(),
        description: description.trim() || undefined,
        content,
        createdAt: editing?.createdAt ?? 0,
        updatedAt: 0
      })
      await refreshScripts()
      setEditing(null)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm('确定删除该脚本吗？')) return
    await window.api.scripts.remove(id)
    await refreshScripts()
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Button variant="ghost" size="sm" onClick={() => setView('terminal')}>
          <ArrowLeft className="size-4" /> 返回终端
        </Button>
        <h1 className="text-sm font-semibold">脚本管理</h1>
        <span className="text-xs text-muted-foreground">共 {scripts.length} 个脚本</span>
        <div className="ml-auto flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setScriptPaletteOpen(true)}
            title="在当前终端运行脚本（Ctrl+Shift+P）"
          >
            <Play className="size-4" /> 运行脚本
          </Button>
          <Button size="sm" onClick={startAdd}>
            <Plus className="size-4" /> 新增脚本
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {editing === null ? (
          scripts.length === 0 ? (
            <div className="mx-auto mt-16 max-w-md rounded-md border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">
              还没有脚本。
              <br />
              把常用命令保存下来，之后在终端按 Ctrl+Shift+P 即可快速执行。
              <div className="mt-4">
                <Button size="sm" onClick={startAdd}>
                  <Plus className="size-4" /> 新增脚本
                </Button>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-1">
              {scripts.map((s) => (
                <div
                  key={s.id}
                  className="group flex items-center gap-3 rounded-md border border-border/60 px-3 py-2.5 hover:bg-secondary"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    {s.description && (
                      <div className="truncate text-xs text-muted-foreground">{s.description}</div>
                    )}
                    <div className="truncate font-mono text-[11px] text-muted-foreground/80">
                      {s.content.split('\n')[0] || ''}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="编辑"
                    onClick={() => startEdit(s)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="删除"
                    onClick={() => void remove(s.id)}
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="script-name">名称</Label>
              <Input
                id="script-name"
                value={name}
                placeholder="例如：查看磁盘占用"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="script-desc">描述（可选，用于搜索）</Label>
              <Input
                id="script-desc"
                value={description}
                placeholder="例如：按大小列出当前目录前 10 个文件"
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="script-content">脚本内容</Label>
              <Textarea
                id="script-content"
                value={content}
                placeholder="可多行，选择后整体写入终端并执行"
                className="h-56 font-mono text-xs"
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={cancel} disabled={saving}>
                取消
              </Button>
              <Button
                onClick={() => void save()}
                disabled={saving || !name.trim() || !content.trim()}
              >
                保存
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
