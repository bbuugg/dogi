import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, FileCode2, Loader2, Play, Trash2 } from 'lucide-react'
import MonacoEditor from '@/components/MonacoEditor'
import { Button, Input, Modal, message } from 'antd'
import { useAppStore } from '@/stores/app-store'
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
      {/* 工具栏：名称 + 描述 + 运行/删除 + 保存状态 */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            // 标签标题跟随脚本名，避免改完名后标签仍是旧名字
            updatePanelTabTitle(`script-${scriptId}`, e.target.value.trim() || '未命名脚本')
            markDirty(scriptId)
          }}
          placeholder="脚本名称"
          variant="borderless"
          className="min-w-0 flex-1 text-[15px] font-semibold"
        />
        <Input
          value={description}
          onChange={(e) => {
            setDescription(e.target.value)
            markDirty(scriptId)
          }}
          placeholder="描述（可选）"
          variant="borderless"
          className="min-w-0 flex-[0.6] text-[13px] text-muted-foreground"
        />
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {saving ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              保存中…
            </>
          ) : dirty ? (
            '未保存'
          ) : (
            <>
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              已保存
            </>
          )}
        </span>
        <Button
          icon={<Play className="size-4" />}
          onClick={() => setRunScriptDialog(true, scriptId)}
          title="选择主机并运行脚本"
        >
          运行
        </Button>
        <Button
          icon={<Trash2 className="size-4" />}
          danger
          onClick={() => setPendingDelete(activeScript)}
          title="删除脚本"
        >
          删除
        </Button>
        <Button onClick={() => void saveCurrentRef.current()} loading={saving}>
          保存
        </Button>
      </div>

      {/* Monaco 编辑器主体 */}
      <div className="min-h-0 flex-1 p-2">
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
