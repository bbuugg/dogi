import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, RefreshCw, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import Zmodem from 'zmodem.js'
import { cn } from 'cn'
import type { SessionInfo, SshConnectProgress, SshConnectStage } from '@shared/types'
import { useAppStore, attachTerminalData, dropTerminalData } from '@/stores/app-store'
import { useIsDarkTheme } from '@/lib/theme'
import { clampCompositionOverflow } from '@/lib/terminal-ime'
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

/** SSH 连接阶段标题（连接进度卡片顶部文案） */
const CONNECT_STAGE_TEXT: Record<SshConnectStage, string> = {
  resolving: '正在解析主机并建立 TCP 连接',
  handshake: '已建立连接，正在握手（密钥交换）',
  authenticating: '握手完成，正在认证身份',
  'opening-shell': '认证通过，正在打开 shell',
  retrying: '连接失败，正在重试',
  ready: '连接就绪'
}

/** 连接步骤（卡片中逐项展示完成状态） */
const CONNECT_STEPS: Array<{ stage: SshConnectStage; label: string }> = [
  { stage: 'resolving', label: 'TCP 连接' },
  { stage: 'handshake', label: '握手 / 密钥交换' },
  { stage: 'authenticating', label: '身份认证' },
  { stage: 'opening-shell', label: '打开 shell' }
]

/** 当前阶段对应的步骤下标（重试即回到第一步重来） */
function connectStepIndex(stage: SshConnectStage): number {
  if (stage === 'retrying') return 0
  const index = CONNECT_STEPS.findIndex((s) => s.stage === stage)
  return index < 0 ? CONNECT_STEPS.length : index
}

/**
 * SSH 连接进度卡片：连接期间浮在终端上方，
 * 展示目标主机、认证方式、当前阶段、步骤进度、重试次数与已耗时。
 */
function SshConnectCard({
  session,
  progress
}: {
  session: SessionInfo
  progress: SshConnectProgress
}) {
  const profile = useAppStore((s) =>
    session.profileId ? (s.profiles.find((p) => p.id === session.profileId) ?? null) : null
  )
  // 连接途中允许取消：关闭该会话即中止主进程侧的连接尝试
  const closeSession = useAppStore((s) => s.closeSession)
  // 已耗时：从卡片出现开始计时（连接总耗时由主进程侧决定，这里只做用户可感知的等待反馈）
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 100)
    return () => window.clearInterval(timer)
  }, [])

  const active = connectStepIndex(progress.stage)
  const retrying = progress.stage === 'retrying'
  const target = profile
    ? `${profile.username}@${profile.host}:${profile.port || 22}`
    : session.title

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full max-w-sm rounded-lg border border-border bg-card p-4 text-foreground shadow-lg"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{CONNECT_STAGE_TEXT[progress.stage]}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{target}</div>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {(elapsed / 1000).toFixed(1)}s
        </span>
      </div>

      {retrying && (
        <div className="mt-2 flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3 shrink-0" />
          <span>
            连接失败，正在重试（第 {progress.attempt ?? 1}/{progress.maxAttempts ?? 1} 次）
          </span>
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        {CONNECT_STEPS.map((step, i) => {
          const done = i < active
          const running = i === active
          return (
            <div key={step.stage} className="flex items-center gap-2 text-xs">
              {done ? (
                <Check className="size-3.5 shrink-0 text-emerald-500" />
              ) : running ? (
                <RefreshCw className="size-3.5 shrink-0 animate-spin text-primary" />
              ) : (
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                </span>
              )}
              <span className={done || running ? 'text-foreground' : 'text-muted-foreground'}>
                {step.label}
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {done ? '已完成' : running ? '进行中' : '等待'}
              </span>
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
        <span>认证：{profile?.authType === 'privateKey' ? '密钥' : '密码'}</span>
        <span>保活：{Math.round((profile?.keepaliveInterval || 15000) / 1000)}s</span>
        <span>超时：20s</span>
      </div>

      <button
        type="button"
        onClick={() => void closeSession(session.id)}
        className="mt-3 w-full rounded border border-border py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        取消连接
      </button>
    </div>
  )
}

export function TerminalView({ session, isActive }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const isDark = useIsDarkTheme()
  const terminalThemeName = useAppStore((s) => s.preferences.terminalTheme)
  const copyOnSelect = useAppStore((s) => s.preferences.copyOnSelect)
  const rightClickPaste = useAppStore((s) => s.preferences.rightClickPaste)
  const terminalFontSize = useAppStore((s) => s.preferences.terminalFontSize)
  // 创建 effect 只跑一次，用 ref 读取最新偏好，避免闭包读到旧值
  const copyOnSelectRef = useRef(copyOnSelect)
  copyOnSelectRef.current = copyOnSelect
  const rightClickPasteRef = useRef(rightClickPaste)
  rightClickPasteRef.current = rightClickPaste
  const fontSizeRef = useRef(terminalFontSize)
  fontSizeRef.current = terminalFontSize
  const theme = useMemo(() => resolveTerminalTheme(terminalThemeName, isDark), [
    terminalThemeName,
    isDark
  ])
  // ZMODEM 传输会话（rz/sz）与状态提示
  const zsessionRef = useRef<any>(null)
  const [zmodem, setZmodem] = useState<ZmodemState | null>(null)
  // 下载：当前 offer（取消时优先 skip，库推荐的干净跳过）
  const currentOfferRef = useRef<any>(null)
  // 上传：发送循环的停止标志（取消后停止 send）
  const uploadCancelRef = useRef(false)
  // 传输已取消：后续到达的 offer 一律 skip，accept 后的结果不再保存
  const zmodemCancelledRef = useRef(false)
  // 取消动作回调（effect 内定义，浮层按钮调用）
  const zmodemCancelRef = useRef<(() => void) | null>(null)
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
    // 输入法组合串贴屏幕右缘向左生长，防止向右溢出把页面推左（pi 等 TUI 光标停在行尾时必现）
    const unclampIme = clampCompositionOverflow(container)
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
    // Ctrl + 滚轮必须在捕获阶段拦截：xterm 6 的平滑滚动元素把滚轮监听挂在更深的
    // .xterm-scrollable-element 上，冒泡时先于 attachCustomWheelEventHandler 的根节点闸门触发，
    // 且有可滚动内容时会 preventDefault + stopPropagation 消费掉事件，
    // 导致 Ctrl+滚轮变成滚动回滚缓冲而非缩放（仅在滚到顶/底无内容可滚时才轮到缩放）。
    const handleWheelCapture = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      adjustTerminalFontSize(e.deltaY < 0 ? 1 : -1)
    }
    container.addEventListener('wheel', handleWheelCapture, { capture: true, passive: false })
    // 右键粘贴：开启时拦截原生菜单，读取剪贴板并写入终端；关闭时保留浏览器默认右键菜单
    const handleContextMenu = (e: MouseEvent) => {
      if (!rightClickPasteRef.current) return
      e.preventDefault()
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) term.paste(text)
        })
        .catch(() => {})
    }
    container.addEventListener('contextmenu', handleContextMenu)
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
      currentOfferRef.current = null
      setZmodem(null)
    }
    // 取消传输：下载走 offer.skip()（干净跳过当前文件，会话继续到自然结束，无乱码）；
    // 上传无 skip 可用（Transfer 只有 send/end），置停止标志 + zsession.abort() 发 CAN 序列中止远端
    const cancelZmodem = () => {
      uploadCancelRef.current = true
      zmodemCancelledRef.current = true
      const zs = zsessionRef.current
      const offer = currentOfferRef.current
      try {
        if (offer) offer.skip()
        else if (zs) zs.abort()
      } catch {
        try {
          if (zs) zs.abort()
        } catch {
          // 忽略
        }
      }
      endSession()
    }
    zmodemCancelRef.current = cancelZmodem
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
            // 已取消：停止发送，由 cancelZmodem 的 abort 通知远端
            if (uploadCancelRef.current) return
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
        // 新会话：清除上一轮的取消状态
        uploadCancelRef.current = false
        zmodemCancelledRef.current = false
        currentOfferRef.current = null
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
            // 已取消：批量场景下后续到达的文件一律跳过，直至会话自然结束
            if (zmodemCancelledRef.current) {
              try {
                offer.skip()
              } catch {
                // 忽略
              }
              return
            }
            currentOfferRef.current = offer
            const details = (offer.get_details && offer.get_details()) || {}
            const rawName: string = details.name || 'file'
            const size: number = typeof details.size === 'number' ? details.size : 0
            // 仅用于对话框默认名：去掉目录分隔符与控制字符，避免被当作路径
            const safeName =
              rawName.replace(/[\\/]/g, '_').replace(/[ -]/g, '').trim() || 'file'
            setZmodem({ direction: 'download', name: rawName, text: `下载中：${rawName}`, progress: 0 })
            // 先选保存位置，再开始下载
            const filePath = await window.api.zmodem.askSavePath(safeName)
            // 等待对话框期间取消了（skip 已由 cancelZmodem 调用过则忽略重复抛错）
            if (zmodemCancelledRef.current) {
              try {
                offer.skip()
              } catch {
                // 忽略
              }
              currentOfferRef.current = null
              return
            }
            if (!filePath) {
              try {
                offer.skip()
              } catch {
                // 忽略
              }
              currentOfferRef.current = null
              return
            }
            let downloaded = 0
            let last = 0
            // 注意：zmodem.js 的 input 事件回传普通 number[]（非 Uint8Array），
            // 只有 .length 可用；用 byteLength 会得到 undefined，进度变 NaN
            offer.on('input', (payload: number[]) => {
              downloaded += payload.length
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
              // 传输过程中取消了：丢弃已收数据，不保存
              if (zmodemCancelledRef.current) return
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
            } finally {
              currentOfferRef.current = null
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

    // 输出统一由 store 接收（挂载前到达的字节已在缓冲中），这里注册后立即回放
    const unsubscribeData = attachTerminalData(session.id, (data) => {
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
      unclampIme()
      charSizeDisp?.dispose?.()
      container.removeEventListener('wheel', handleWheelCapture, { capture: true })
      container.removeEventListener('contextmenu', handleContextMenu)
      unsubscribeData()
      dropTerminalData(session.id)
      zmodemCancelRef.current = null
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

  // 所在组的 AI 面板显隐会改变终端可用宽度，主动重新适配，避免关闭面板后终端仍停留在旧（较窄）的宽度
  const aiPanelOpen = useAppStore((s) => {
    for (const g of Object.values(s.groups)) {
      if (g.sessionIds.includes(session.id)) return !!s.ui.aiOpenGroups[g.id]
    }
    return false
  })
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
  // SSH 连接进度：连接阶段由主进程按真实事件推送，就绪/失败后条目被移除
  const connectStage = useAppStore((s) => s.connectStages[session.id])
  const connecting = Boolean(connectStage)
  // 遮罩立刻铺上（否则空终端的 shell 光标会先露出来），卡片本身延迟 250ms 淡入，避免快速连接时一闪而过
  const [showConnect, setShowConnect] = useState(false)
  useEffect(() => {
    if (!connecting) {
      setShowConnect(false)
      return
    }
    const timer = window.setTimeout(() => setShowConnect(true), 250)
    return () => window.clearTimeout(timer)
  }, [connecting])
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
      {connecting && connectStage && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center p-4"
          style={{ backgroundColor: theme.background }}
        >
          {showConnect && <SshConnectCard session={session} progress={connectStage} />}
        </div>
      )}
      {zmodem && (
        <div className="absolute left-1/2 top-3 z-10 w-72 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground shadow">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="truncate font-medium">
              {zmodem.direction === 'upload' ? '↑ 上传' : '↓ 下载'}：{zmodem.name || '…'}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {Math.round(zmodem.progress)}%
            </span>
            <button
              type="button"
              title="取消传输"
              onClick={() => zmodemCancelRef.current?.()}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="size-3" />
            </button>
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
                  'flex w-full items-center rounded px-2 py-1 text-left',
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
