import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Circle, Eraser, Play, Plus, Save, Square } from 'lucide-react'
import { Button, Dropdown, Input, Tooltip, message, type MenuProps } from 'antd'
import MonacoEditor, { type MonacoEditorHandle } from '@/shared/components/MonacoEditor'
import { ResizeHandle } from '@/shared/components/ResizeHandle'
import { editorSaveKey, useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type {
  BrowserLogEvent,
  BrowserLogLevel,
  BrowserRecordEvent,
  BrowserSessionState,
  BrowserViewportMode
} from '@shared/types'
import { DEFAULT_BROWSER_VIEWPORT } from '@shared/browser'
import { BrowserPane } from './BrowserPane'
import { INSERT_SNIPPET_GROUPS, findSnippet } from './script-snippets'

/** 自动保存防抖间隔（毫秒） */
const AUTOSAVE_DELAY = 800
/** 日志最多保留多少条（长时间录制 + 运行会刷很多） */
const LOG_LIMIT = 500

/**
 * 浏览器面板 : 代码面板 的默认宽度比 = **3:2**。
 *
 * （最初是 3:1，用户反馈编辑器初始宽度太小后调大编辑器比例。）
 * 注意这只是**默认值**：用户拖过分隔条之后就以他拖的为准，之后窗口缩放只做钳制、
 * 不再按比例覆盖他的选择（否则拖完一改窗口大小就被打回去，手感像坏了）。
 */
const BROWSER_WIDTH_RATIO = 3 / 5
/** 容器宽度还没量出来（首帧）时先按这个算，量到真实值后立刻修正 */
const FALLBACK_CONTAINER_WIDTH = 1400
const MIN_BROWSER_WIDTH = 320
/** 左侧编辑器至少留这么宽，浏览器面板不能把它挤没 */
const MIN_EDITOR_WIDTH = 220

/** 运行日志：默认高度 / 最小高度 / 拖高时给编辑器保留的最小高度 */
const LOG_DEFAULT_HEIGHT = 160
const LOG_MIN_HEIGHT = 48
const MIN_EDITOR_HEIGHT = 160

interface LogLine {
  id: number
  level: BrowserLogLevel
  message: string
  at: number
}

/**
 * 自动化脚本页（主区域）：左侧脚本编辑器、右侧浏览器面板、底部运行日志。
 *
 * 浏览器会话 id 就是标签 id（`automation-<scriptId>`）—— 一个脚本一份会话，
 * 关标签即关会话，两者用同一个标识，不必再维护映射表。
 */
export function AutomationPage({ scriptId }: { scriptId: string }): React.ReactElement {
  const script = useAppStore((s) => s.automationScripts.find((x) => x.id === scriptId))
  const saveScript = useAppStore((s) => s.saveAutomationScript)
  const updatePanelTabTitle = useAppStore((s) => s.updatePanelTabTitle)
  const setEditorSaveStatus = useAppStore((s) => s.setEditorSaveStatus)

  const sessionId = `automation-${scriptId}`

  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [startUrl, setStartUrl] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [browserState, setBrowserState] = useState<BrowserSessionState | null>(null)
  const [mode, setMode] = useState<BrowserViewportMode>(DEFAULT_BROWSER_VIEWPORT)
  /** 用户拖过分隔条之后的宽度；null = 还没拖过，按 3:1 比例算 */
  const [userBrowserWidth, setUserBrowserWidth] = useState<number | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  /** 主体容器高度：用来钳制「运行日志」的最大高度（编辑器要留够） */
  const [containerHeight, setContainerHeight] = useState(0)
  /** 运行日志面板高度 / 是否折叠 */
  const [logHeight, setLogHeight] = useState(LOG_DEFAULT_HEIGHT)
  const [logCollapsed, setLogCollapsed] = useState(false)
  const [opening, setOpening] = useState(false)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  /** 编辑器句柄：插入片段要拿到光标位置，只能由编辑器实例侧提供 */
  const editorApiRef = useRef<MonacoEditorHandle | null>(null)

  /** 「插入」下拉：分组列出等待类片段（数据见 script-snippets.ts） */
  const insertMenuItems: MenuProps['items'] = INSERT_SNIPPET_GROUPS.map((g) => ({
    key: g.key,
    type: 'group' as const,
    label: g.label,
    children: g.items.map((it) => ({ key: it.key, label: it.label }))
  }))
  const handleInsert: MenuProps['onClick'] = ({ key }) => {
    const item = findSnippet(key)
    if (item) editorApiRef.current?.insertSnippet(item.code)
  }

  // 每次渲染同步最新草稿，供防抖定时器 / 事件回调读取
  const draftRef = useRef({ name, code, startUrl })
  draftRef.current = { name, code, startUrl }
  const idRef = useRef(scriptId)
  idRef.current = scriptId

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 录制期间累积的代码行：added 追加、updated 替换最后一行 */
  const recordLinesRef = useRef<string[]>([])
  /** 录制开始时编辑器里已有的内容，新动作接在它后面 */
  const recordingBaseRef = useRef('')
  const logIdRef = useRef(0)

  // -------------------------------------------------------------------
  // 日志
  // -------------------------------------------------------------------
  const appendLog = useCallback((level: BrowserLogLevel, msg: string) => {
    setLogs((prev) => {
      const next = [...prev, { id: ++logIdRef.current, level, message: msg, at: Date.now() }]
      return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next
    })
  }, [])

  // 日志面板自动贴底（折叠时 ref 为空；展开后要重新贴一次底）
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, logCollapsed])

  // -------------------------------------------------------------------
  // 草稿 / 保存
  // -------------------------------------------------------------------
  const doSave = useCallback(
    async (d: { name: string; code: string; startUrl: string }): Promise<void> => {
      setSaving(true)
      try {
        await saveScript({
          id: scriptId,
          name: d.name.trim() || '未命名脚本',
          code: d.code,
          startUrl: d.startUrl.trim() || undefined,
          createdAt: 0,
          updatedAt: 0
        })
        setDirty(false)
      } catch (e) {
        message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setSaving(false)
      }
    },
    [scriptId, saveScript]
  )
  const doSaveRef = useRef(doSave)
  doSaveRef.current = doSave

  /**
   * 标记有未保存改动。
   * `defer` 用于录制过程：录制中代码每来一个动作就变一次，逐次落盘既没必要
   * 也写得太频，统一等停止录制时存一次。
   */
  const markDirty = (defer = false): void => {
    setDirty(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    if (defer) return
    timerRef.current = setTimeout(() => void doSaveRef.current(draftRef.current), AUTOSAVE_DELAY)
  }
  const markDirtyRef = useRef(markDirty)
  markDirtyRef.current = markDirty

  // 切换脚本：重置草稿（先冲刷上一个脚本的待保存内容）
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const prevId = idRef.current
    if (prevId !== scriptId) {
      const prev = useAppStore.getState().automationScripts.find((s) => s.id === prevId)
      if (prev) void doSaveRef.current(draftRef.current)
    }
    const target = useAppStore.getState().automationScripts.find((s) => s.id === scriptId)
    setName(target?.name ?? '')
    setCode(target?.code ?? '')
    setStartUrl(target?.startUrl ?? '')
    setDirty(false)
    setLogs([])
  }, [scriptId])

  // 关闭标签时冲刷未保存内容（脚本已被删除则跳过，别把它写回去）
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      const id = idRef.current
      const exists = useAppStore.getState().automationScripts.some((s) => s.id === id)
      if (exists) void doSaveRef.current(draftRef.current)
    }
  }, [])

  // Ctrl/Cmd+S 立即保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void doSaveRef.current(draftRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 保存状态投影到底部状态栏
  useEffect(() => {
    setEditorSaveStatus(
      editorSaveKey('script', scriptId),
      saving ? 'saving' : dirty ? 'dirty' : 'saved'
    )
  }, [scriptId, saving, dirty, setEditorSaveStatus])

  // -------------------------------------------------------------------
  // 录制事件
  // -------------------------------------------------------------------
  const handleRecord = useCallback(
    (e: BrowserRecordEvent) => {
      if (e.kind === 'signal') {
        appendLog('info', `[信号] ${e.action}${e.code ? ` ${e.code.trim()}` : ''}`)
        return
      }
      const lines = recordLinesRef.current
      const text = e.code.replace(/\s+$/, '')
      if (e.kind === 'added') lines.push(text)
      else if (lines.length > 0) lines[lines.length - 1] = text
      else lines.push(text)

      const base = recordingBaseRef.current.replace(/\s+$/, '')
      const merged = base ? `${base}\n${lines.join('\n')}` : lines.join('\n')
      setCode(merged)
      markDirtyRef.current(true)
    },
    [appendLog]
  )

  // -------------------------------------------------------------------
  // 订阅浏览器事件
  // -------------------------------------------------------------------
  const recordRef = useRef(handleRecord)
  recordRef.current = handleRecord

  useEffect(() => {
    const offs = [
      window.api.browser.onState((s) => {
        if (s.sessionId !== sessionId) return
        setBrowserState(s)
      }),
      window.api.browser.onLog((l: BrowserLogEvent) => {
        if (l.sessionId !== sessionId) return
        appendLog(l.level, l.message)
      }),
      window.api.browser.onRecord((e) => {
        if (e.sessionId !== sessionId) return
        recordRef.current(e)
      }),
      window.api.browser.onClosed((p) => {
        if (p.sessionId !== sessionId) return
        setBrowserState(null)
        appendLog('info', `浏览器已关闭：${p.reason}`)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [sessionId, appendLog])

  // 容器尺寸：宽度用来算 3:1 的默认宽度与钳制浏览器面板上限，
  // 高度用来钳制「运行日志」的拖拽上限（编辑器要留够）
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const apply = (): void => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0) setContainerWidth(rect.width)
      if (rect.height > 0) setContainerHeight(rect.height)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // -------------------------------------------------------------------
  // 浏览器控制
  // -------------------------------------------------------------------
  const ensureBrowser = useCallback(async (): Promise<boolean> => {
    if (browserState) return true
    setOpening(true)
    try {
      await window.api.browser.open({ sessionId, url: startUrl.trim() || undefined, mode })
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendLog('error', `打开浏览器失败：${msg}`)
      message.error(`打开浏览器失败：${msg}`)
      return false
    } finally {
      setOpening(false)
    }
  }, [browserState, sessionId, startUrl, mode, appendLog])

  const recording = browserState?.recording ?? false
  const running = browserState?.running ?? false

  const toggleRecord = async (): Promise<void> => {
    if (recording) {
      await window.api.browser.stopRecord(sessionId)
      // 录制期间刻意不落盘，停在这里统一存一次
      void doSaveRef.current(draftRef.current)
      return
    }
    if (!(await ensureBrowser())) return
    recordingBaseRef.current = draftRef.current.code
    recordLinesRef.current = []
    try {
      await window.api.browser.startRecord(sessionId)
      appendLog('info', '开始录制：在右侧浏览器里操作，脚本会实时生成')
    } catch (e) {
      message.error(`开始录制失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const run = async (): Promise<void> => {
    if (!draftRef.current.code.trim()) {
      message.warning('脚本是空的，先录制或写点东西')
      return
    }
    if (!(await ensureBrowser())) return
    await doSaveRef.current(draftRef.current)
    // 运行日志（每步 / 结果）由主进程广播，这里不再重复
    await window.api.browser.run(sessionId, draftRef.current.code, mode)
  }

  const stop = async (): Promise<void> => {
    await window.api.browser.abort(sessionId)
  }

  // 浏览器面板宽度：没拖过就是容器的 3/4，拖过就用拖的值，两种都钳进上下限
  const effectiveContainer = containerWidth > 0 ? containerWidth : FALLBACK_CONTAINER_WIDTH
  const maxBrowserWidth = Math.max(MIN_BROWSER_WIDTH, effectiveContainer - MIN_EDITOR_WIDTH)
  const browserWidth = Math.round(
    Math.min(
      maxBrowserWidth,
      Math.max(MIN_BROWSER_WIDTH, userBrowserWidth ?? effectiveContainer * BROWSER_WIDTH_RATIO)
    )
  )
  // 运行日志最大高度：容器高度扣掉给编辑器保留的最小高度（容器还没量到就按 800 估）
  const maxLogHeight = Math.max(
    LOG_MIN_HEIGHT,
    (containerHeight > 0 ? containerHeight : 800) - MIN_EDITOR_HEIGHT
  )

  if (!script) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        脚本已不存在
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            updatePanelTabTitle(`automation-${scriptId}`, e.target.value.trim() || '未命名脚本')
            markDirty()
          }}
          placeholder="脚本名称"
          variant="borderless"
          className="min-w-0 flex-1 text-[15px] font-semibold"
        />
        {/*
          ⚠️ 宽度必须写在**外层 div** 上，不能直接给 Input 加 `w-56`：
          antd 的 `.ant-input { width: 100% }` 是 cssinjs 运行时注入的**非 @layer** 样式，
          优先级高于 Tailwind 的 `@layer utilities` —— 实测给 Input 写 `w-56` 计算宽度仍是 951px，
          再叠上 `shrink-0` 就把右边的「保存 / 录制 / 运行」整组挤出容器（按钮直接看不见）。
        */}
        <div className="w-56 shrink-0">
          <Input
            value={startUrl}
            onChange={(e) => {
              setStartUrl(e.target.value)
              markDirty()
            }}
            placeholder="起始地址（可选）"
            size="small"
            className="text-xs"
          />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Tooltip title="保存（Ctrl+S）">
            <Button
              type="text"
              size="small"
              loading={saving}
              onClick={() => void doSaveRef.current(draftRef.current)}
              icon={<Save className="size-3.5" />}
            />
          </Tooltip>
          <Tooltip
            title={recording ? '停止录制' : '开始录制：在右侧浏览器里操作，自动生成脚本'}
          >
            <Button
              size="small"
              type={recording ? 'primary' : 'default'}
              danger={recording}
              loading={opening}
              disabled={running}
              onClick={() => void toggleRecord()}
              icon={
                recording ? (
                  <Square className="size-3.5" />
                ) : (
                  <Circle className="size-3.5 fill-current" />
                )
              }
            >
              {recording ? '停止录制' : '录制'}
            </Button>
          </Tooltip>
          {running ? (
            <Button size="small" danger onClick={() => void stop()} icon={<Square className="size-3.5" />}>
              停止
            </Button>
          ) : (
            <Tooltip title="运行脚本（浏览器没打开会自动打开）">
              <Button
                size="small"
                type="primary"
                disabled={recording}
                loading={opening}
                onClick={() => void run()}
                icon={<Play className="size-3.5" />}
              >
                运行
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* 主体：左编辑器 + 右浏览器 */}
      <div ref={bodyRef} className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <MonacoEditor
              value={code}
              onChange={(v) => {
                setCode(v)
                markDirty()
              }}
              language="javascript"
              apiRef={editorApiRef}
              showLineNumbersToggle
              defaultShowLineNumbers={false}
              showWordWrapToggle
              // 「插入」放在编辑器自己的工具条里（贴着行号/换行开关），而不是页面顶栏 ——
              // 它操作的是编辑器内容，位置就近才符合直觉
              toolbar={
                <Dropdown menu={{ items: insertMenuItems, onClick: handleInsert }} trigger={['click']}>
                  <Button
                    type="text"
                    size="small"
                    icon={<Plus className="size-3" />}
                    className="text-muted-foreground"
                    title="在光标处插入代码片段（等待等）"
                    // 按下时不转移焦点：编辑器保持焦点，插入后可直接继续输入
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    插入
                  </Button>
                </Dropdown>
              }
            />
          </div>

          {/* 运行日志：点标题折叠 / 展开，拖上边缘改高度 */}
          <div className="flex shrink-0 flex-col border-t border-border">
            {!logCollapsed && (
              <ResizeHandle
                orientation="y"
                width={logHeight}
                min={LOG_MIN_HEIGHT}
                max={maxLogHeight}
                onResize={setLogHeight}
                // 面板在拖拽条**下方**：往上拖才是变高
                invert
              />
            )}
            <div className="flex items-center justify-between px-3 py-1">
              <button
                type="button"
                onClick={() => setLogCollapsed((v) => !v)}
                title={logCollapsed ? '展开运行日志' : '折叠运行日志'}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown
                  className={cn('size-3 transition-transform', logCollapsed && '-rotate-90')}
                />
                运行日志
                {logs.length > 0 && (
                  <span className="text-muted-foreground/60">({logs.length})</span>
                )}
              </button>
              <Tooltip title="清空日志">
                <Button
                  type="text"
                  size="small"
                  className="px-1 text-muted-foreground"
                  onClick={() => setLogs([])}
                  icon={<Eraser className="size-3.5" />}
                />
              </Tooltip>
            </div>
            {!logCollapsed && (
              <div
                ref={logRef}
                style={{ height: logHeight }}
                className="min-h-0 shrink-0 overflow-y-auto px-3 pb-2 font-mono text-[12px] leading-relaxed"
              >
                {logs.length === 0 ? (
                  <div className="py-2 text-muted-foreground/50">
                    点「录制」在右侧浏览器里操作，或点「运行」执行脚本。
                  </div>
                ) : (
                  logs.map((l) => (
                    <div
                      key={l.id}
                      className={cn(
                        'whitespace-pre-wrap break-words',
                        l.level === 'error' && 'text-destructive',
                        l.level === 'success' && 'text-emerald-600',
                        l.level === 'step' && 'text-muted-foreground',
                        l.level === 'info' && 'text-foreground'
                      )}
                    >
                      {l.message}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/*
          `invert`：浏览器面板在拖拽条**右侧**，往左拖才是把它拉宽。
          不传这个参数时 delta 取 clientX 的正向增量，拖动方向就是反的。
        */}
        <ResizeHandle
          width={browserWidth}
          min={MIN_BROWSER_WIDTH}
          max={maxBrowserWidth}
          onResize={setUserBrowserWidth}
          invert
        />

        <div style={{ width: browserWidth }} className="shrink-0 border-l border-border">
          <BrowserPane
            sessionId={sessionId}
            startUrl={startUrl.trim() || undefined}
            mode={mode}
            onModeChange={setMode}
            className="h-full"
          />
        </div>
      </div>
    </div>
  )
}
