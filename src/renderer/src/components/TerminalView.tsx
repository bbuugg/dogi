import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import Zmodem from 'zmodem.js'
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

    term.onData((data) => {
      // ZMODEM 传输期间禁用手动输入，避免破坏协议
      if (zsessionRef.current) return
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
    </div>
  )
}
