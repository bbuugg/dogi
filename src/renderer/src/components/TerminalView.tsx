import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import Zmodem from 'zmodem.js'
import { cn } from 'cn'
import type { SessionInfo } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { useIsDarkTheme } from '@/lib/theme'
import { resolveTerminalTheme } from '@/lib/terminal-themes'
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_STEP } from '@/lib/terminal-font'

/** 常见命令词表：即使没有任何历史也能给出首词补全建议 */
const COMMON_COMMANDS = [
  'ls', 'll', 'la', 'pwd', 'cd', 'clear', 'echo', 'cat', 'less', 'more', 'head', 'tail',
  'grep', 'find', 'which', 'where', 'wc', 'sort', 'uniq', 'awk', 'sed', 'cut', 'tr',
  'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'ln', 'chmod', 'chown', 'df', 'du',
  'ps', 'top', 'htop', 'kill', 'pkill', 'jobs', 'bg', 'fg', 'nohup', 'screen', 'tmux',
  'git', 'git status', 'git log', 'git diff', 'git add', 'git commit', 'git push', 'git pull', 'git checkout', 'git branch', 'git clone', 'git stash',
  'docker', 'docker ps', 'docker compose', 'kubectl', 'helm', 'terraform',
  'ssh', 'scp', 'rsync', 'ftp', 'sftp', 'telnet', 'curl', 'wget', 'ping', 'netstat', 'ss', 'ip', 'ifconfig',
  'vim', 'nvim', 'nano', 'emacs', 'code', 'open',
  'sudo', 'su', 'whoami', 'id', 'uname', 'uptime', 'date', 'env', 'export', 'source',
  'python', 'python3', 'pip', 'pip3', 'node', 'npm', 'npx', 'yarn', 'pnpm', 'go', 'cargo', 'rustc', 'java', 'javac',
  'systemctl', 'service', 'journalctl', 'crontab', 'useradd', 'usermod',
  'sqlite3', 'mysql', 'psql', 'mongosh', 'redis-cli',
  'tar', 'zip', 'unzip', 'gzip', 'xz', 'rzsz', 'sz', 'rz',
  'history', 'alias', 'type', 'man', 'help', 'exit', 'logout', 'reboot', 'shutdown'
]

/** 调整终端字号（Ctrl+滚轮 / Ctrl +/-）；'reset' 恢复默认 */
function adjustTerminalFontSize(delta: number | 'reset'): void {
  const store = useAppStore.getState()
  const current = store.preferences.terminalFontSize || TERMINAL_FONT_SIZE_DEFAULT
  const next =
    delta === 'reset' ? TERMINAL_FONT_SIZE_DEFAULT : current + delta * TERMINAL_FONT_SIZE_STEP
  void store.setTerminalFontSize(next)
}

interface TerminalViewProps {
  session: SessionInfo
  isActive: boolean
}

/** ZMODEM 传输（rz/sz）的实时状态，用于展示进度条 */
interface ZmodemState {
  direction: 'upload' | 'download'
  /** 当前文件名 */
  name: string
  /** 提示文案（含状态/路径） */
  text: string
  /** 进度百分比 0-100 */
  progress: number
}

export function TerminalView({ session, isActive }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const isDark = useIsDarkTheme()
  const terminalThemeName = useAppStore((s) => s.preferences.terminalTheme)
  const copyOnSelect = useAppStore((s) => s.preferences.copyOnSelect)
  const terminalFontSize = useAppStore((s) => s.preferences.terminalFontSize)
  // 创建 effect 只跑一次，用 ref 读取最新偏好，避免闭包读到旧值
  const copyOnSelectRef = useRef(copyOnSelect)
  copyOnSelectRef.current = copyOnSelect
  const fontSizeRef = useRef(terminalFontSize)
  fontSizeRef.current = terminalFontSize
  const theme = useMemo(() => resolveTerminalTheme(terminalThemeName, isDark), [
    terminalThemeName,
    isDark
  ])
  // ZMODEM 传输会话（rz/sz）与状态提示
  const zsessionRef = useRef<any>(null)
  const [zmodem, setZmodem] = useState<ZmodemState | null>(null)
  // 命令预测（历史 / 常见命令补全）相关状态
  const commandPrediction = useAppStore((s) => s.preferences.commandPrediction)
  const commandPredictionRef = useRef(commandPrediction)
  commandPredictionRef.current = commandPrediction
  const historyRef = useRef<string[]>([])
  const inputBufferRef = useRef('')
  const suggestionsRef = useRef<string[]>([])
  const activeIndexRef = useRef(0)
  const [suggestions, setSuggestions] = useState<{ items: string[]; index: number } | null>(null)
  // 命令预测下拉框定位（相对终端容器）
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const clearSuggestions = useCallback(() => {
    suggestionsRef.current = []
    activeIndexRef.current = 0
    setSuggestions(null)
  }, [])

  // 接受当前高亮建议：把剩余后缀写入 PTY（等同于正常键入）
  const acceptSuggestion = useCallback(() => {
    const items = suggestionsRef.current
    if (!items.length) return
    const full = items[activeIndexRef.current] ?? items[0]
    const buf = inputBufferRef.current
    const suffix = full.slice(buf.length)
    if (suffix) void window.api.terminal.write(session.id, suffix)
    inputBufferRef.current = full
    clearSuggestions()
  }, [session.id, clearSuggestions])

  // 预测下拉框定位：优先显示在光标下方，空间不足则显示在光标上方
  const positionDropdown = useCallback(() => {
    const term = termRef.current
    const container = containerRef.current
    const box = dropdownRef.current
    if (!term || !container || !box) return
    const buf = term.buffer.active
    const dims: any = (term as any)._core?._renderService?.dimensions
    const cellW = dims?.actualCellWidth ?? container.clientWidth / term.cols
    const cellH = dims?.actualCellHeight ?? container.clientHeight / term.rows
    const x = buf.cursorX * cellW
    const y = buf.cursorY * cellH
    const contW = container.clientWidth
    const contH = container.clientHeight
    const boxW = box.offsetWidth
    const boxH = box.offsetHeight
    const gap = 16
    const left = Math.min(Math.max(x, 0), Math.max(0, contW - boxW))
    const belowTop = y + cellH + gap
    let top = belowTop
    if (belowTop + boxH > contH) {
      const aboveTop = y - gap - boxH
      top = aboveTop >= 0 ? aboveTop : belowTop
    }
    top = Math.min(Math.max(top, 0), Math.max(0, contH - boxH))
    setPos({ top, left })
  }, [])

  // 建议变化时（键入 / 切换）重新定位
  useLayoutEffect(() => {
    if (suggestions) positionDropdown()
  }, [suggestions, positionDropdown])
  // 始终读取最新主题（创建 effect 只跑一次，避免闭包读到旧值）
  const themeRef = useRef(theme)
  themeRef.current = theme

  useEffect(() => {
    const container = containerRef.current
    if (!container || termRef.current) return

    const term = new Terminal({
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: fontSizeRef.current ?? TERMINAL_FONT_SIZE_DEFAULT,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: themeRef.current
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // 自定义点击处理：仅当按住 Ctrl（mac 为 Cmd）点击时才打开链接，
    // 普通点击不触发，避免误触；打开时交给主进程按安全协议过滤（http(s)/mailto/file），
    // 避免未知协议（ssh://、vscode:// 等）触发系统"需要新应用"的弹窗
    term.loadAddon(
      new WebLinksAddon((event: MouseEvent, link: string) => {
        if (!event.ctrlKey && !event.metaKey) return
        void window.api.app.openExternal(link)
      })
    )
    term.open(container)
    try {
      fit.fit()
    } catch {
      // 隐藏容器首次 fit 可能失败
    }
    void window.api.terminal.resize(session.id, term.cols, term.rows)
    // 首次 fit 时 cell 尺寸可能尚未测量完成（会被 FitAddon 静默跳过，终端停在默认列数，
    // 导致 tmux 等按 80 列绘制、状态条不铺满）。订阅 CharSizeService 的尺寸变化，
    // 测量一就绪就重新适配，并把新尺寸同步给 PTY。
    const charSizeDisp = (term as any)._core?._charSizeService?.onCharSizeChange?.(() => {
      try {
        fit.fit()
      } catch {
        return
      }
      void window.api.terminal.resize(session.id, term.cols, term.rows)
    })
    // Ctrl + 鼠标滚轮：缩放终端文字（返回 false 阻止 xterm 内置滚动）
    term.attachCustomWheelEventHandler((e) => {
      if (!e.ctrlKey) return true
      e.preventDefault()
      adjustTerminalFontSize(e.deltaY < 0 ? 1 : -1)
      return false
    })
    // Ctrl + + / - / 0：放大 / 缩小 / 复位（返回 false 阻止按键发往 PTY）
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true
      const isPlus = e.key === '=' || e.key === '+'
      const isMinus = e.key === '-' || e.key === '_'
      if (!isPlus && !isMinus && e.key !== '0') return true
      e.preventDefault()
      if (isPlus) adjustTerminalFontSize(1)
      else if (isMinus) adjustTerminalFontSize(-1)
      else adjustTerminalFontSize('reset')
      return false
    })
    // ZMODEM 传输结束时的清理（终止会话引用、收起提示）
    const endSession = () => {
      zsessionRef.current = null
      setZmodem(null)
    }
    // 上传（远端执行了 rz）：弹出文件选择，逐文件发送，并实时上报进度
    const handleUpload = async (zsession: any) => {
      try {
        term.blur()
        const files = await window.api.zmodem.pickFiles()
        if (!files.length) {
          try {
            zsession.abort()
          } catch {
            // 忽略
          }
          endSession()
          return
        }
        const CHUNK = 8192
        for (const f of files) {
          setZmodem({ direction: 'upload', name: f.name, text: `上传中：${f.name}`, progress: 0 })
          const xfer = await zsession.send_offer({
            name: f.name,
            size: f.size,
            mtime: new Date()
          })
          if (!xfer) continue
          const total = f.data.byteLength
          let sent = 0
          let last = 0
          for (let off = 0; off < total; off += CHUNK) {
            const chunk = f.data.subarray(off, Math.min(off + CHUNK, total))
            xfer.send(chunk)
            sent += chunk.length
            const now = performance.now()
            if (sent === total || now - last > 120) {
              last = now
              setZmodem((p) => (p ? { ...p, progress: (sent / total) * 100 } : p))
            }
          }
          await xfer.end(new Uint8Array(0))
        }
        await zsession.close()
      } catch (e) {
        console.error('zmodem upload failed', e)
      } finally {
        endSession()
        term.focus()
      }
    }
    // zmodem.js Sentry：扫描所有入站字节，识别 rz/sz 的 ZMODEM 会话
    const zterm = new Zmodem.Sentry({
      to_terminal: (octets: number[]) => {
        try {
          term.write(new Uint8Array(octets))
        } catch {
          // 忽略
        }
      },
      sender: (octets: number[] | Uint8Array) => {
        const bytes = octets instanceof Uint8Array ? octets : new Uint8Array(octets)
        void window.api.terminal.write(session.id, bytes)
      },
      on_detect: (detection: any) => {
        let zsession: any
        try {
          zsession = detection.confirm()
        } catch {
          return
        }
        zsessionRef.current = zsession
        setZmodem({
          direction: zsession.type === 'send' ? 'upload' : 'download',
          name: '',
          text:
            zsession.type === 'send'
              ? 'ZMODEM 上传：请选择要发送的文件'
              : 'ZMODEM 下载中…',
          progress: 0
        })
        if (zsession.type === 'send') {
          void handleUpload(zsession)
        } else {
          zsession.on('offer', async (offer: any) => {
            const details = (offer.get_details && offer.get_details()) || {}
            const rawName: string = details.name || 'file'
            const size: number = typeof details.size === 'number' ? details.size : 0
            // 仅用于对话框默认名：去掉目录分隔符与控制字符，避免被当作路径
            const safeName =
              rawName.replace(/[\\/]/g, '_').replace(/[ -]/g, '').trim() || 'file'
            setZmodem({ direction: 'download', name: rawName, text: `下载中：${rawName}`, progress: 0 })
            // 先选保存位置，再开始下载
            const filePath = await window.api.zmodem.askSavePath(safeName)
            if (!filePath) {
              try {
                offer.skip()
              } catch {
                // 忽略
              }
              return
            }
            let downloaded = 0
            let last = 0
            offer.on('input', (payload: Uint8Array) => {
              downloaded += payload.byteLength
              if (!size) return
              const now = performance.now()
              if (downloaded >= size || now - last > 120) {
                last = now
                setZmodem((p) =>
                  p ? { ...p, progress: Math.min(100, (downloaded / size) * 100) } : p
                )
              }
            })
            try {
              const spool = (await offer.accept()) as Uint8Array[]
              const total = spool.reduce((a: number, p: Uint8Array) => a + p.byteLength, 0)
              const merged = new Uint8Array(total)
              let off = 0
              for (const p of spool) {
                merged.set(p, off)
                off += p.byteLength
              }
              await window.api.zmodem.saveFileTo(filePath, merged)
              setZmodem((p) => (p ? { ...p, progress: 100, text: `已保存：${filePath}` } : p))
            } catch (e) {
              console.error('zmodem receive failed', e)
            }
          })
          zsession.on('session_end', () => endSession())
          zsession.start()
        }
      },
      on_retract: () => {}
    })

    // ---------- 命令预测：历史 / 常见命令补全 ----------
    const recompute = () => {
      if (!commandPredictionRef.current) {
        clearSuggestions()
        return
      }
      const buf = inputBufferRef.current
      const trimmed = buf.trimEnd()
      const items: string[] = []
      if (trimmed) {
        const tokens = trimmed.split(/\s+/)
        const firstTokenOnly = tokens.length === 1
        const seen = new Set<string>()
        const pool = [...historyRef.current, ...COMMON_COMMANDS]
        for (const cmd of pool) {
          if (!cmd || cmd.length <= trimmed.length) continue
          // 整行前缀匹配（含子命令补全，来自历史或常见命令）
          if (cmd.startsWith(trimmed)) {
            if (!seen.has(cmd)) {
              seen.add(cmd)
              items.push(cmd)
            }
            continue
          }
          // 仅输入首个词时，按首词前缀补充更多命令
          if (firstTokenOnly) {
            const head = cmd.split(/\s+/)[0]
            if (
              head.startsWith(tokens[0]) &&
              head.length > tokens[0].length &&
              !seen.has(head)
            ) {
              seen.add(head)
              items.push(head)
            }
          }
        }
      }
      // 排序：历史更近的优先，其次按长度升序
      items.sort((a, b) => {
        const ia = historyRef.current.indexOf(a)
        const ib = historyRef.current.indexOf(b)
        if (ia !== -1 && ib !== -1) return ia - ib
        if (ia !== -1) return -1
        if (ib !== -1) return 1
        return a.length - b.length
      })
      const top = items.slice(0, 8)
      suggestionsRef.current = top
      activeIndexRef.current = 0
      setSuggestions(top.length ? { items: top, index: 0 } : null)
    }
    const pushHistory = (cmd: string) => {
      const h = historyRef.current
      const i = h.indexOf(cmd)
      if (i !== -1) h.splice(i, 1)
      h.unshift(cmd)
      if (h.length > 200) h.length = 200
    }
    const moveActive = (dir: number) => {
      const n = suggestionsRef.current.length
      if (!n) return
      activeIndexRef.current = (activeIndexRef.current + dir + n) % n
      setSuggestions({ items: suggestionsRef.current, index: activeIndexRef.current })
    }
    const updateInputBuffer = (data: string) => {
      if (data === '\r' || data === '\n') {
        const cmd = inputBufferRef.current.trim()
        if (cmd) pushHistory(cmd)
        inputBufferRef.current = ''
        clearSuggestions()
        return
      }
      if (data === '\x7f' || data === '\x08') {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1)
        recompute()
        return
      }
      if (data === '\x03') {
        inputBufferRef.current = ''
        clearSuggestions()
        return
      }
      // 转义序列（方向键 / 功能键等）会让本地缓冲与 shell 错位，重置追踪
      if (data.startsWith('\x1b') || data.includes('\x1b')) {
        inputBufferRef.current = ''
        clearSuggestions()
        return
      }
      inputBufferRef.current += data
      recompute()
    }

    term.onData((data) => {
      // 会话已结束：拦截回车重连 / Ctrl+D 关闭标签，其余按键吞掉（对齐 Web 终端重连逻辑）
      if (exitedRef.current) {
        if (!actionRef.current) {
          actionRef.current = true
          if (data === '\r') {
            term.write('\r\n\x1b[36m● 正在重连…\x1b[0m\r\n')
            void useAppStore.getState().reconnectSession(session.id)
          } else if (data === '\x04') {
            void useAppStore.getState().closeSession(session.id)
          }
        }
        return
      }
      // ZMODEM 传输期间禁用手动输入，避免破坏协议
      if (zsessionRef.current) return
      // 预测下拉开启时拦截导航 / 接受键（不转发给 PTY，避免与 shell 行编辑冲突）
      if (suggestionsRef.current.length > 0) {
        if (data === '\t') {
          acceptSuggestion()
          return
        }
        if (data === '\x1b[B') {
          moveActive(1)
          return
        }
        if (data === '\x1b[A') {
          moveActive(-1)
          return
        }
        if (data === '\x1b[C') {
          acceptSuggestion()
          return
        }
      }
      updateInputBuffer(data)
      void window.api.terminal.write(session.id, data)
    })
    // 选中文本即复制到剪贴板（可在终端设置中开关）
    term.onSelectionChange(() => {
      if (!copyOnSelectRef.current) return
      const sel = term.getSelection()
      if (!sel) return
      navigator.clipboard?.writeText(sel).catch(() => {})
    })
    termRef.current = term
    fitRef.current = fit

    const unsubscribeData = window.api.terminal.onData(({ sessionId, data }) => {
      if (sessionId !== session.id) return
      // 交给 zmodem.js 解析；非 ZMODEM 字节会回送 to_terminal 正常渲染
      try {
        zterm.consume(data)
      } catch {
        term.write(data)
      }
    })

    const resizeObserver = new ResizeObserver(() => {
      if (container.offsetParent === null) return // 隐藏时跳过
      try {
        fit.fit()
      } catch {
        return
      }
      void window.api.terminal.resize(session.id, term.cols, term.rows)
      positionDropdown()
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      charSizeDisp?.dispose?.()
      unsubscribeData()
      zsessionRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // isDark 仅决定初始主题；运行中切换由下方 effect 热更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // 主题/配色切换时热更新终端
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = theme
  }, [theme])

  // 字号变化（Ctrl+滚轮 / Ctrl +/-）：热更新并重新适配，同时把新尺寸同步给 PTY
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    if (term.options.fontSize === terminalFontSize) return
    term.options.fontSize = terminalFontSize
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        return
      }
      void window.api.terminal.resize(session.id, term.cols, term.rows)
    })
  }, [terminalFontSize, session.id])

  // 激活时重新适配尺寸并聚焦
  useEffect(() => {
    if (!isActive) return
    const fit = fitRef.current
    const term = termRef.current
    if (!fit || !term) return
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        // 忽略
      }
      void window.api.terminal.resize(session.id, term.cols, term.rows)
      term.focus()
    })
  }, [isActive, session.id])

  // AI 面板显隐会改变终端可用宽度，主动重新适配，避免关闭面板后终端仍停留在旧（较窄）宽度
  const aiPanelOpen = useAppStore((s) => s.ui.aiPanelOpen)
  useEffect(() => {
    if (!isActive) return
    const raf = requestAnimationFrame(() => {
      const fit = fitRef.current
      const term = termRef.current
      if (!fit || !term) return
      try {
        fit.fit()
      } catch {
        return
      }
      void window.api.terminal.resize(session.id, term.cols, term.rows)
    })
    return () => cancelAnimationFrame(raf)
  }, [aiPanelOpen, isActive, session.id])

  // 初始化时布局/字体测量可能尚未稳定，首次 fit 会因 cell 尺寸为 0 而被跳过（终端停在默认列数，右侧留白）；
  // 待布局与字体就绪后再补适配，保证一打开就铺满，无需手动切换面板触发。
  useEffect(() => {
    if (!isActive) return
    let alive = true
    const refit = () => {
      if (!alive) return
      const fit = fitRef.current
      const term = termRef.current
      if (!fit || !term) return
      try {
        fit.fit()
      } catch {
        return
      }
      void window.api.terminal.resize(session.id, term.cols, term.rows)
    }
    const timers = [0, 80, 250, 600, 1200, 2000].map((ms) => window.setTimeout(refit, ms))
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(refit)
    }
    return () => {
      alive = false
      timers.forEach((t) => window.clearTimeout(t))
    }
  }, [isActive, session.id])

  const exited = useAppStore((s) => s.exitedSessions.has(session.id))
  // 镜像最新“已结束”状态，供 onData 回调（创建时只绑定一次）读取
  const exitedRef = useRef(exited)
  exitedRef.current = exited
  // 重连/关闭动作只触发一次，避免连按产生多个会话
  const actionRef = useRef(false)
  // 会话结束后：把提示直接写进终端（对齐 Web 端子做法，不再弹浮层），并聚焦以接收回车重连 / Ctrl+D 关闭
  const exitNoticeRef = useRef(false)
  useEffect(() => {
    if (!exited) {
      exitNoticeRef.current = false
      return
    }
    const term = termRef.current
    term?.focus()
    if (!term || exitNoticeRef.current) return
    exitNoticeRef.current = true
    term.write(`\r\n\x1b[33m● 会话已结束（${session.title}）\x1b[0m\r\n`)
    term.write('\x1b[90m  按 Enter 重连 · 按 Ctrl+D 关闭标签\x1b[0m\r\n')
  }, [exited, session.title])

  return (
    <div className="relative h-full w-full" style={{ backgroundColor: theme.background }}>
      <div ref={containerRef} className="h-full w-full" />
      {zmodem && (
        <div className="absolute left-1/2 top-3 z-10 w-72 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground shadow">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="truncate font-medium">
              {zmodem.direction === 'upload' ? '↑ 上传' : '↓ 下载'}：{zmodem.name || '…'}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {Math.round(zmodem.progress)}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-150',
                zmodem.direction === 'upload' ? 'bg-emerald-500' : 'bg-sky-500'
              )}
              style={{ width: `${zmodem.progress}%` }}
            />
          </div>
          <div className="mt-1 truncate text-[10px] text-muted-foreground">{zmodem.text}</div>
        </div>
      )}
      {suggestions && (
        <div
          ref={dropdownRef}
          style={pos ? { top: pos.top, left: pos.left } : undefined}
          className="absolute z-10 max-h-56 w-80 overflow-y-auto rounded-md border border-border bg-popover/95 p-1 text-xs shadow-lg backdrop-blur">
          <div className="px-2 py-1 text-[10px] text-muted-foreground">
            命令预测 · Tab/→ 接受 · ↑/↓ 切换 · Esc 关闭
          </div>
          {suggestions.items.map((item, i) => {
            const buf = inputBufferRef.current
            const rest = item.slice(buf.length)
            return (
              <button
                key={item}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  activeIndexRef.current = i
                  acceptSuggestion()
                }}
                className={cn(
                  'flex w-full items-center gap-1 rounded px-2 py-1 text-left',
                  i === suggestions.index
                    ? 'bg-primary/15 text-foreground'
                    : 'text-muted-foreground hover:bg-secondary'
                )}
              >
                <span className="truncate">{buf}</span>
                <span className="truncate font-medium text-primary">{rest}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
