import { useCallback, useEffect, useRef, useState } from 'react'
import { FileCode2, Pencil, Play, Save, Trash2 } from 'lucide-react'
import MonacoEditor from '@/shared/components/MonacoEditor'
import { Button, Input, Modal, message } from 'antd'
import { editorSaveKey, useAppStore } from '@/stores/app-store'
import type { ScriptEntry } from '@shared/types'

/** 自动保存防抖间隔（毫秒） */
const AUTOSAVE_DELAY = 800

/**
 * 脚本编辑页（主区域）：标题 + Monaco 正文。
 * 通过 scriptId prop 指定要编辑的脚本；正文/标题/描述改动后防抖自动保存，
 * 也可手动 Ctrl+S（或点保存按钮）立即落盘，侧边栏列表随之刷新。
 */
export function ScriptsPage({ scriptId }: { scriptId: string }) {
  const scripts = useAppStore((s) => s.scripts)
  const refreshScripts = useAppStore((s) => s.refreshScripts)
  const setRunScriptDialog = useAppStore((s) => s.setRunScriptDialog)
  const updatePanelTabTitle = useAppStore((s) => s.updatePanelTabTitle)
  const setEditorSaveStatus = useAppStore((s) => s.setEditorSaveStatus)

  const activeScript = scripts.find((sc) => sc.id === scriptId) ?? null

  // 本地草稿
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const draftRef = useRef({ name, description, content })
  draftRef.current = { name, description, content }
  const idRef = useRef<string | null>(scriptId)
  idRef.current = scriptId
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingIdRef = useRef<string | null>(null)

  /** 把指定 id 脚本的「当前草稿」落盘 */
  const doSave = async (
    id: string | null,
    d: { name: string; description: string; content: string }
  ): Promise<void> => {
    if (!id) return
    setSaving(true)
    try {
      await window.api.scripts.save({
        id,
        name: d.name.trim() || '未命名脚本',
        description: d.description.trim() || undefined,
        content: d.content,
        createdAt: 0,
        updatedAt: 0
      })
      await refreshScripts()
      setDirty(false)
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const saveCurrent = () => doSave(idRef.current, draftRef.current)
  const saveCurrentRef = useRef(saveCurrent)
  saveCurrentRef.current = saveCurrent
  const saveSnapshot = (id: string) => doSave(id, draftRef.current)

  const markDirty = (id: string | null) => {
    setDirty(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!id) return
    pendingIdRef.current = id
    timerRef.current = setTimeout(() => {
      const pid = pendingIdRef.current
      pendingIdRef.current = null
      if (pid) void saveSnapshot(pid)
    }, AUTOSAVE_DELAY)
  }

  /** 切换脚本：先冲刷旧脚本的待保存内容，再重置草稿 */
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const pendingId = pendingIdRef.current
    pendingIdRef.current = null
    if (pendingId && pendingId !== scriptId && draftRef.current.content) {
      void saveSnapshot(pendingId)
    }
    setName(activeScript?.name ?? '')
    setDescription(activeScript?.description ?? '')
    setContent(activeScript?.content ?? '')
    setDirty(false)
  }, [scriptId]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Ctrl/Cmd+S 立即保存 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveCurrentRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * 关闭标签（组件卸载）时把待保存内容冲刷掉：
   * 否则「输入后 800ms 内关掉标签」会丢掉最后一段输入。
   * 脚本已被删除时跳过，避免把已删除的脚本又写回去。
   */
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      const pendingId = pendingIdRef.current
      pendingIdRef.current = null
      if (!pendingId) return
      const exists = useAppStore.getState().scripts.some((sc) => sc.id === pendingId)
      if (exists) void doSave(pendingId, draftRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 把保存状态投影到 store，供底部状态栏的 EditorSaveStatus 显示 */
  useEffect(() => {
    setEditorSaveStatus(editorSaveKey('script', scriptId), saving ? 'saving' : dirty ? 'dirty' : 'saved')
  }, [scriptId, saving, dirty, setEditorSaveStatus])

  /** 名称 / 描述编辑弹窗（null = 关闭） */
  const [metaEdit, setMetaEdit] = useState<{ name: string; description: string } | null>(null)

  /** 提交名称 / 描述：直接落盘（这两项不再走自动保存） */
  const submitMetaEdit = async (): Promise<void> => {
    const target = metaEdit
    if (!target) return
    const nextName = target.name.trim() || '未命名脚本'
    const nextDesc = target.description.trim()
    setName(nextName)
    setDescription(nextDesc)
    // 标签标题跟随脚本名，避免改完名后标签仍是旧名字
    updatePanelTabTitle(`script-${scriptId}`, nextName)
    setMetaEdit(null)
    if (timerRef.current) clearTimeout(timerRef.current)
    await doSave(scriptId, {
      name: nextName,
      description: nextDesc,
      content: draftRef.current.content
    })
  }

  /** 删除确认 */
  const [pendingDelete, setPendingDelete] = useState<ScriptEntry | null>(null)
  const confirmDelete = useCallback(async () => {
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
  }, [pendingDelete, refreshScripts])

  if (!activeScript) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <FileCode2 className="size-12 opacity-30" />
        <div className="text-sm">从左侧选择一个脚本开始编辑</div>
        <div className="text-xs text-muted-foreground/70">或点击「新建脚本」开始创建</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 工具栏：名称（文本 + 紧邻的编辑按钮，弹窗改名称/描述）+ 运行/删除/保存。
          保存状态不在这里，改由底部状态栏显示（见 EditorSaveStatus）。 */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-[15px] font-semibold">{name || '未命名脚本'}</span>
          <Button
            type="text"
            size="small"
            className="shrink-0 px-1 text-muted-foreground"
            icon={<Pencil className="size-3.5" />}
            title="编辑名称与描述"
            onClick={() => setMetaEdit({ name, description })}
          />
          {description.trim() && (
            <span
              className="min-w-0 truncate text-[13px] text-muted-foreground"
              title={description}
            >
              {description}
            </span>
          )}
        </div>
        <Button
          type='text'
          icon={<Play className="size-4" />}
          onClick={() => setRunScriptDialog(true, scriptId)}
          title="选择主机并运行脚本"
        />
        <Button
          type='text'
          icon={<Trash2 className="size-4" />}
          danger
          onClick={() => setPendingDelete(activeScript)}
          title="删除脚本"
        />
        <Button
          type='text'
          icon={<Save className="size-4" />}
          onClick={() => void saveCurrentRef.current()} loading={saving}
        />
      </div>

      {/* Monaco 编辑器主体 */}
      <div className="min-h-0 flex-1">
        <MonacoEditor
          value={content}
          onChange={(v) => {
            setContent(v)
            markDirty(scriptId)
          }}
          language="shell"
          showLanguageSelector
          showLineNumbersToggle
          showWordWrapToggle
        />
      </div>

      {/* 名称 / 描述编辑 */}
      <Modal
        open={metaEdit !== null}
        onCancel={() => setMetaEdit(null)}
        title="编辑脚本信息"
        okText="保存"
        cancelText="取消"
        centered
        width={440}
        destroyOnHidden
        okButtonProps={{ disabled: !metaEdit?.name.trim() }}
        onOk={() => void submitMetaEdit()}
      >
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">名称</div>
            <Input
              autoFocus
              value={metaEdit?.name ?? ''}
              onChange={(e) => setMetaEdit((m) => (m ? { ...m, name: e.target.value } : m))}
              placeholder="脚本名称"
              onPressEnter={() => void submitMetaEdit()}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">描述（可选）</div>
            <Input
              value={metaEdit?.description ?? ''}
              onChange={(e) => setMetaEdit((m) => (m ? { ...m, description: e.target.value } : m))}
              placeholder="描述（可选）"
            />
          </div>
        </div>
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
