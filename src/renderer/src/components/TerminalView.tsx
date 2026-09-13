import { useEffect, useMemo, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { SessionInfo } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { useIsDarkTheme } from '@/lib/theme'
import { resolveTerminalTheme } from '@/lib/terminal-themes'

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
  const theme = useMemo(() => resolveTerminalTheme(terminalThemeName, isDark), [
    terminalThemeName,
    isDark
  ])
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
    </div>
  )
}
