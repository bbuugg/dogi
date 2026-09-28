import { useIsDarkTheme } from '@/shared/lib/theme'
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import { useEffect, useRef, useState } from 'react'
import './VditorEditor.css'

/**
 * Vditor 静态资源目录（由 scripts/copy-vditor.cjs 拷贝到 public/vditor/dist）。
 * Vditor 会按 `${cdn}/dist/js/...` 动态插 <script> 加载 lute / 图标 / i18n / 代码高亮，
 * 不给它就会去 unpkg 拉 —— 桌面端要能离线用。dev 走服务器根路径；打包后页面在
 * file:// 下，用相对路径（与 MonacoEditor 的 loader.config 同款约定）。
 */
const VDITOR_CDN = import.meta.env.DEV ? '/vditor' : './vditor'

/** 代码块高亮主题：跟随明暗（两个都在 dist/js/highlight.js/styles 里） */
const CODE_THEME = { light: 'github', dark: 'github-dark' }

/** 图标集与 Vditor 认的脚本 id（它靠这个 id 判断「图标已经加载过」） */
const ICON_NAME = 'ant'
const ICON_SCRIPT_ID = 'vditorIconScript'
const ICON_URL = `${VDITOR_CDN}/dist/js/icons/${ICON_NAME}.js`

/**
 * 确保工具栏图标就绪。
 *
 * 为什么不能交给 Vditor 自己加载：它用 `addScriptSync` 把 icons/ant.js 读成字符串后当
 * **内联脚本**插进 `<head>`，而本项目 CSP 是 `script-src 'self' blob:` —— 内联脚本会被直接
 * 拦下，表现是工具栏只剩一排分隔线、一个图标都没有（文档里 `<symbol>` 数为 0）。
 * 这里改成用 `<script src>`（同源，CSP 放行）自行加载，并占用 Vditor 认的那个 id，
 * 它的 `addScriptSync` 看到 id 已存在就返回，不会再走内联那条路（也省掉一次同步读文件）。
 *
 * ant.js 是把 `<symbol>` 插到 `document.body` 上的，而 Vditor 的 `destroy()` 只删 script
 * 标签、不动那些 symbols，所以按 symbols 判重，切走再切回时不会重复插入。
 */
function ensureVditorIcons(): Promise<void> {
  if (document.querySelector('symbol[id^="vditor-icon-"]')) {
    // symbols 已在（多半是上一个编辑器实例注入的、只是 script 标签被 destroy 删了）：补个占位标签
    if (!document.getElementById(ICON_SCRIPT_ID)) {
      const stub = document.createElement('script')
      stub.id = ICON_SCRIPT_ID
      document.head.appendChild(stub)
    }
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const script = document.createElement('script')
    script.id = ICON_SCRIPT_ID
    script.src = ICON_URL
    // 加载失败也让编辑器照常初始化（只是没图标），不要把笔记正文功能一起拖死
    script.onload = () => resolve()
    script.onerror = () => resolve()
    document.head.appendChild(script)
  })
}

/** 工具栏：默认工具栏去掉 upload / record / devtools —— 笔记没接上传与录制，留着是坏按钮 */
const TOOLBAR = [
  'emoji',
  'headings',
  'bold',
  'italic',
  'strike',
  'link',
  '|',
  'list',
  'ordered-list',
  'check',
  'outdent',
  'indent',
  '|',
  'quote',
  'line',
  'code',
  'inline-code',
  'insert-before',
  'insert-after',
  '|',
  'table',
  '|',
  'undo',
  'redo',
  '|',
  'fullscreen',
  'edit-mode',
  {
    name: 'more',
    toolbar: ['both', 'code-theme', 'content-theme', 'export', 'outline', 'preview']
  }
]

interface VditorEditorProps {
  /** Markdown 正文。外部传入新值（切笔记 / 导入文件）时会重置编辑器内容与撤销栈 */
  value: string
  onChange: (value: string) => void
}

/**
 * 笔记正文编辑器：Vditor 即时渲染（ir）模式。
 *
 * 整个生命周期只建**一个** Vditor 实例：切笔记不重建编辑器，而是 `setValue(v, true)`
 * 换内容并清空撤销栈 —— 重建要重新等 lute 资源，还会丢掉工具栏状态。
 * 因此必须分得清「内容是谁改的」（见 currentRef），否则 onChange → setState →
 * setValue → onChange 会绕成回路。
 */
export function VditorEditor({ value, onChange }: VditorEditorProps) {
  const isDark = useIsDarkTheme()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const vditorRef = useRef<Vditor | null>(null)
  /** 初始化完成（资源加载完、DOM 已渲染）—— 在此之前 setValue / setTheme 都不生效 */
  const [ready, setReady] = useState(false)

  /** 回调与「最新值」都经 ref 取：建实例的 effect 只跑一次，不能闭包住首次渲染的那份 */
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const valueRef = useRef(value)
  valueRef.current = value
  const isDarkRef = useRef(isDark)
  isDarkRef.current = isDark
  /**
   * 编辑器当前内容的真源：由编辑器自身产出（用户输入）或由我们同步进去。
   * 只有外部传来的 value 与它不一致，才说明「内容是从外面换的」，需要 setValue。
   */
  const currentRef = useRef(value)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let vditor: Vditor | null = null
    let cancelled = false

    /**
     * 等图标就绪再建实例。顺带承担「延迟到不在渲染阶段创建」的作用：
     * StrictMode 下 effect 是「执行 → 立刻清理 → 再执行」，而 Vditor 初始化是异步的
     * （等 lute 加载完才建 DOM）。同步创建的实例被 destroy 后，它挂起的初始化仍会往同一个
     * 宿主节点里再建一套 DOM（initUI 还会先清空节点），表现是工具栏 / 编辑区错乱。
     * 这里放到 promise 回调里创建，第一次挂载的那次就被清理阶段取消了。
     */
    void ensureVditorIcons().then(() => {
      if (cancelled) return
      const dark = isDarkRef.current
      vditor = new Vditor(host, {
        cdn: VDITOR_CDN,
        mode: 'ir',
        height: '100%',
        icon: ICON_NAME,
        theme: dark ? 'dark' : 'classic',
        preview: {
          theme: { current: dark ? 'dark' : 'light' },
          hljs: { style: dark ? CODE_THEME.dark : CODE_THEME.light }
        },
        // 正文由笔记自己持久化，不用 Vditor 的 localStorage 草稿（两处内容会互相覆盖）
        cache: { enable: false },
        placeholder: '开始记录…',
        value: valueRef.current,
        toolbar: TOOLBAR,
        input: (v) => {
          // setValue 也可能触发 input（值相同）；挡掉，免得「切笔记」被记成一次用户编辑
          if (v === currentRef.current) return
          currentRef.current = v
          onChangeRef.current(v)
        },
        after: () => setReady(true)
      })
      vditorRef.current = vditor
    })

    return () => {
      cancelled = true
      vditor?.destroy()
      vditorRef.current = null
      setReady(false)
    }
  }, [])

  /** 主题切换：Vditor 不认 CSS 变量，明暗必须显式通知（含预览内容主题与代码高亮主题） */
  useEffect(() => {
    if (!ready) return
    vditorRef.current?.setTheme(
      isDark ? 'dark' : 'classic',
      isDark ? 'dark' : 'light',
      isDark ? CODE_THEME.dark : CODE_THEME.light
    )
  }, [isDark, ready])

  /** 外部换了内容（切笔记 / 导入）：灌进编辑器并清空撤销栈，否则 Ctrl+Z 会撤回上一篇的内容 */
  useEffect(() => {
    if (!ready) return
    if (value === currentRef.current) return
    currentRef.current = value
    vditorRef.current?.setValue(value, true)
  }, [value, ready])

  return <div ref={hostRef} className="h-full min-h-0" />
}