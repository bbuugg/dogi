import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, FileText, Loader2 } from 'lucide-react'
import MonacoEditor from '@/components/MonacoEditor'
import { Button, Input, message } from 'antd'
import { useAppStore } from '@/stores/app-store'

/** 自动保存防抖间隔（毫秒）：停止输入后挂起 */
const AUTOSAVE_DELAY = 800

/**
 * 笔记编辑页（主区域）：标题 + 语言选择 + Monaco 正文。
 * 选中笔记存 store 的 ui.activeNoteId；正文/标题/语言改动后防抖自动保存，
 * 也可手动 Ctrl+S（或点保存按钮）立即落盘，侧边栏列表随之刷新。
 */
export function NotesPage() {
  const notes = useAppStore((s) => s.notes)
  const activeNoteId = useAppStore((s) => s.ui.activeNoteId)
  const saveNote = useAppStore((s) => s.saveNote)

  const activeNote = notes.find((n) => n.id === activeNoteId) ?? null

  // 本地草稿（编辑器是受控组件）：随选中笔记重置
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [language, setLanguage] = useState('markdown')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  // 每次渲染同步最新草稿，供防抖定时器 / 快捷键读取最新值
  const draftRef = useRef({ title, content, language })
  draftRef.current = { title, content, language }
  const idRef = useRef<string | null>(activeNoteId)
  idRef.current = activeNoteId
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 当前挂起的防抖保存目标 id（切换笔记时据此把旧笔记的待保存内容冲刷掉） */
  const pendingIdRef = useRef<string | null>(null)

  /** 把指定 id 笔记的「当前草稿」落盘（草稿与 id 由调用方在合适的时机传入） */
  const doSave = async (id: string | null, d: { title: string; content: string; language: string }): Promise<void> => {
    if (!id) return
    setSaving(true)
    try {
      await saveNote({
        id,
        title: d.title.trim() || '未命名笔记',
        content: d.content,
        language: d.language || 'markdown',
        createdAt: 0,
        updatedAt: 0
      })
      setDirty(false)
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  /** 保存「当前正在编辑」的笔记：读取最近一次的 id 与草稿 */
  const saveCurrent = () => doSave(idRef.current, draftRef.current)
  const saveCurrentRef = useRef(saveCurrent)
  saveCurrentRef.current = saveCurrent
  /** 保存指定 id（用于切换前冲刷旧笔记）：草稿取切换那一刻的快照 */
  const saveSnapshot = (id: string) => doSave(id, draftRef.current)

  /** 改动后挂起防抖保存（记录目标 id，供切换时冲刷） */
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

  /** 切换 / 新建笔记：先冲刷旧笔记的待保存内容，再重置草稿 */
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const pendingId = pendingIdRef.current
    pendingIdRef.current = null
    if (pendingId && pendingId !== activeNoteId && draftRef.current.content) {
      void saveSnapshot(pendingId)
    }
    setTitle(activeNote?.title ?? '')
    setContent(activeNote?.content ?? '')
    setLanguage(activeNote?.language ?? 'markdown')
    setDirty(false)
  }, [activeNoteId]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Ctrl/Cmd+S 立即保存当前笔记 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveCurrentRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  if (!activeNote) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <FileText className="size-12 opacity-30" />
        <div className="text-sm">从左侧选择一篇笔记开始编辑</div>
        <div className="text-xs text-muted-foreground/70">或点击「新建笔记」开始记录</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 工具栏：标题 + 语言选择 + 保存状态 */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            markDirty(activeNoteId)
          }}
          placeholder="笔记标题"
          variant="borderless"
          className="min-w-0 flex-1 text-[15px] font-semibold"
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
            markDirty(activeNoteId)
          }}
          language={language}
          onLanguageChange={(lang) => {
            setLanguage(lang)
            markDirty(activeNoteId)
          }}
          showLanguageSelector
          showLineNumbersToggle
          showWordWrapToggle
        />
      </div>
    </div>
  )
}