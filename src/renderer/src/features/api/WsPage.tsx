import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Cable,
  ChevronDown,
  ChevronUp,
  Eraser,
  Info,
  Send,
  Settings2,
  Trash2,
  TriangleAlert,
  Unplug
} from 'lucide-react'
import { AutoComplete, Button, Checkbox, Drawer, Input, Modal, Tag, message } from 'antd'
import {
  NEW_WS_REQUEST_ID,
  apiTabId,
  apiTabTitle,
  editorSaveKey,
  useAppStore
} from '@/stores/app-store'
import { cn } from 'cn'
import MonacoEditor from '@/shared/components/MonacoEditor'
import { TabButtons } from '@/features/api/TabButtons'
import {
  COMMON_HEADERS,
  emptyHeader,
  formatBytes,
  headerValueSuggestions,
  isBlankHeader,
  normalizeHeaders,
  pairsToHeaders,
  tidyHeaderRows
} from '@/features/api/api-client'
import type {
  ApiHeaderPair,
  WsConnectOptions,
  WsEvent,
  WsReadyState
} from '@shared/types'

/** 发送区高度占比的默认值与上下限（拖动分隔条时按此范围夹取） */
const COMPOSER_RATIO_DEFAULT = 0.32
const COMPOSER_RATIO_MIN = 0.12
const COMPOSER_RATIO_MAX = 0.8
/**
 * 日志区至少保留的高度（px）。
 * 与 ApiPage 同一个理由：只按比例卡上限不够，窗口一矮，80% 的发送区
 * 照样能把日志压成 0，压扁后内容会溢出糊在发送区上。
 */
const MIN_LOG_PANE_H = 120
/**
 * 日志条数上限。长连接下消息可能是持续的，不设上限会一直吃内存；
 * 超过就丢最旧的（调试场景里最近的帧才有价值）。
 */
const LOG_LIMIT = 1000

/** 日志筛选：全部 / 只看发送 / 只看接收 / 只看系统（连接、关闭、错误） */
const LOG_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'sent', label: '发送' },
  { key: 'received', label: '接收' },
  { key: 'system', label: '系统' }
] as const
type LogFilter = (typeof LOG_FILTERS)[number]['key']

/** 发送编码：文本帧（原样发字符串）/ 二进制帧（把输入当 base64 解成字节发出去） */
const MSG_ENCODINGS = [
  { key: 'text', label: '文本' },
  { key: 'base64', label: 'Base64' }
] as const
type MsgEncoding = (typeof MSG_ENCODINGS)[number]['key']

/** 一条日志（收 / 发 / 系统事件） */
interface WsLogEntry {
  id: string
  dir: 'sent' | 'received' | 'system'
  /** 文本原文，或二进制帧的 base64 */
  data: string
  encoding: 'text' | 'base64'
  /** 字节数（系统消息为 0） */
  bytes: number
  at: number
  /** 系统消息的级别：info 正常流程，error 连接失败 / 异常关闭 */
  level?: 'info' | 'error'
}

/**
 * WebSocket 调试页（主区域）：一个标签 = 一条保存的 WebSocket 连接。
 *
 * 和 ApiPage 的分工完全一致：多标签由 PanelView 承担、列表由 ApiPanel 承担，
 * 这里只负责「一条连接」的连接、收发与日志。连接由**主进程**建立
 * （`window.api.ws`），因此可以带自定义握手请求头、可以跳过 wss 自签证书校验。
 *
 * 与 HTTP 的两个关键差异：
 * - 这是**长连接**，`open` 立刻返回 connId，握手结果与后续帧都走事件推送，
 *   所以页面要订阅 `ws:event` 并只处理自己这条 connId 的事件。
 * - 草稿同样**不自动保存**：改完按 Ctrl/Cmd+S 才落盘。
 *   消息日志只存在内存里（关标签即丢），它不是配置，不需要落盘。
 */
export function WsPage({ requestId }: { requestId: string }) {
  const apiRequests = useAppStore((s) => s.apiRequests)
  const saveApiRequest = useAppStore((s) => s.saveApiRequest)
  const createApiRequest = useAppStore((s) => s.createApiRequest)
  const openApiTab = useAppStore((s) => s.openApiTab)
  const closePanelTab = useAppStore((s) => s.closePanelTab)
  const updatePanelTabTitle = useAppStore((s) => s.updatePanelTabTitle)
  const setEditorSaveStatus = useAppStore((s) => s.setEditorSaveStatus)

  const request = apiRequests.find((r) => r.id === requestId) ?? null
  /** 本标签是否是「未保存的新连接」草稿（requestId 为哨兵值，不是真实存储条目） */
  const isDraft = requestId === NEW_WS_REQUEST_ID

  // ---------- 连接配置草稿（不自动保存，Ctrl/Cmd+S 才落盘） ----------
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<ApiHeaderPair[]>([emptyHeader()])
  /** 子协议：界面上是逗号分隔的一行文本，落盘时拆成数组（见 parseProtocols） */
  const [subprotocols, setSubprotocols] = useState('')
  /** 跳过 wss 自签证书校验；落盘为 `rejectUnauthorized: false`（见下方说明） */
  const [skipTls, setSkipTls] = useState(false)

  // ---------- 连接状态 ----------
  const [state, setState] = useState<WsReadyState>('closed')
  /** 协商出来的子协议（服务端选的） */
  const [protocol, setProtocol] = useState('')
  const [connError, setConnError] = useState<string | null>(null)

  // ---------- 消息日志 ----------
  const [log, setLog] = useState<WsLogEntry[]>([])
  const [filter, setFilter] = useState<LogFilter>('all')

  // ---------- 发送区 ----------
  const [draft, setDraft] = useState('')
  const [encoding, setEncoding] = useState<MsgEncoding>('text')
  const [sending, setSending] = useState(false)

  // ---------- 视图与保存状态 ----------
  const [composerCollapsed, setComposerCollapsed] = useState(false)
  const [composerRatio, setComposerRatio] = useState(COMPOSER_RATIO_DEFAULT)
  const [configOpen, setConfigOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveNameOpen, setSaveNameOpen] = useState(false)
  const [saveName, setSaveName] = useState('')

  /** 页面根容器：拖动分隔条时按它的高度换算比例 */
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 连接行（地址 + 连接按钮）：它的底边就是日志区的顶边，用来算发送区的高度上限 */
  const connRowRef = useRef<HTMLDivElement | null>(null)
  /** 日志滚动容器：新帧到达时自动滚到底（用户手动往上翻了就不打扰） */
  const logRef = useRef<HTMLDivElement | null>(null)
  /**
   * 当前连接的 connId。
   *
   * 事件订阅只注册一次（不随 connId 变化重订阅），回调里用这个 ref 过滤，
   * 否则每次连接都要拆装一次监听。
   */
  const connIdRef = useRef<string | null>(null)
  /** 日志是否贴在底部（决定新帧到达要不要自动滚动） */
  const pinnedRef = useRef(true)

  /** 标记草稿有未保存改动（所有会改变「待保存内容」的地方都要调） */
  const markDirty = (): void => setDirty(true)

  /** 把保存状态投影到 store，供底部状态栏的 EditorSaveStatus 显示 */
  useEffect(() => {
    setEditorSaveStatus(
      editorSaveKey('ws', requestId),
      saving ? 'saving' : dirty ? 'dirty' : 'saved'
    )
  }, [requestId, saving, dirty, setEditorSaveStatus])

  /**
   * 追加一条日志（截断到 LOG_LIMIT 条）。
   * 只调用 setLog 的函数式更新，不闭包任何会变的值，所以事件回调里可以安全使用。
   */
  const pushLog = (entry: Omit<WsLogEntry, 'id'>): void => {
    setLog((prev) => {
      const next = [...prev, { ...entry, id: `${entry.at}-${prev.length}` }]
      return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next
    })
  }

  /**
   * 订阅主进程的连接事件 —— **只订阅一次**，用 connIdRef 过滤出自己这条连接。
   *
   * 注意 `error` 之后要把 connIdRef 清掉：握手失败时 undici 会先发 error 再发 close，
   * 清掉之后紧跟的 close 会被过滤掉，界面不会出现「一条错误 + 一条已关闭」的重复噪音，
   * 也避免某些实现只发 error 不发 close 时界面卡在「连接中」。
   */
  useEffect(() => {
    return window.api.ws.onEvent((ev: WsEvent) => {
      if (ev.connId !== connIdRef.current) return
      if (ev.type === 'open') {
        setState('open')
        setProtocol(ev.protocol)
        pushLog({
          dir: 'system',
          level: 'info',
          data: ev.protocol ? `已连接（子协议 ${ev.protocol}）` : '已连接',
          encoding: 'text',
          bytes: 0,
          at: Date.now()
        })
      } else if (ev.type === 'message') {
        pushLog({
          dir: 'received',
          data: ev.data,
          encoding: ev.encoding,
          bytes: ev.bytes,
          at: ev.at
        })
      } else if (ev.type === 'close') {
        setState('closed')
        connIdRef.current = null
        setProtocol('')
        pushLog({
          dir: 'system',
          level: ev.code === 1000 ? 'info' : 'error',
          data: `连接已关闭（${ev.code}${ev.reason ? ' ' + ev.reason : ''}）`,
          encoding: 'text',
          bytes: 0,
          at: ev.at
        })
      } else {
        setConnError(ev.message)
        setState('closed')
        connIdRef.current = null
        pushLog({
          dir: 'system',
          level: 'error',
          data: ev.message,
          encoding: 'text',
          bytes: 0,
          at: Date.now()
        })
      }
    })
  }, [])

  /**
   * 切换请求：用新连接重置草稿与连接（不冲刷未保存的改动 —— 那是用户自己的事）。
   * 顺带把上一条连接关掉：日志属于上一条连接，留着会张冠李戴。
   */
  useEffect(() => {
    const req = useAppStore.getState().apiRequests.find((r) => r.id === requestId) ?? null
    setName(req?.name ?? '')
    setUrl(req?.url ?? '')
    setHeaders(req?.headers?.length ? normalizeHeaders(req.headers) : [emptyHeader()])
    setSubprotocols((req?.subprotocols ?? []).join(', '))
    // 只有显式存了 false 才表示「跳过校验」：字段名沿用项目里 HTTP 那套
    // （undici 的 connect.rejectUnauthorized，false = 不校验）
    setSkipTls(req?.rejectUnauthorized === false)
    setDirty(false)
    setConnError(null)
    setProtocol('')
    setLog([])
    setState('closed')
    pinnedRef.current = true

    return () => {
      // 换请求 / 关标签：把连接关掉，别让主进程留着一条没人看的 socket
      const id = connIdRef.current
      if (id) {
        connIdRef.current = null
        void window.api.ws.close(id)
      }
    }
  }, [requestId])

  /** 草稿变动后同步标签标题（否则改名/改地址后标签还停在旧文字） */
  useEffect(() => {
    updatePanelTabTitle(apiTabId(requestId), apiTabTitle({ name, method: 'GET', url, protocol: 'ws' }))
  }, [name, url, requestId, updatePanelTabTitle])

  /** 新帧到达后自动滚到底（除非用户自己往上翻了） */
  useEffect(() => {
    const el = logRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [log])

  /**
   * 保存当前草稿 —— **唯一的落盘入口**，只有 Ctrl/Cmd+S 会走到这里。
   * 已保存的连接整条覆盖写；groupId 必须从 store 里现取带回去，
   * 否则按一次 Ctrl+S 就会把它从分组里踢出去。
   */
  const saveNow = async (): Promise<void> => {
    if (isDraft) {
      const nm = name.trim()
      if (!nm) {
        setSaveName('')
        setSaveNameOpen(true)
        return
      }
      await persistDraft(nm)
      return
    }
    setSaving(true)
    try {
      const current = useAppStore.getState().apiRequests.find((r) => r.id === requestId)
      await saveApiRequest({
        id: requestId,
        name: name.trim(),
        // WebSocket 没有方法：占位成 GET，列表里显示的是协议标记（WS）而不是它
        method: 'GET',
        url: url.trim(),
        headers,
        body: '',
        protocol: 'ws',
        subprotocols: parseProtocols(subprotocols),
        // 不跳过校验时**不写**这个字段：false 的语义恰好是「跳过」
        ...(skipTls ? { rejectUnauthorized: false } : {}),
        groupId: current?.groupId,
        createdAt: 0,
        updatedAt: 0
      })
      setDirty(false)
      message.success('已保存')
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  /** 草稿真正落盘：按给定名称写入列表，并把草稿标签切成真实标签 */
  const persistDraft = async (nm: string): Promise<void> => {
    setSaving(true)
    try {
      const gid = useAppStore
        .getState()
        .ui.panelTabs.find((t) => t.id === apiTabId(NEW_WS_REQUEST_ID))?.apiGroupId
      const id = await createApiRequest({
        name: nm,
        method: 'GET',
        url: url.trim(),
        headers,
        body: '',
        protocol: 'ws',
        subprotocols: parseProtocols(subprotocols),
        ...(skipTls ? { rejectUnauthorized: false } : {}),
        groupId: gid
      })
      // 草稿标签 → 真实标签：关掉草稿（其卸载清理会顺手断开连接），避免残留空白标签
      closePanelTab(apiTabId(NEW_WS_REQUEST_ID))
      openApiTab(id)
      message.success('已保存')
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  /** 弹窗确认落盘：名称取自弹窗输入框（为空则不提交） */
  const confirmSaveDraft = async (): Promise<void> => {
    const nm = saveName.trim()
    if (!nm) return
    await persistDraft(nm)
    setSaveNameOpen(false)
  }

  // ---------- 连接 ----------
  const connect = async (): Promise<void> => {
    const target = url.trim()
    if (!target) {
      setConnError('请填写连接地址')
      return
    }
    if (!/^wss?:\/\//i.test(target)) {
      setConnError('地址需以 ws:// 或 wss:// 开头')
      return
    }
    setConnError(null)
    // connId 必须**先**定下来再发起连接：握手可能快到 IPC 回包之前就完成，
    // 事件回调是靠 connIdRef 过滤的，晚一步设就会把 open/首帧当成别人的连接丢掉
    const id = newConnId()
    connIdRef.current = id
    setState('connecting')
    pushLog({
      dir: 'system',
      level: 'info',
      data: `正在连接 ${target}`,
      encoding: 'text',
      bytes: 0,
      at: Date.now()
    })

    const options: WsConnectOptions = { url: target }
    const headerMap = pairsToHeaders(headers)
    if (Object.keys(headerMap).length) options.headers = headerMap
    const protocols = parseProtocols(subprotocols)
    if (protocols.length) options.protocols = protocols
    if (skipTls) options.rejectUnauthorized = false

    try {
      const res = await window.api.ws.open(id, options)
      if (res.error) {
        connIdRef.current = null
        setConnError(res.error)
        setState('closed')
        pushLog({
          dir: 'system',
          level: 'error',
          data: res.error,
          encoding: 'text',
          bytes: 0,
          at: Date.now()
        })
        return
      }
      if (res.warning) {
        pushLog({
          dir: 'system',
          level: 'error',
          data: `注意：${res.warning}`,
          encoding: 'text',
          bytes: 0,
          at: Date.now()
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      connIdRef.current = null
      setConnError(msg)
      setState('closed')
      pushLog({ dir: 'system', level: 'error', data: msg, encoding: 'text', bytes: 0, at: Date.now() })
    }
  }

  /** 断开：先切到 closing（按钮进入 loading 且不可重复点），真正的 closed 由 close 事件带回来 */
  const disconnect = (): void => {
    const id = connIdRef.current
    if (!id) return
    setState('closing')
    void window.api.ws.close(id)
  }

  // ---------- 发送 ----------
  const send = async (): Promise<void> => {
    const id = connIdRef.current
    if (!id || state !== 'open') {
      message.warning('连接尚未就绪')
      return
    }
    if (!draft) return
    setSending(true)
    try {
      const res = await window.api.ws.send(id, { data: draft, encoding })
      if (!res.ok) {
        const msg = res.error ?? '发送失败'
        message.error(msg)
        pushLog({ dir: 'system', level: 'error', data: msg, encoding: 'text', bytes: 0, at: Date.now() })
        return
      }
      pushLog({
        dir: 'sent',
        data: draft,
        encoding,
        bytes: payloadBytes(draft, encoding),
        at: Date.now()
      })
    } catch (e) {
      message.error('发送失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSending(false)
    }
  }

  // ---------- 请求头增删改（与 ApiPage 同一套「末行自动补空槽位」交互） ----------
  const updateHeader = (idx: number, field: keyof ApiHeaderPair, value: string): void => {
    setHeaders((prev) =>
      tidyHeaderRows(prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)))
    )
    markDirty()
  }
  const removeHeader = (idx: number): void => {
    setHeaders((prev) => tidyHeaderRows(prev.filter((_, i) => i !== idx)))
    markDirty()
  }

  /**
   * 拖动分隔条调整发送区高度。
   *
   * 与 ApiPage 的响应分隔条同一套算法：按根容器高度换算成比例（窗口缩放后仍正确），
   * 上限由「日志区至少留 MIN_LOG_PANE_H」反推；用 pointer capture 把指针锁在分隔条上。
   */
  const startResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget
    const pointerId = e.pointerId
    const rootRect = rootRef.current?.getBoundingClientRect()
    const rowRect = connRowRef.current?.getBoundingClientRect()
    if (!rootRect || !rowRect || rootRect.height <= 0) return
    const total = rootRect.height
    const startY = e.clientY
    const startRatio = composerRatio
    // 日志区之上还有工具栏 + 连接行（固定高度），上限要从这里减掉
    const fixedAbove = rowRect.bottom - rootRect.top
    const maxRatio = Math.min(
      COMPOSER_RATIO_MAX,
      Math.max(COMPOSER_RATIO_MIN, (total - fixedAbove - MIN_LOG_PANE_H) / total)
    )

    const move = (ev: PointerEvent): void => {
      const next = startRatio - (ev.clientY - startY) / total
      setComposerRatio(Math.min(maxRatio, Math.max(COMPOSER_RATIO_MIN, next)))
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      try {
        handle.releasePointerCapture(pointerId)
      } catch {
        // 指针已经释放（如 pointercancel）时忽略
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      // 合成事件没有真实指针，退化为 window 监听即可
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  /** 快捷键：Ctrl/Cmd+S 保存（唯一的保存方式），Ctrl/Cmd+Enter 发送一帧 */
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    if (e.key.toLowerCase() === 's') {
      e.preventDefault()
      void saveNow()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void send()
    }
  }

  if (!request && !isDraft) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <Cable className="size-12 opacity-30" />
        <div className="text-sm">该连接已被删除</div>
        <div className="text-xs text-muted-foreground/70">从左侧列表选择其他连接</div>
      </div>
    )
  }

  const isOpen = state === 'open'
  const busy = state === 'connecting' || state === 'closing'
  const headerCount = Object.keys(pairsToHeaders(headers)).length
  const shown = filter === 'all' ? log : log.filter((e) => e.dir === filter)
  const sentCount = log.filter((e) => e.dir === 'sent').length
  const recvCount = log.filter((e) => e.dir === 'received').length

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-background" onKeyDown={onKeyDown}>
      {/* 工具栏：名称 + 连接状态 + 连接配置（保存状态在底部状态栏，见 EditorSaveStatus） */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            markDirty()
          }}
          placeholder="连接名称（可选，缺省显示地址）"
          variant="borderless"
          className="min-w-0 flex-1 text-[15px] font-semibold"
        />
        <Tag
          className="m-0 shrink-0 font-medium"
          color={
            isOpen
              ? 'success'
              : state === 'connecting'
                ? 'processing'
                : state === 'closing'
                  ? 'warning'
                  : 'default'
          }
        >
          {STATE_LABEL[state]}
        </Tag>
        {isOpen && protocol && (
          <span className="shrink-0 text-xs text-muted-foreground" title="服务端协商出的子协议">
            子协议 {protocol}
          </span>
        )}
        <Button
          type="text"
          size="small"
          className="shrink-0 gap-1.5 text-xs text-muted-foreground"
          title="握手请求头 / 子协议 / TLS 选项"
          onClick={() => setConfigOpen(true)}
        >
          <Settings2 className="size-3.5" />
          连接配置{headerCount ? ` (${headerCount})` : ''}
        </Button>
      </div>

      {/* 连接行：协议标记 + 地址 + 连接/断开 */}
      <div ref={connRowRef} className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-xs font-semibold text-sky-500">
          WS
        </span>
        <Input
          value={url}
          onChange={(e: ReactChangeEvent<HTMLInputElement>) => {
            setUrl(e.target.value)
            markDirty()
          }}
          placeholder="连接地址，如 wss://echo.example.com/socket"
          className="min-w-0 flex-1 font-mono text-xs"
        />
        {isOpen || busy ? (
          <Button
            danger
            icon={<Unplug className="size-4" />}
            loading={state === 'closing'}
            onClick={disconnect}
            disabled={state === 'closing'}
            title="断开连接"
          >
            断开
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<Cable className="size-4" />}
            onClick={() => void connect()}
            title="建立连接（Ctrl+Enter 发送消息）"
          >
            连接
          </Button>
        )}
      </div>

      {connError && (
        <div className="flex shrink-0 items-center gap-1.5 px-3 pb-1 text-xs text-destructive">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={connError}>
            {connError}
          </span>
        </div>
      )}

      {/* 日志区：主区域，占满剩余高度（overflow-hidden：被压扁时裁掉，不要溢到发送区上） */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 px-3 py-1.5 text-xs">
          <TabButtons tabs={LOG_FILTERS} value={filter} onChange={setFilter} />
          <span className="text-muted-foreground">{shown.length} 条</span>
          <span className="text-muted-foreground/70">
            <ArrowUpRight className="mr-0.5 inline size-3" />
            {sentCount}
            <ArrowDownLeft className="mx-0.5 inline size-3" />
            {recvCount}
          </span>
          <Button
            type="text"
            size="small"
            className="ml-auto shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
            title="清空消息日志（日志只存在内存里，关标签即丢）"
            disabled={log.length === 0}
            onClick={() => setLog([])}
          >
            <Eraser className="size-3.5" />
            清空
          </Button>
        </div>

        <div
          ref={logRef}
          className="min-h-0 flex-1 select-text overflow-auto px-1.5 pb-2"
          onScroll={(e) => {
            const el = e.currentTarget
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {shown.length === 0 ? (
            <div className="mx-2 mt-6 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              {log.length === 0
                ? '还没有消息。填好地址点「连接」，连上后在下方发送区收发消息。'
                : `没有符合「${LOG_FILTERS.find((f) => f.key === filter)?.label}」的日志。`}
            </div>
          ) : (
            <div className="flex flex-col">
              {shown.map((entry) => (
                <LogRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/*
        拖拽条：调整发送区高度。**常驻**（只在折叠时隐藏）——
        不能等连上才出现，否则没连接时根本抓不到这条分隔线。
      */}
      {!composerCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整发送区高度"
          className="group/cs relative z-20 -my-1 h-2 shrink-0 cursor-row-resize select-none"
          title="拖动调整发送区高度"
          onPointerDown={startResize}
        >
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover/cs:bg-primary" />
        </div>
      )}

      {/*
        发送区：高度由上面的分隔条拖动决定（没折叠就固定占比，保证拖动一定有可见效果）。
        bg-background 必须显式写：这一块是不透明的面板，否则下面被压扁的日志区会透出来。
      */}
      <div
        className="flex shrink-0 flex-col overflow-hidden bg-background"
        style={composerCollapsed ? undefined : { height: Math.round(composerRatio * 100) + '%' }}
      >
        <div className="flex shrink-0 items-center gap-3 px-3 py-1.5 text-xs">
          <span className="shrink-0 font-medium text-muted-foreground">发送</span>
          <TabButtons tabs={MSG_ENCODINGS} value={encoding} onChange={setEncoding} />
          <span className="truncate text-muted-foreground/70">
            {encoding === 'text' ? '按文本帧发送' : '把内容当 base64 解成二进制帧发送'}
          </span>
          {encoding === 'text' && (
            <button
              className="shrink-0 rounded px-2 py-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              title="按 JSON 美化发送内容（不改变语义）"
              onClick={() => setDraft((v) => prettyJson(v))}
            >
              格式化
            </button>
          )}
          <span className="ml-auto shrink-0 text-muted-foreground/70">Ctrl+Enter 发送</span>
          <Button
            type="primary"
            size="small"
            className="shrink-0"
            icon={<Send className="size-3.5" />}
            loading={sending}
            disabled={!isOpen || sending || !draft}
            onClick={() => void send()}
            title={isOpen ? '发送一帧（Ctrl+Enter）' : '连接建立后才能发送'}
          >
            发送
          </Button>
          <button
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            title={composerCollapsed ? '展开发送区' : '折叠发送区'}
            onClick={() => setComposerCollapsed((v) => !v)}
          >
            {composerCollapsed ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </button>
        </div>

        {!composerCollapsed && (
          <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3">
            <div className="h-full overflow-hidden">
              <MonacoEditor
                value={draft}
                onChange={setDraft}
                language={encoding === 'base64' ? 'plaintext' : 'json'}
                showLanguageSelector={encoding === 'text'}
                showWordWrapToggle
                showCopyButton
                toolbar={
                  isOpen ? undefined : (
                    <span className="shrink-0 text-xs text-amber-600 dark:text-amber-400">
                      尚未连接，发送按钮在连接建立后才可用
                    </span>
                  )
                }
              />
            </div>
          </div>
        )}
      </div>

      {/* 连接配置抽屉：握手请求头 / 子协议 / TLS —— 都是「设一次就不动」的东西，不占主界面 */}
      <Drawer
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        placement="right"
        size={520}
        title={
          <div className="min-w-0">
            <div className="text-sm">连接配置</div>
            <div className="text-xs text-muted-foreground">
              握手时带上，改完按 Ctrl/Cmd+S 保存
            </div>
          </div>
        }
        footer={
          <div className="flex justify-end">
            <Button size="small" onClick={() => setConfigOpen(false)}>
              关闭
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-5">
          <section>
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              握手请求头
              <span className="ml-2 font-normal text-muted-foreground/70">
                浏览器原生 WebSocket 不允许设头，这里是主进程代发的
              </span>
            </div>
            {/* 不用 antd Table（强制 rowKey），与 ApiPage 一样直接铺 flex 行 */}
            <div className="flex flex-col divide-y divide-border/40">
              {headers.map((h, i) => {
                const suggestions = headerValueSuggestions(h.key)
                return (
                  <div key={i} className="flex items-center gap-2 py-1">
                    <div className="w-[180px] shrink-0">
                      <AutoComplete
                        value={h.key}
                        options={COMMON_HEADERS.map((n) => ({ value: n }))}
                        onChange={(v) => updateHeader(i, 'key', v)}
                        placeholder="名称，如 Authorization"
                        className="w-full"
                        showSearch={{
                          filterOption: (input, option) =>
                            (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                        }}
                      >
                        <Input
                          size="small"
                          variant="filled"
                          className="font-mono text-xs"
                          style={{ height: 32 }}
                        />
                      </AutoComplete>
                    </div>
                    <div className="min-w-0 flex-1">
                      <AutoComplete
                        value={h.value}
                        options={suggestions ? suggestions.map((v) => ({ value: v })) : []}
                        onChange={(v) => updateHeader(i, 'value', v)}
                        placeholder={suggestions ? '可从常见取值中选择' : '值'}
                        className="w-full"
                        showSearch={{
                          filterOption: suggestions
                            ? (input, option) =>
                              (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                            : false
                        }}
                      >
                        <Input
                          size="small"
                          variant="filled"
                          className="font-mono text-xs"
                          style={{ height: 32 }}
                        />
                      </AutoComplete>
                    </div>
                    <div className="w-8 shrink-0 text-center">
                      {/* 末行空槽位不给删除按钮：删了 tidyHeaderRows 也会立刻补回来 */}
                      {i === headers.length - 1 && isBlankHeader(h) ? null : (
                        <Button
                          type="text"
                          size="small"
                          className="size-7 text-muted-foreground"
                          title="删除该请求头"
                          icon={<Trash2 className="size-3.5" />}
                          onClick={() => removeHeader(i)}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <section>
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              子协议（Sec-WebSocket-Protocol）
            </div>
            <Input
              value={subprotocols}
              onChange={(e) => {
                setSubprotocols(e.target.value)
                markDirty()
              }}
              placeholder="多个用逗号分隔，如 graphql-ws, json"
              className="font-mono text-xs"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              留空则不发送该请求头；服务端选中哪一个会显示在工具栏上。
            </p>
          </section>

          <section>
            <div className="mb-2 text-xs font-medium text-muted-foreground">TLS</div>
            <Checkbox
              checked={skipTls}
              onChange={(e) => {
                setSkipTls(e.target.checked)
                markDirty()
              }}
            >
              <span className="text-xs">跳过证书校验（仅 wss 自签证书时使用）</span>
            </Checkbox>
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" />
              <span>开启后该连接的证书不再校验，仅建议在调试自签证书服务时临时使用。</span>
            </p>
          </section>
        </div>
      </Drawer>

      {/* 草稿按 Ctrl/Cmd+S 时名称为空才走到这里：要求补一个名称再落盘 */}
      <Modal
        open={saveNameOpen}
        onCancel={() => setSaveNameOpen(false)}
        title="保存 WebSocket 连接"
        okText="保存"
        cancelText="取消"
        centered
        width={400}
        destroyOnHidden
        okButtonProps={{ disabled: !saveName.trim() }}
        onOk={() => void confirmSaveDraft()}
      >
        <Input
          autoFocus
          placeholder="连接名称，如：本地推送服务"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onPressEnter={() => void confirmSaveDraft()}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          保存后该连接才会显示在左侧列表中（消息日志不落盘）。
        </p>
      </Modal>
    </div>
  )
}

/** 连接状态的中文名（工具栏 Tag 用） */
const STATE_LABEL: Record<WsReadyState, string> = {
  connecting: '连接中',
  open: '已连接',
  closing: '断开中',
  closed: '未连接'
}

/** 日志行：时间 · 方向 · 编码 · 体积 · 内容 */
function LogRow({ entry }: { entry: WsLogEntry }) {
  const isSystem = entry.dir === 'system'
  const text = entry.encoding === 'text' && !isSystem ? prettyJson(entry.data) : entry.data
  return (
    <div
      className={cn(
        'flex items-start gap-2 border-b border-border/40 px-2 py-1.5',
        isSystem && entry.level === 'error' && 'bg-destructive/5'
      )}
    >
      <span className="w-[68px] shrink-0 font-mono text-[10px] leading-4 text-muted-foreground/70">
        {clockOf(entry.at)}
      </span>
      {isSystem ? (
        <>
          <span
            className={cn(
              'w-12 shrink-0 text-[10px] leading-4',
              entry.level === 'error' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {entry.level === 'error' ? '错误' : '系统'}
          </span>
          <span className="w-14 shrink-0" />
          <span
            className={cn(
              'min-w-0 flex-1 whitespace-pre-wrap break-all text-xs leading-4',
              entry.level === 'error' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {entry.data}
          </span>
        </>
      ) : (
        <>
          <span
            className={cn(
              'flex w-12 shrink-0 items-center gap-1 text-[10px] leading-4',
              entry.dir === 'sent' ? 'text-blue-500' : 'text-emerald-500'
            )}
          >
            {entry.dir === 'sent' ? (
              <ArrowUpRight className="size-3 shrink-0" />
            ) : (
              <ArrowDownLeft className="size-3 shrink-0" />
            )}
            {entry.dir === 'sent' ? '发送' : '接收'}
          </span>
          <span className="w-14 shrink-0 text-[10px] leading-4 text-muted-foreground/70">
            {entry.encoding === 'base64' ? 'binary' : 'text'}
          </span>
          <span className="w-14 shrink-0 text-right font-mono text-[10px] leading-4 text-muted-foreground/70">
            {formatBytes(entry.bytes)}
          </span>
          {/* 长帧不截断，容器内滚动：调试时经常要看完整的 payload */}
          <pre className="max-h-48 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-4">
            {text}
          </pre>
        </>
      )}
    </div>
  )
}

/** 逗号 / 空白分隔的子协议串 → 数组（去空、去重保序） */
function parseProtocols(raw: string): string[] {
  const out: string[] = []
  for (const p of raw.split(/[,\s]+/)) {
    const v = p.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/**
 * 生成连接 id。
 *
 * 用 `crypto.randomUUID()` 更省事，但渲染端在 `file://` 下不一定是 secure context，
 * 所以按项目里其它地方的写法用「时间戳 + 随机数」，冲突概率可以忽略。
 */
function newConnId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 一帧的字节数：文本按 utf8，base64 按解码后的长度估算 */
function payloadBytes(data: string, encoding: MsgEncoding): number {
  if (encoding === 'base64') {
    const clean = data.replace(/\s+/g, '')
    const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor((clean.length * 3) / 4) - pad)
  }
  return new TextEncoder().encode(data).length
}

/** 时间戳 → HH:MM:SS.mmm（帧日志要精确到毫秒，relTime 那种「几秒前」不适合） */
function clockOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/**
 * 能当 JSON 解析就美化输出（只影响显示，发送的仍是原文）。
 * 解析不了就原样返回 —— 不因为「看起来像 JSON」就改写用户的字节。
 */
function prettyJson(text: string): string {
  const t = text.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return text
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return text
  }
}
