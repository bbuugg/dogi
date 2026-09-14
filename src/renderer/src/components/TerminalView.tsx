import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

interface TerminalViewProps {
  session: SessionInfo
  isActive: boolean
}

export function TerminalView({ session, isActive }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const isDark = useIsDarkTheme()
  const terminalThemeName = useAppStore((s) => s.preferences.terminalTheme)
  const copyOnSelect = useAppStore((s) => s.preferences.copyOnSelect)
  // 创建 effect 只跑一次，用 ref 读取最新偏好，避免闭包读到旧值
  const copyOnSelectRef = useRef(copyOnSelect)
  copyOnSelectRef.current = copyOnSelect
  const theme = useMemo(() => resolveTerminalTheme(terminalThemeName, isDark), [
    terminalThemeName,
    isDark
  ])
  // ZMODEM 传输会话（rz/sz）与状态提示
  const zsessionRef = useRef<any>(null)
  const [zmodem, setZmodem] = useState<{ active: boolean; text: string } | null>(null)
  // 命令预测（历史 / 常见命令补全）相关状态
  const commandPrediction = useAppStore((s) => s.preferences.commandPrediction)
  const commandPredictionRef = useRef(commandPrediction)
  commandPredictionRef.current = commandPrediction
  const historyRef = useRef<string[]>([])
  const inputBufferRef = useRef('')
  const suggestionsRef = useRef<string[]>([])
  const activeIndexRef = useRef(0)
  const [suggestions, setSuggestions] = useState<{ items: string[]; index: number } | null>(null)

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
  // 始终读取最新主题（创建 effect 只跑一次，避免闭包读到旧值）
  const themeRef = useRef(theme)
  themeRef.current = theme

  useEffect(() => {
    const container = containerRef.current
    if (!container || termRef.current) return

    const term = new Terminal({
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: themeRef.current
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    try {
      fit.fit()
    } catch {
      // 隐藏容器首次 fit 可能失败
    }
    void window.api.terminal.resize(session.id, term.cols, term.rows)
    // ZMODEM 传输结束时的清理（终止会话引用、收起提示）
    const endSession = () => {
      zsessionRef.current = null
      setZmodem(null)
    }
    // 上传（远端执行了 rz）：弹出文件选择，逐文件发送
    const handleUpload = async (zsession: any) => {
      try {
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
        for (const f of files) {
          const xfer = await zsession.send_offer({ name: f.name, size: f.size, mtime: new Date() })
          if (!xfer) continue
          const CHUNK = 8192
          for (let off = 0; off < f.data.byteLength; off += CHUNK) {
            xfer.send(f.data.subarray(off, Math.min(off + CHUNK, f.data.byteLength)))
          }
          await xfer.end(new Uint8Array(0))
        }
        await zsession.close()
      } catch (e) {
        console.error('zmodem upload failed', e)
      } finally {
        endSession()
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
          active: true,
          text: zsession.type === 'send' ? 'ZMODEM 上传中：请选择要发送的文件' : 'ZMODEM 下载中…'
        })
        if (zsession.type === 'send') {
          void handleUpload(zsession)
        } else {
          zsession.on('offer', (offer: any) => {
            const name = offer.get_details().name || 'file'
            offer
              .accept()
              .then((spool: Uint8Array[]) => {
                const total = spool.reduce((a: number, p: Uint8Array) => a + p.byteLength, 0)
                const merged = new Uint8Array(total)
                let off = 0
                for (const p of spool) {
                  merged.set(p, off)
                  off += p.byteLength
                }
                return window.api.zmodem.saveFile(name, merged)
              })
              .catch((e: unknown) => console.error('zmodem receive failed', e))
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
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
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

  const exited = useAppStore((s) => s.exitedSessions.has(session.id))

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {exited && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <span className="rounded-md border border-border bg-card px-4 py-2 text-sm text-muted-foreground">
            会话已结束（{session.title}）
          </span>
        </div>
      )}
      {zmodem && (
        <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground shadow">
          {zmodem.text}
        </div>
      )}
      {suggestions && (
        <div className="absolute bottom-2 left-2 z-10 max-h-56 w-80 overflow-y-auto rounded-md border border-border bg-popover/95 p-1 text-xs shadow-lg backdrop-blur">
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
