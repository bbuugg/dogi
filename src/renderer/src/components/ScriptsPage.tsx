import MonacoEditor from '@/components/MonacoEditor'
import { useAppStore } from '@/stores/app-store'
import type { ScriptEntry } from '@shared/types'
import { Button, Form, Input, Modal, message } from 'antd'
import { Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

/** 脚本管理页：列出 / 新增 / 编辑 / 删除用户脚本（持久化到本地存储） */
export function ScriptsPage() {
  const scripts = useAppStore((s) => s.scripts)
  const refreshScripts = useAppStore((s) => s.refreshScripts)
  const setRunScriptDialog = useAppStore((s) => s.setRunScriptDialog)

  // null = 列表视图；非 null = 编辑/新增表单（持有待保存内容）
  const [editing, setEditing] = useState<ScriptEntry | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  /** 待确认删除的脚本（非 null 时弹出确认框） */
  const [pendingDelete, setPendingDelete] = useState<ScriptEntry | null>(null)

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
      message.success('脚本已保存')
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
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
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between px-5 py-3">
        <div>
          <h1 className="text-base font-semibold">脚本管理</h1>
          <p className="text-[11px] text-muted-foreground">
            共 {scripts.length} 个脚本
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            icon={<Play className="size-4" />}
            variant="filled"
            onClick={() => setRunScriptDialog(true)}
            title="选择主机并运行脚本"
          >
            运行脚本
          </Button>
          <Button icon={<Plus className="size-4" />}
            type="primary"
            onClick={startAdd}
          >
            新增脚本
          </Button>
        </div>
      </div>

      {/* 脚本内容属于「内容」，保持可选中复制 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {scripts.length === 0 ? (
          <div className="mx-auto mt-16 max-w-md rounded-md border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">
            还没有脚本。
            <br />
            把常用命令保存下来，之后选择主机执行；也可在终端按 Ctrl+Shift+P
            打开命令面板，选择「运行脚本」。
            <div className="mt-4">
              <Button icon={<Plus className="size-4" />} type="primary" onClick={startAdd}>
                新增脚本
              </Button>
            </div>
          </div>
        ) : (
          // 每行 3 个脚本卡片
          <div className="mx-auto grid max-w-6xl grid-cols-3 gap-2">
            {scripts.map((s) => (
              <div
                key={s.id}
                onDoubleClick={() => setRunScriptDialog(true, s.id)}
                className="group flex min-w-0 flex-col gap-1 rounded-md border border-border/60 px-3 py-2.5 hover:bg-secondary cursor-pointer"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    {s.description && (
                      <div className="truncate text-xs text-muted-foreground">
                        {s.description}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="text"
                      icon={<Play className="size-4" />}
                      size="small"
                      className="w-7 p-0"
                      title="选择主机运行"
                      onClick={() => setRunScriptDialog(true, s.id)}
                    />
                    <Button
                      icon={<Pencil className="size-4" />}
                      type="text"
                      size="small"
                      className="w-7 p-0"
                      title="编辑"
                      onClick={() => startEdit(s)}
                    />
                    <Button
                      type="text"
                      icon={<Trash2 className="size-4 text-destructive" />}
                      size="small"
                      className="w-7 p-0"
                      title="删除"
                      onClick={() => setPendingDelete(s)}
                    />
                  </div>
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground/80">
                  {s.content.split('\n')[0] || ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 新增 / 编辑脚本 */}
      <Modal
        open={editing !== null}
        onCancel={cancel}
        title={editing?.id ? '编辑脚本' : '新增脚本'}
        okText="保存"
        cancelText="取消"
        onOk={() => void save()}
        confirmLoading={saving}
        okButtonProps={{ disabled: !name.trim() || !content.trim() }}
        cancelButtonProps={{ disabled: saving }}
        centered
        width={640}
        destroyOnHidden
      >
        <Form layout="vertical" requiredMark={false}>
          <Form.Item label="名称" required>
            <Input
              value={name}
              placeholder="例如：查看磁盘占用"
              onChange={(e) => setName(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="描述（可选，用于搜索）">
            <Input
              value={description}
              placeholder="例如：按大小列出当前目录前 10 个文件"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="脚本内容" required style={{ marginBottom: 0 }}>
            <MonacoEditor
              height={64 * 4}
              value={content}
              onChange={setContent}
              language="shell"
              showLanguageSelector
              showLineNumbersToggle
              showWordWrapToggle
            />
          </Form.Item>
        </Form>
      </Modal>

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
