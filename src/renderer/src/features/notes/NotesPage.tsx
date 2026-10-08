import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Popover, message } from 'antd'
import { CircleHelp, FileText, Save } from 'lucide-react'
import { EDITOR_SHORTCUT_GROUPS, formatEditorShortcut } from '@shared/shortcuts'
import { MilkdownEditor } from '@/features/notes/MilkdownEditor'
import { editorSaveKey, useAppStore } from '@/stores/app-store'
import { useTabCloseGuard } from '@/shared/lib/use-tab-close-guard'

/** 「延迟保存」模式下等待秒数的兜底值（偏好缺字段时用） */
const FALLBACK_AUTOSAVE_SECONDS = 2

/**
 * 「?」按钮里的快捷键浮层：按分组列出编辑器（Milkdown）的按键。
 *
 * 清单来自 `@shared/shortcuts`，与设置页「笔记编辑器快捷键」一栏是同一份数据，
 * 键位改动只需改那一处。
 */
function EditorShortcutHelp() {
  const platform = window.api.app.platform
  return (
    <div className="max-h-[420px] w-[300px] overflow-y-auto">
      {EDITOR_SHORTCUT_GROUPS.map((group) => (
        <div key={group.name} className="mt-3 first:mt-0">
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground">
            {group.name}
          </div>
          <div className="mt-0.5 divide-y divide-border/60">
            {group.items.map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-4 py-1">
                <span className="min-w-0 text-[12px]">{item.label}</span>
                <span className="shrink-0 rounded border border-border/60 bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
                  {formatEditorShortcut(item, platform)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="mt-3 border-t border-border/60 pt-2 text-[11px] leading-4 text-muted-foreground">
        这些键只在光标位于笔记正文里时生效，不占用应用快捷键。Mac 上 Ctrl 对应 ⌘。
      </p>
    </div>
  )
}

/**
 * 笔记编辑页（主区域）：Crepe 正文 + 文件路径标题栏。
 *
 * 笔记直接读写本地 `.md` 文件：
 * - 打开标签 / 每次切回本标签时从磁盘读取（顺带探测文件是否还在）
 * - 编辑后防抖自动保存（写回原文件），也可手动 Ctrl+S 立即落盘
 * - 没有标题栏编辑 —— 标题就是文件名
 *
 * `active` 由面板传入：标签是保活的（切走只是 hidden 不卸载），
 * 所以「切回来」不会重新挂载组件，必须靠这个标记再探一次磁盘。
 */
export function NotesPage({ filePath, active = true, tabId }: { filePath: string; active?: boolean; tabId?: string }) {
  const saveNoteFile = useAppStore((s) => s.saveNoteFile)
  const setEditorSaveStatus = useAppStore((s) => s.setEditorSaveStatus)
  // 保存时机（偏好）：manual 只标记不落盘、immediate 立即落盘、delay 等若干秒
  const noteSaveMode = useAppStore((s) => s.preferences.noteSaveMode)
  const noteAutoSaveDelay = useAppStore((s) => s.preferences.noteAutoSaveDelay)

  const fileName = filePath.split(/[\\/]/).pop() ?? filePath

  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  /** 磁盘上这个文件已经不存在（被外部删除 / 移动） */
  const [missing, setMissing] = useState(false)

  // 每次渲染同步最新草稿，供防抖定时器 / 快捷键读取最新值
  const draftRef = useRef(content)
  draftRef.current = content
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const pathRef = useRef(filePath)
  pathRef.current = filePath
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 当前挂起的防抖保存目标路径（切换文件时据此把旧文件的待保存内容冲刷掉） */
  const pendingPathRef = useRef<string | null>(null)
  /** 上一次真正读过盘的路径：用来区分「切文件」与「切回同一标签」 */
  const loadedPathRef = useRef<string | null>(null)
  /** 是否已经就文件缺失提示过（免得每次切回来都弹一次） */
  const warnedMissingRef = useRef(false)
  /**
   * 保存时机的实时值。`markDirty` 会被 onChange 高频调用，
   * 用 ref 读就省得把偏好挂进它的依赖、也不用每次渲染重造闭包。
   */
  const saveModeRef = useRef(noteSaveMode)
  saveModeRef.current = noteSaveMode
  const autoSaveSecondsRef = useRef(noteAutoSaveDelay)
  autoSaveSecondsRef.current = noteAutoSaveDelay

  /**
   * 关闭拦截 guard：有未保存改动时弹三选一（不保存 / 保存并关闭 / 取消）。
   * dirtyRef / savingRef 存最新值供 guard 闭包读取。
   */
  const savingRef = useRef(saving)
  savingRef.current = saving
  /** 用户在关闭确认里选了「不保存」时置 true，卸载时据此跳过冲刷 */
  const discardingRef = useRef(false)
  useTabCloseGuard(tabId, ({ confirm: ask }) => {
    // ⚠️ 笔记的关闭确认**由本页全权负责**（不论脏不脏），所以每条分支都带 `owned: true` ——
    // 干净时直接放行、不必再让 shell 兜底问一句「确定关闭标签？」（旧实现靠一个类型白名单
    // PAGE_MANAGED_CLOSE_TYPES 来区分，新增页面漏加就弹两次窗）。
    if (!dirtyRef.current && !savingRef.current) return { allow: true, owned: true }
    // 「关闭标签前二次确认」关掉：不弹三选一，直接走「不保存直接关闭」——
    // 置 discardingRef 让卸载时跳过冲刷（草稿丢弃），放行后由总线真正关闭
    if (!useAppStore.getState().preferences.confirmCloseTab) {
      discardingRef.current = true
      return { allow: true, owned: true }
    }
    return ask({
      title: '有未保存的修改',
      content: `「${fileName}」有未保存的修改，保存后关闭，还是直接放弃？`,
      actions: [
        { label: '取消', value: false },
        {
          label: '不保存',
          kind: 'danger',
          value: true,
          run: () => {
            discardingRef.current = true
            return true
          }
        },
        // 保存失败（ok=false）否决关闭，确认框保持原样等待用户再选
        { label: '保存并关闭', kind: 'primary', value: true, run: saveCurrentRef.current }
      ]
    }).then((ok) => ({ allow: ok, owned: true }))
  })

  /** 把指定路径文件的「当前草稿」落盘；返回 false = 没写进去（关标签时据此别关） */
  const doSave = async (path: string, text: string): Promise<boolean> => {
    if (!path) return true
    setSaving(true)
    try {
      await saveNoteFile(path, text)
      setDirty(false)
      setMissing(false)
      warnedMissingRef.current = false
      return true
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  /** 保存「当前正在编辑」的文件：读取最近一次的路径与草稿 */
  const saveCurrent = () => doSave(pathRef.current, draftRef.current)
  const saveCurrentRef = useRef(saveCurrent)
  saveCurrentRef.current = saveCurrent
  /** 保存指定路径（用于切换前冲刷旧文件） */
  const saveSnapshot = (path: string) => doSave(path, draftRef.current)

  /**
   * 改动后按「保存时机」决定要不要挂起自动保存。
   *
   * - manual：只把状态标成未保存，内容留在编辑器里等用户点保存 / Ctrl+S
   * - immediate：立刻写盘（0 延迟；仍是定时器，连续输入会在同一轮里合并）
   * - delay：停止输入 N 秒后写盘
   */
  const markDirty = (path: string) => {
    setDirty(true)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const mode = saveModeRef.current
    if (mode === 'manual' || !path) return
    pendingPathRef.current = path
    const seconds = mode === 'immediate' ? 0 : autoSaveSecondsRef.current || FALLBACK_AUTOSAVE_SECONDS
    timerRef.current = setTimeout(() => {
      const pp = pendingPathRef.current
      pendingPathRef.current = null
      if (pp) void saveSnapshot(pp)
    }, Math.max(0, seconds) * 1000)
  }

  /**
   * 读盘：首次打开、切换文件、以及**每次切回这个标签**都会跑一遍。
   *
   * 每次激活都探一次是有意的 —— 笔记文件可能在应用之外被删掉或改掉，
   * 只在打开那一刻读一次的话，切回来看到的还是旧内容、也没有任何提示。
   */
  useEffect(() => {
    if (!active) return
    const switched = loadedPathRef.current !== filePath
    if (switched) {
      // 切文件：先冲刷旧文件的待保存内容，再进入加载态
      if (timerRef.current) clearTimeout(timerRef.current)
      const pendingPath = pendingPathRef.current
      pendingPathRef.current = null
      if (pendingPath && pendingPath !== filePath && draftRef.current) {
        void saveSnapshot(pendingPath)
      }
      loadedPathRef.current = filePath
      setLoaded(false)
      setDirty(false)
      setMissing(false)
      warnedMissingRef.current = false
    }

    let cancelled = false
    void (async () => {
      try {
        const result = await window.api.notes.readFile('', filePath)
        if (cancelled) return
        setMissing(false)
        warnedMissingRef.current = false
        // 有未保存改动时不要用磁盘内容盖掉用户的草稿；只有「刚切过来」、
        // 或「本地没改动且磁盘内容确实变了（外部编辑过）」才同步进来
        if (switched || (!dirtyRef.current && result.content !== draftRef.current)) {
          setContent(result.content)
        }
      } catch {
        if (cancelled) return
        setMissing(true)
        if (!warnedMissingRef.current) {
          warnedMissingRef.current = true
          message.warning(`文件不存在或已被删除：${fileName}`)
        }
      } finally {
        // ⚠️ 只要这次读盘没被取消就必须脱离加载态，**不能**拿 switched 当条件：
        // React StrictMode 会把 effect 跑两遍，第二遍时 loadedPathRef 已被第一遍写进去了
        // （switched = false），于是两边都判定「不需要 setLoaded(true)」，
        // 页面就永远停在「正在加载文件…」。
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, active])

  /** Ctrl/Cmd+S 立即保存当前文件 */
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
   * 关闭标签（组件卸载）时把待保存内容冲刷掉。
   *
   * ⚠️ 但用户选了「不保存并关闭」时**不能**冲刷 —— 那正好会把刚被丢弃的草稿又写回磁盘，
   * 把弹框里的「不保存」变成一个假选项。标记由 guard 写进 discardingRef，这里用完即清。
   */
  useEffect(() => {
    return () => {
      const discarding = discardingRef.current
      discardingRef.current = false

      // ⚠️ 挂起的防抖保存**一律**要取消掉，不管是不是「不保存」：
      // 组件都已经卸载了，任由它跑下去只会在几百毫秒后把内容偷偷写回磁盘 ——
      // 那样弹框里的「不保存」就是个假选项（实测踩过：只跳过下面的冲刷没用，
      // 定时器照样触发）。
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const pendingPath = pendingPathRef.current
      pendingPathRef.current = null

      // 正常关闭才补一次落盘；「不保存」到此为止
      if (!discarding && pendingPath) void doSave(pendingPath, draftRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 把保存状态投影到 store，供底部状态栏的 EditorSaveStatus 显示（关闭确认也据此判断脏） */
  useEffect(() => {
    setEditorSaveStatus(editorSaveKey('note', filePath), saving ? 'saving' : dirty ? 'dirty' : 'saved')
  }, [filePath, saving, dirty, setEditorSaveStatus])

  if (!loaded) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <FileText className="size-12 animate-pulse opacity-30" />
        <div className="text-sm">正在加载文件…</div>
      </div>
    )
  }

  return (
    // relative：关闭确认遮罩（element）以根容器定位，只盖住本标签
    <div className="relative flex h-full flex-col bg-background">
      {/* 工具栏：文件名 + 快捷键帮助 + 保存按钮 */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{fileName}</span>
        <Popover
          trigger="click"
          placement="bottomRight"
          arrow={false}
          title="笔记编辑器快捷键"
          styles={{ content: { padding: 12 } }}
          content={<EditorShortcutHelp />}
        >
          <Button type="text" aria-label="查看编辑器快捷键" icon={<CircleHelp className="size-4" />} />
        </Popover>
        <Button
          type='text'
          icon={<Save className='size-4' />}
          onClick={() => void saveCurrentRef.current()}
          loading={saving}
        />
      </div>

      {/* 文件被外部删掉 / 移走时的提示：不挡编辑，但要让人知道保存会重新创建它 */}
      {missing && (
        <Alert
          type="warning"
          showIcon
          className="mx-3 mb-1"
          message={`文件已不存在（可能被删除或移动）。保存会重新创建「${fileName}」。`}
        />
      )}

      {/* Crepe 主体 */}
      <div className="min-h-0 flex-1">
        <MilkdownEditor
          value={content}
          onChange={(v) => {
            setContent(v)
            // 立刻同步草稿，不等 React 渲染：自动保存的定时器可能赶在渲染之前跑
            // （「立即保存」是 0ms），那时 draftRef 还是上一版内容，会把旧的写回去。
            draftRef.current = v
            markDirty(filePath)
          }}
        />
      </div>
    </div>
  )
}
