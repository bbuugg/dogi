import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, RefreshCw, RotateCw, Upload, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import Zmodem from 'zmodem.js'
import { cn } from 'cn'
import type { SessionInfo, SshConnectProgress, SshConnectStage } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { useIsDarkTheme } from '@/shared/lib/theme'
import { clampCompositionOverflow } from '@/features/terminal/terminal-ime'
import { resolveTerminalTheme } from '@/features/terminal/terminal-themes'
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_STEP } from '@/features/terminal/terminal-font'

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
  /** 当前标签 id（用于注册关闭拦截 guard）；外部 PanelView 传入 */
  tabId?: string
  /** 会话结束后按 Enter 的自定义动作（如内嵌终端就地重开）；不传则走全局 reconnectSession */
  onExitedReconnect?: () => void
  /** 会话结束后按 Ctrl+D 的自定义动作（如内嵌终端就地关闭）；不传则走全局 closeSession */
  onExitedClose?: () => void
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

/**
 * 拖拽上传（把本地文件/文件夹拖到终端，经 SFTP 送到远端）的确认条状态。
 *
 * 目标目录由用户确认：终端当前工作目录拿不到（Shell 默认不发 OSC 7、解析提示符不可靠），
 * 所以默认给远端家目录，允许编辑，并在会话内记住上次用过的目录。
 */
interface DropUploadState {
  /** 要上传的本地绝对路径（文件或目录） */
  paths: string[]
  /** 目标远端目录（可编辑） */
  dir: string
  phase: 'connecting' | 'connectFailed' | 'ready' | 'uploading' | 'failed'
  error?: string
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
  // Mosh 会话的最后一步是拉起本地 mosh-client（而非打开 shell），文案跟着换
  const steps = session.mosh
    ? CONNECT_STEPS.map((s) => (s.stage === 'opening-shell' ? { ...s, label: '启动 Mosh' } : s))
    : CONNECT_STEPS
  const stageText =
    session.mosh && progress.stage === 'opening-shell'
      ? '认证通过，正在启动 mosh-server'
      : CONNECT_STAGE_TEXT[progress.stage]

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full max-w-sm rounded-lg border border-border bg-card p-4 text-foreground shadow-lg"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{stageText}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{target}</div>
          {progress.detail && (
            <div className="mt-0.5 truncate text-xs text-primary/80">{progress.detail}</div>
          )}
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
        {steps.map((step, i) => {
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
              <span className="ml-auto text-xs text-muted-foreground">
                {done ? '已完成' : running ? '进行中' : '等待'}
              </span>
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
        <span>认证：{profile?.authType === 'privateKey' ? '密钥' : '密码'}</span>
        {session.mosh && <span>Mosh（UDP）</span>}
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

export function TerminalView({
  session,
  isActive,
  tabId,
  onExitedReconnect,
  onExitedClose
}: TerminalViewProps) {
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
  // 拖拽上传：外层容器（拖拽监听挂这里，确认条也覆盖在这里）
  const wrapRef = useRef<HTMLDivElement>(null)
  // 拖拽上传：SFTP 连接 id（一个终端会话一个，首次拖入时懒建，卸载时关闭）
  const dropConnRef = useRef<string | null>(null)
  // 拖拽上传：该会话上次用过的目标目录（记住用户的选择）
  const lastUploadDirRef = useRef<string | null>(null)
  // 拖拽进入的深度计数：指针在子元素间移动会连发 enter/leave，只看深度归零才算真的离开
  const dragDepthRef = useRef(0)
  const [dragOver, setDragOver] = useState(false)
  const [dropUpload, setDropUpload] = useState<DropUploadState | null>(null)
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
              rawName.replace(/[\\/]/g, '_').replace(/[\x00-\x1f]/g, '').trim() || 'file'
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
    /**
     * 只有「纯可打印文本」才当作命令行内容来跟踪。
     * 任何控制字符（Ctrl+A/B/E/R/U/K… 这类组合键、Tab、方向键 / F 键的 ESC 序列、
     * DEL、可能带换行的粘贴）都意味着本地缓冲与 shell 真实命令行已经对不上 ——
     * 这时必须重置缓冲并收起下拉框，否则组合键之后预测会乱套，
     * 下拉框还会赖着不走继续吞掉 Tab / 方向键。
     */
    const isTrackableInput = (data: string): boolean =>
      data.length > 0 && !/[\u0000-\u001f\u007f]/.test(data)
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
      // 控制字符 / 转义序列 / 多行粘贴：不参与预测，按键原样交给 shell
      if (!isTrackableInput(data)) {
        inputBufferRef.current = ''
        clearSuggestions()
        return
      }
      inputBufferRef.current += data
      recompute()
    }

    term.onData((data) => {
      // 会话已结束：只认 Enter（重连）与 Ctrl+D（关闭），其余按键吞掉（对齐 Web 终端重连逻辑）
      if (exitedRef.current) {
        // ⚠️ 只有真正命中动作的键才允许上锁：早期版本对「任意按键」上锁，
        // 用户回来随手按下的第一个无关键就把重连 / Ctrl+D / 重连按钮一起永久锁死了
        if (data === '\r') runExitedActionRef.current?.('reconnect')
        else if (data === '\x04') runExitedActionRef.current?.('close')
        return
      }
      // ZMODEM 传输期间禁用手动输入，避免破坏协议
      if (zsessionRef.current) return
      /**
       * 备用屏幕（tmux / screen / vim / less / htop…）：全屏程序里没有 shell 的行编辑，
       * 本地缓冲也无从跟踪，而且它们会把「组合键之后的可打印键」当成自己的命令执行
       * —— tmux 的 Ctrl+B 再按 d 是 detach、vim 的 dd 是删行，屏幕上不会出现任何输入回显。
       * 若照常累积就会在什么都没输入的情况下弹出预测面板（用户报告），所以全屏期间
       * 既不跟踪也不拦截按键，原样交给程序。
       */
      if (term.buffer.active.type === 'alternate') {
        if (suggestionsRef.current.length > 0) clearSuggestions()
        inputBufferRef.current = ''
        void window.api.terminal.write(session.id, data)
        return
      }
      // 下拉框开着时只吃「接受」与「Ctrl+↑/↓ 选择」这几个键：
      // 普通 ↑/↓/← 一律放行 —— 它们是 shell 的历史与光标移动，
      // 在 tmux / vim 这类全屏程序里更是必须原样送达（Ctrl+B 之后的调整也靠它们）。
      if (suggestionsRef.current.length > 0) {
        // 仅右键（→，\x1b[C）接受预测；Tab 不再拦截，落到原生 shell 补全
        if (data === '\x1b[C') {
          acceptSuggestion()
          return
        }
        if (data === '\x1b[1;5B') {
          moveActive(1)
          return
        }
        if (data === '\x1b[1;5A') {
          moveActive(-1)
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
      unclampIme()
      charSizeDisp?.dispose?.()
      container.removeEventListener('wheel', handleWheelCapture, { capture: true })
      container.removeEventListener('contextmenu', handleContextMenu)
      unsubscribeData()
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

  // 本终端页面的 AI 面板显隐会改变终端可用宽度，主动重新适配，
  // 避免关闭面板后终端仍停留在旧（较窄）的宽度。
  // AI 属于终端页面（= 会话），所以直接看本会话自己的开关即可。
  const aiPanelOpen = useAppStore((s) => !!s.ui.aiOpenSessions[session.id])
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
  // 重连/关闭串行化：同一时刻只允许一个，避免连按产生多个会话。
  // ⚠️ 但「锁上就必须能解锁」：动作没生效（失败 / 被拦截 / 永不回包）时必须放开，
  // 否则重连按钮、Enter、Ctrl+D 会一起永久失灵（早期的一次性闩锁就是这么坏的）。
  const actionRef = useRef(false)
  // 退出后的重连/关闭走自定义回调时，用 ref 镜像最新引用（onData 回调创建时只绑定一次，
  // 闭包里若直接读 prop 会拿到旧值；内嵌终端的回调随 term 状态变化，必须读最新）
  const onExitedReconnectRef = useRef(onExitedReconnect)
  onExitedReconnectRef.current = onExitedReconnect
  const onExitedCloseRef = useRef(onExitedClose)
  onExitedCloseRef.current = onExitedClose

  /** 会话结束后的两个出口：Enter 重连 / Ctrl+D 关闭（失败可重试，并在终端里给出反馈） */
  const runExitedAction = useCallback(
    (action: 'reconnect' | 'close') => {
      if (actionRef.current) return
      actionRef.current = true
      const targetId = session.id
      const term = termRef.current
      if (action === 'reconnect') term?.write('\r\n\x1b[36m● 正在重连…\x1b[0m\r\n')
      let settled = false
      function finish(err?: unknown): void {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        // 会话已不在结束态 = 这次动作生效了（标签被新会话替换 / 已关闭），保持上锁避免重复触发
        if (!useAppStore.getState().exitedSessions.has(targetId)) return
        // 仍停在结束态：放开闩锁，允许再次重连或关闭
        actionRef.current = false
        if (err) {
          const text = err instanceof Error ? err.message : String(err)
          const label = action === 'reconnect' ? '重连失败' : '关闭失败'
          term?.write(`\r\n\x1b[31m● ${label}：${text}\x1b[0m\r\n`)
        }
        term?.write('\x1b[90m  按 Enter 重连 · 按 Ctrl+D 关闭标签\x1b[0m\r\n')
      }
      // IPC 极端情况下可能永不回包：超时兜底把闩锁放开，别让用户干等一个已经没戏的动作
      const timer = window.setTimeout(() => finish(new Error('操作超时')), 30_000)
      // 内嵌终端走自定义回调（就地重开 / 就地关闭）；标签页终端走全局动作
      const run =
        action === 'reconnect'
          ? onExitedReconnectRef.current
            ? Promise.resolve(onExitedReconnectRef.current())
            : useAppStore.getState().reconnectSession(targetId)
          : onExitedCloseRef.current
            ? Promise.resolve(onExitedCloseRef.current())
            : useAppStore.getState().closeSession(targetId)
      run.then(() => finish(), (e: unknown) => finish(e))
    },
    [session.id]
  )
  // onData 只在创建时绑定一次，用 ref 镜像最新实现（与 exitedRef 同理）
  const runExitedActionRef = useRef(runExitedAction)
  runExitedActionRef.current = runExitedAction
  // 会话结束后：把提示直接写进终端（对齐 Web 端子做法，不再弹浮层），并聚焦以接收回车重连 / Ctrl+D 关闭
  const exitNoticeRef = useRef(false)
  useEffect(() => {
    if (!exited) {
      exitNoticeRef.current = false
      // 会话复活（重连成功 / 换会话）后必须解锁，否则下一次结束就再也按不动了
      actionRef.current = false
      return
    }
    const term = termRef.current
    term?.focus()
    if (!term || exitNoticeRef.current) return
    exitNoticeRef.current = true
    term.write(`\r\n\x1b[33m● 会话已结束（${session.title}）\x1b[0m\r\n`)
    term.write('\x1b[90m  按 Enter 重连 · 按 Ctrl+D 关闭标签\x1b[0m\r\n')
  }, [exited, session.title])

  /*
   * 拖拽上传：把本地文件 / 文件夹拖到终端，经 SFTP 送到远端。
   *
   * 为什么走 SFTP 而不是复用 rz（ZMODEM）：ZMODEM 只能逐个文件落到远端当前目录，
   * 协议本身不支持目录；SFTP 有现成的递归上传（sftpService.uploadDir）。
   * 仅 SSH 会话可用（本地会话没有远端）；Mosh 会话也可用 —— SFTP 是独立的 SSH 连接，
   * 不走 mosh 的数据通道。
   */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    /** 只接管「拖的是文件」，放行标签拖拽等其它拖放 */
    const hasFiles = (e: DragEvent): boolean =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const hint = (text: string): void => {
      termRef.current?.write(`\r\n\x1b[33m● ${text}\x1b[0m\r\n`)
    }
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current += 1
      setDragOver(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // 必须 preventDefault：否则 drop 不触发，浏览器会直接打开被拖入的文件
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragOver(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current = 0
      setDragOver(false)
      if (exitedRef.current) return
      // rz/sz 传输中不接管：两套通道同时在跑容易互相干扰
      if (zsessionRef.current) {
        hint('正在传输（rz/sz），暂时不能拖拽上传')
        return
      }
      // 拖入的 File 只有经 webUtils 才拿得到本地真实路径（Electron 32 起没有 File.path）
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => window.api.app.getPathForFile(f))
        .filter((p) => !!p)
      if (!paths.length) return
      const profileId = session.type === 'ssh' ? session.profileId : undefined
      if (!profileId) {
        hint('拖拽上传仅支持 SSH 会话（本地终端没有远端）')
        return
      }
      const connId = `sftp-drop-${session.id}`
      dropConnRef.current = connId
      setDropUpload({ paths, dir: lastUploadDirRef.current ?? '', phase: 'connecting' })
      void (async () => {
        try {
          await window.api.sftp.open(connId, profileId)
          // 默认目标目录：该会话上次用过的；没有则取远端家目录（realpath('.')）
          const dir =
            lastUploadDirRef.current ||
            (await window.api.sftp.realpath(connId, '.').catch(() => '/'))
          setDropUpload((p) => (p ? { ...p, dir, phase: 'ready' } : p))
        } catch (err) {
          setDropUpload((p) =>
            p
              ? {
                  ...p,
                  phase: 'connectFailed',
                  error: err instanceof Error ? err.message : String(err)
                }
              : p
          )
        }
      })()
    }
    wrap.addEventListener('dragenter', onDragEnter)
    wrap.addEventListener('dragover', onDragOver)
    wrap.addEventListener('dragleave', onDragLeave)
    wrap.addEventListener('drop', onDrop)
    return () => {
      wrap.removeEventListener('dragenter', onDragEnter)
      wrap.removeEventListener('dragover', onDragOver)
      wrap.removeEventListener('dragleave', onDragLeave)
      wrap.removeEventListener('drop', onDrop)
      dragDepthRef.current = 0
      setDragOver(false)
    }
  }, [session.id, session.type, session.profileId])

  // 卸载 / 换会话时关掉拖拽上传用的 SFTP 连接（没连过时 close 是 no-op）
  useEffect(
    () => () => {
      const connId = dropConnRef.current
      dropConnRef.current = null
      if (connId) void window.api.sftp.close(connId)
    },
    [session.id]
  )

  const cancelDropUpload = (): void => {
    setDropUpload(null)
    termRef.current?.focus()
  }

  /** 确认目标目录并开始上传（进度由状态栏传输托盘统一展示） */
  const confirmDropUpload = async (): Promise<void> => {
    const state = dropUpload
    const connId = dropConnRef.current
    if (!state || !connId || state.phase === 'uploading') return
    const dir = state.dir.trim()
    if (!dir) return
    setDropUpload({ ...state, phase: 'uploading', error: undefined })
    try {
      const result = await window.api.sftp.uploadPaths(connId, dir, state.paths)
      if (result.ok) {
        lastUploadDirRef.current = dir
        termRef.current?.write(
          `\r\n\x1b[32m● 已上传 ${result.count ?? state.paths.length} 项到 ${dir}\x1b[0m\r\n`
        )
        setDropUpload(null)
      } else if (result.canceled) {
        termRef.current?.write('\r\n\x1b[33m● 上传已取消\x1b[0m\r\n')
        setDropUpload(null)
      } else {
        setDropUpload({ ...state, phase: 'failed', error: result.error || '上传失败' })
      }
    } catch (e) {
      setDropUpload({
        ...state,
        phase: 'failed',
        error: e instanceof Error ? e.message : String(e)
      })
    }
    termRef.current?.focus()
  }

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      style={{ backgroundColor: theme.background }}
    >
      <div ref={containerRef} className="h-full w-full" />
      {/* 拖拽高亮：pointer-events-none 保证拖拽事件继续落在容器上（不然会打断 dragenter/dragleave 计数） */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/10">
          <div className="rounded-md border border-border bg-card/95 px-3 py-1.5 text-xs text-foreground shadow">
            {session.type === 'ssh' && session.profileId
              ? '松手即可上传到远端（SFTP）'
              : '拖拽上传仅支持 SSH 会话'}
          </div>
        </div>
      )}
      {connecting && connectStage && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center p-4"
          style={{ backgroundColor: theme.background }}
        >
          {showConnect && <SshConnectCard session={session} progress={connectStage} />}
        </div>
      )}
      {/* 会话结束后右下角提供显式重连按钮：与「按 Enter 重连」等价（同一条重试通道） */}
      {exited && (
        <button
          type="button"
          onClick={() => runExitedAction('reconnect')}
          className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground shadow-lg transition-colors hover:bg-secondary"
        >
          <RotateCw className="size-3.5" />
          重新连接
        </button>
      )}
      {dropUpload && (
        <div className="absolute left-1/2 top-3 z-20 w-96 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-md border border-border bg-card p-3 text-xs text-foreground shadow-lg">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 truncate font-medium">
              <Upload className="size-3.5 shrink-0" />
              上传 {dropUpload.paths.length} 项到远端
            </span>
            <button
              type="button"
              title="关闭"
              onClick={cancelDropUpload}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
          {dropUpload.phase === 'connecting' ? (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在连接 SFTP…
            </div>
          ) : dropUpload.phase === 'connectFailed' ? (
            <div className="space-y-2">
              <div className="break-all text-destructive">连接失败：{dropUpload.error}</div>
              <div className="text-muted-foreground">可关闭后重新拖入重试</div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={cancelDropUpload}
                  className="rounded border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  关闭
                </button>
              </div>
            </div>
          ) : (
            <>
              <label className="mb-1 block text-muted-foreground">目标目录</label>
              <input
                value={dropUpload.dir}
                autoFocus
                disabled={dropUpload.phase === 'uploading'}
                placeholder="远端目录，如 /root"
                onChange={(e) =>
                  setDropUpload((p) => (p ? { ...p, dir: e.target.value } : p))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirmDropUpload()
                  else if (e.key === 'Escape') cancelDropUpload()
                }}
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none transition-colors focus:border-primary disabled:opacity-60"
              />
              {dropUpload.phase === 'failed' && dropUpload.error && (
                <div className="mt-1 break-all text-destructive">{dropUpload.error}</div>
              )}
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="truncate text-muted-foreground">
                  文件夹将作为同名子目录上传
                </span>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={dropUpload.phase === 'uploading'}
                    onClick={cancelDropUpload}
                    className="rounded border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={dropUpload.phase === 'uploading' || !dropUpload.dir.trim()}
                    onClick={() => void confirmDropUpload()}
                    className="rounded bg-primary px-2 py-1 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {dropUpload.phase === 'uploading' ? '上传中…' : '上传'}
                  </button>
                </div>
              </div>
            </>
          )}
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
          <div className="mt-1 truncate text-xs text-muted-foreground">{zmodem.text}</div>
        </div>
      )}
      {suggestions && (
        <div
          ref={dropdownRef}
          style={pos ? { top: pos.top, left: pos.left } : undefined}
          className="absolute z-10 max-h-56 w-80 overflow-y-auto rounded-md border border-border bg-popover/95 p-1 text-xs shadow-lg backdrop-blur">
          <div className="px-2 py-1 text-xs text-muted-foreground">
            命令预测 · → 接受 · Ctrl+↑/↓ 选择 · Esc 关闭
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
                {/* 两段文字必须留在同一个元素里：button 是 flex 容器，
                    若拆成两个子 span，它们各自成为 flex 子项（块容器），
                    边界空格就会落在各自行盒边缘被 CSS 裁掉、显示成「gitstatus」。 */}
                <span className="truncate">
                  {buf}
                  <span className="font-medium text-primary">{rest}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
