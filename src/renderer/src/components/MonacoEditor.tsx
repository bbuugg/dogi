import Editor, { loader } from '@monaco-editor/react'
import { Braces, Check, Code, Copy, Download, Hash, Lock, WrapText } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button, Select, Tag } from 'antd'
import { cn } from '@/lib/utils'
import { useIsDarkTheme } from '@/lib/theme'

// ── 本地化 Monaco Editor ─────────────────────────────────────────
// 默认情况下 @monaco-editor/react 会从 CDN（cdn.jsdelivr.net）加载 Monaco 资源。
// 这里通过 loader.config({ paths }) 指向本地静态目录
// （由 scripts/copy-monaco.cjs 从 node_modules/monaco-editor/min 复制到
//  src/renderer/public/monaco-editor），实现完全离线可用。
// dev 用服务器根路径；打包后页面在 file:// 下，用相对路径。
loader.config({
  paths: {
    vs: import.meta.env.DEV ? '/monaco-editor/vs' : './monaco-editor/vs'
  }
})

/** 常用语言列表，用于语言切换下拉框 */
export const MONACO_LANGUAGES = [
  { value: 'plaintext', label: 'Plain Text' },
  { value: 'json', label: 'JSON' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'xml', label: 'XML' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'yaml', label: 'YAML' },
  { value: 'ini', label: 'Properties / INI' },
  { value: 'shell', label: 'Shell' },
  { value: 'sql', label: 'SQL' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'java', label: 'Java' },
  { value: 'cpp', label: 'C++' }
]

/** Monaco 编辑器实例的最小接口（仅用到 getAction / layout） */
type EditorInstance = {
  getAction: (id: string) => { run: () => void } | null
  layout: () => void
} | null

interface MonacoEditorProps {
  value?: string
  onChange?: (value: string) => void
  /** 默认语言，当 showLanguageSelector 为 true 时作为初始值 */
  language?: string
  height?: string | number
  readOnly?: boolean
  /** 是否显示语言切换下拉框，默认 false */
  showLanguageSelector?: boolean
  /** 语言切换时的回调 */
  onLanguageChange?: (language: string) => void
  /** 工具栏左侧自定义内容 */
  toolbar?: ReactNode
  /** 工具栏右侧自定义内容 */
  actions?: ReactNode
  /** 是否显示行号切换按钮 */
  showLineNumbersToggle?: boolean
  /** 是否显示自动换行切换按钮 */
  showWordWrapToggle?: boolean
  /** 是否显示复制按钮 */
  showCopyButton?: boolean
  /** 是否显示下载按钮 */
  showDownloadButton?: boolean
  /** 下载回调 */
  onDownload?: () => void
}

const MonacoEditor: FC<MonacoEditorProps> = ({
  value = '',
  onChange,
  language = 'json',
  height = '100%',
  readOnly = false,
  showLanguageSelector = false,
  onLanguageChange,
  toolbar,
  actions,
  showLineNumbersToggle = false,
  showWordWrapToggle = false,
  showCopyButton = false,
  showDownloadButton = false,
  onDownload
}) => {
  const isDark = useIsDarkTheme()
  const [currentLanguage, setCurrentLanguage] = useState(language)
  const [showLineNumbers, setShowLineNumbers] = useState(true)
  const [wordWrap, setWordWrap] = useState<'on' | 'off'>('on')
  const [copied, setCopied] = useState(false)
  /** 编辑器挂载完成后再显示依赖 editor 实例的按钮 */
  const [mounted, setMounted] = useState(false)

  const editorRef = useRef<EditorInstance>(null)
  /** 编辑器所在容器：自己盯它的尺寸（见下面那个 ResizeObserver 的说明） */
  const containerRef = useRef<HTMLDivElement | null>(null)
  /** 上一次已同步过的容器尺寸，用来避免 layout → 尺寸回调 → layout 的来回触发 */
  const laidOutSize = useRef({ w: 0, h: 0 })

  const handleEditorDidMount = (editor: unknown): void => {
    editorRef.current = editor as EditorInstance
    setMounted(true)
  }

  /**
   * 补一次 `layout()`，把编辑器从 5×5 的保底尺寸拉回容器真实大小。
   *
   * 背景：Monaco 创建时如果容器还是 0×0（藏在 `display:none` 的标签页 / 折叠面板里），
   * 它会把自身尺寸夹到 5×5；之后容器被撑开，**它不会自愈** ——
   * 实测 `automaticLayout` 已经是 `'on'`，手动派发 window resize、来回切页签都不恢复，
   * 必须显式调一次 `editor.layout()`。
   *
   * 这里用「ResizeObserver 主力 + 定时器兜底」两条腿：
   * ResizeObserver 依赖浏览器产出帧才会回调，窗口被遮挡 / 不可见时 Chromium 会
   * 把帧和 RO 一起挂起（实测：现场新建的 RO 连初始回调都不来），而定时器不受影响。
   * 兜底定时器尺寸一对上就自己停掉，不留常驻开销。
   */
  useEffect(() => {
    if (!mounted) return

    /** 容器尺寸和上次不同就补一次 layout；返回「当前尺寸是否已同步」 */
    const syncLayout = (): boolean => {
      const el = containerRef.current
      if (!el) return false
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0 || h <= 0) return false
      if (w === laidOutSize.current.w && h === laidOutSize.current.h) return true
      laidOutSize.current = { w, h }
      editorRef.current?.layout()
      return true
    }

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => void syncLayout())
    if (observer && containerRef.current) observer.observe(containerRef.current)

    const timer = window.setInterval(() => {
      if (syncLayout()) window.clearInterval(timer)
    }, 150)

    return () => {
      observer?.disconnect()
      window.clearInterval(timer)
    }
  }, [mounted])

  const handleFormat = (): void => {
    editorRef.current?.getAction('editor.action.formatDocument')?.run()
  }

  useEffect(() => {
    setCurrentLanguage(language)
  }, [language])

  const handleLanguageChange = (lang: string): void => {
    setCurrentLanguage(lang)
    onLanguageChange?.(lang)
  }

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(value || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 py-1">
        {/* Left side */}
        <div className="flex min-w-0 items-center gap-1.5">
          {showLanguageSelector ? (
            <Select
              value={currentLanguage}
              onChange={handleLanguageChange}
              options={MONACO_LANGUAGES}
              size="small"
              variant="borderless"
              popupMatchSelectWidth={false}
              className="min-w-24 text-xs font-medium"
            />
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-bold tracking-wide text-muted-foreground uppercase">
              <Braces className="size-3" />
              {currentLanguage.toUpperCase()}
            </span>
          )}

          {toolbar}

          {/* Built-in toggles */}
          {showLineNumbersToggle && (
            <Button
              type="text"
              size="small"
              icon={<Hash className="size-3" />}
              className={cn('w-6 p-0 text-muted-foreground', !showLineNumbers && 'opacity-40')}
              onClick={() => setShowLineNumbers((v) => !v)}
              title="切换行号"
          />
          )}
          {showWordWrapToggle && (
            <Button
              type="text"
              size="small"
              icon={<WrapText className="size-3" />}
              className={cn('w-6 p-0 text-muted-foreground', wordWrap === 'off' && 'opacity-40')}
              onClick={() => setWordWrap((w) => (w === 'on' ? 'off' : 'on'))}
              title="切换自动换行"
            />
          )}
        </div>

        {/* Right side */}
        <div className="flex shrink-0 items-center gap-1">
          {actions}

          {!readOnly && mounted && (
            <Button
              type="text"
              size="small"
              icon={<Code className="size-3" />}
              className="w-6 p-0 text-muted-foreground"
              onClick={handleFormat}
              title="格式化"
            />
          )}

          {showCopyButton && (
            <Button
              type="text"
              size="small"
              icon={copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              className="w-6 p-0 text-muted-foreground"
              onClick={handleCopy}
              disabled={!value}
              title="复制"
            />
          )}
          {showDownloadButton && (
            <Button
              type="text"
              size="small"
              icon={<Download className="size-3" />}
              className="w-6 p-0 text-muted-foreground"
              onClick={onDownload}
              disabled={!value}
              title="下载"
            />
          )}

          {readOnly && (
            <Tag
              color="green"
              className="m-0 gap-1 border-0 bg-emerald-500/15 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
            >
              <Lock className="size-2.5" />
              只读
            </Tag>
          )}
        </div>
      </div>

      {/* Editor Area */}
      <div ref={containerRef} className="min-h-0 flex-1">
        <Editor
          height={height}
          language={currentLanguage}
          theme={isDark ? 'vs-dark' : 'vs'}
          value={value}
          onMount={handleEditorDidMount}
          onChange={(v) => onChange?.(v || '')}
          options={{
            fontSize: 13,
            mouseWheelZoom: true,
            minimap: { enabled: false },
            readOnly,
            wordWrap,
            lineNumbers: showLineNumbers ? 'on' : 'off',
            automaticLayout: true,
            scrollBeyondLastLine: false,
            folding: true,
            renderLineHighlight: 'all',
            fontFamily: "'Fira Code', 'Consolas', 'Monaco', 'Courier New', monospace",
            tabSize: 2
          }}
        />
      </div>
    </div>
  )
}

export default MonacoEditor
