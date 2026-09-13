import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { SessionInfo } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { useIsDarkTheme } from '@/lib/theme'
import type { ITheme } from '@xterm/xterm'

const DARK_TERMINAL_THEME: ITheme = {
  background: '#0f1117',
  foreground: '#e6e6e6',
  cursor: '#4daafc',
  cursorAccent: '#0f1117',
  selectionBackground: 'rgba(77, 170, 252, 0.3)',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#c9c9c9',
  cyan: '#8abeb7',
  white: '#c5c8c6'
}

const LIGHT_TERMINAL_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(9, 105, 218, 0.25)',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781'
}

interface TerminalViewProps {
  session: SessionInfo
  isActive: boolean
}

export function TerminalView({ session, isActive }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const isDark = useIsDarkTheme()

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
      theme: isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
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
    term.onData((data) => void window.api.terminal.write(session.id, data))
    termRef.current = term
    fitRef.current = fit

    const unsubscribeData = window.api.terminal.onData(({ sessionId, data }) => {
      if (sessionId === session.id) term.write(data)
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
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // isDark 仅决定初始主题；运行中切换由下方 effect 热更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // 主题切换时热更新终端配色
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
    }
  }, [isDark])

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
    </div>
  )
}
