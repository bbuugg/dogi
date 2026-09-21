import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { ChevronDown, ChevronUp, Globe, History, Send, Trash2 } from 'lucide-react'
import { AutoComplete, Button, Drawer, Input, Modal, Select, Tag, message } from 'antd'
import { apiTabId, apiTabTitle, editorSaveKey, NEW_API_REQUEST_ID, useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import MonacoEditor from '@/components/MonacoEditor'
import {
  COMMON_HEADERS,
  METHODS,
  bodyLanguageOf,
  contentTypeOf,
  emptyHeader,
  formatBody,
  formatBytes,
  headerValueSuggestions,
  isBlankHeader,
  normalizeHeaders,
  pairsToHeaders,
  parseQueryParams,
  relTime,
  serializeParams,
  statusClass,
  tidyHeaderRows,
  withQuery
} from '@/lib/api-client'
import type { ApiHeaderPair, ApiHttpResponse } from '@shared/types'

/** 请求超时（毫秒） */
const TIMEOUT_MS = 30_000
/** 响应面板高度占比的默认值与上下限（拖动分隔条时按此范围夹取） */
const RES_RATIO_DEFAULT = 0.45
const RES_RATIO_MIN = 0.15
const RES_RATIO_MAX = 0.8
/**
 * 请求构造区（请求头 / 请求体）至少保留的高度（px）。
 * 只按比例卡上限是不够的：窗口一矮，80% 的响应面板照样能把请求区压成 0，
 * 压扁后请求区内容会溢出、透过响应面板显出来，所以还要按像素留底。
 */
const MIN_REQ_PANE_H = 120

/**
 * 请求构造区的分段切换项。
 * 与响应区共用 `TabButtons`，所以两处样式天然一致（改一处两边都变）。
 */
const REQ_TABS = [
  { key: 'headers', label: '请求头' },
  { key: 'params', label: '参数' },
  { key: 'body', label: '请求体' }
] as const

/**
 * 接口请求编辑页（主区域）：一个标签 = 一个已保存的请求。
 *
 * 与原 api-client 插件的区别：请求的「多标签」由 PanelView 承担，
 * 「已保存请求列表」由 ApiPanel 承担，所以这里只专注单个请求的构造与响应查看。
 * 请求由主进程发出（window.api.apiClient.send），因此不受渲染进程 CORS 限制。
 *
 * 草稿**不自动保存**：改完按 Ctrl/Cmd+S 才落盘（保存成功给 message 提示）。
 */
export function ApiPage({ requestId }: { requestId: string }) {
  const apiRequests = useAppStore((s) => s.apiRequests)
  const saveApiRequest = useAppStore((s) => s.saveApiRequest)
  const createApiRequest = useAppStore((s) => s.createApiRequest)
  const openApiTab = useAppStore((s) => s.openApiTab)
  const closePanelTab = useAppStore((s) => s.closePanelTab)
  const apiHistory = useAppStore((s) => s.apiHistory)
  const recordApiHistory = useAppStore((s) => s.recordApiHistory)
  const clearApiHistory = useAppStore((s) => s.clearApiHistory)
  const updatePanelTabTitle = useAppStore((s) => s.updatePanelTabTitle)
  const setEditorSaveStatus = useAppStore((s) => s.setEditorSaveStatus)

  const request = apiRequests.find((r) => r.id === requestId) ?? null
  /** 本标签是否是「未保存的新请求」草稿（requestId 为哨兵值，不是真实存储条目） */
  const isDraft = requestId === NEW_API_REQUEST_ID

  // ---------- 请求草稿 ----------
  // 不自动保存：改完必须按 Ctrl/Cmd+S 才落盘。标签保持挂载，所以切走再回来草稿还在；
  // 但**关掉标签**就会丢掉未保存的改动（这是「不自动保存」的必然代价）。
  const [name, setName] = useState('')
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<ApiHeaderPair[]>([emptyHeader()])
  /**
   * 查询参数表。URL 的查询串是它的唯一事实来源（不另存一份），
   * 所以这里只是「查询串的可编辑视图」：改 URL 的查询 → 解析进本表；
   * 改本表 → 序列化回 URL 的查询串（见 paramsRef 旁的同步 effect）。
   */
  const [params, setParams] = useState<ApiHeaderPair[]>([emptyHeader()])
  const [body, setBody] = useState('')
  /**
   * 请求体编辑器（Monaco）的高亮语言。
   * 不做持久化：它由 Content-Type 推导（见 bodyLanguageOf），
   * 内容类型才是唯一的事实来源 —— 换了 Content-Type 高亮就该跟着换。
   */
  const [bodyLanguage, setBodyLanguage] = useState('json')

  // ---------- 视图状态（无需持久化；标签保持挂载，所以切标签不丢） ----------
  const [reqTab, setReqTab] = useState<'headers' | 'params' | 'body'>('headers')
  const [resTab, setResTab] = useState<'body' | 'headers'>('body')
  const [sending, setSending] = useState(false)
  /**
   * 草稿是否有未保存的改动 / 是否正在落盘。
   * 只用于投影到底部状态栏（见 EditorSaveStatus）—— 接口请求**不自动保存**，
   * 所以「未保存」是常态而非异常，这里只负责如实反映，不触发任何自动保存。
   */
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [response, setResponse] = useState<ApiHttpResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 响应正文：本地可编辑副本；用 Monaco 展示并允许其格式化按钮美化（不落盘） */
  const [respBody, setRespBody] = useState('')
  const [respCollapsed, setRespCollapsed] = useState(false)
  /** 未保存草稿按 Ctrl/Cmd+S 且**没填名称**时才弹窗要请求名；填了就直接落盘 */
  const [saveNameOpen, setSaveNameOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [resRatio, setResRatio] = useState(RES_RATIO_DEFAULT)
  const [historyOpen, setHistoryOpen] = useState(false)
  /** 页面根容器：拖动分隔条时按它的高度换算比例（不依赖 parentElement 的层级假设） */
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 请求行（方法 + 地址 + 发送）：它的底边就是请求构造区的顶边，用来算响应面板的高度上限 */
  const reqRowRef = useRef<HTMLDivElement | null>(null)

  /** 标记草稿有未保存改动：所有会改变「待保存内容」的地方（名称/方法/地址/头/参数/请求体）都要调 */
  const markDirty = (): void => setDirty(true)

  /** 把保存状态投影到 store，供底部状态栏的 EditorSaveStatus 显示 */
  useEffect(() => {
    setEditorSaveStatus(
      editorSaveKey('api', requestId),
      saving ? 'saving' : dirty ? 'dirty' : 'saved'
    )
  }, [requestId, saving, dirty, setEditorSaveStatus])

  /**
   * 新响应到达时，把正文按内容类型美化后放进可编辑副本（Monaco 展示 + 允许格式化按钮）。
   * 放在 early return 之前：它是纯派生副作用，不依赖 request 是否存在。
   */
  useEffect(() => {
    if (response) {
      const ct = response.headers?.['content-type'] || ''
      setRespBody(formatBody(response.body, ct, true))
    }
  }, [response])

  /**
   * 保存当前草稿 —— **唯一的落盘入口**，只有 Ctrl/Cmd+S 会走到这里。
   * 不做自动保存、不在切标签 / 关标签时偷偷写盘。
   *
   * - 未保存草稿：已填名称就直接落盘，没填才弹窗要请求名（见 persistDraft）。
   * - 已保存请求：整条覆盖写；groupId 必须从 store 里现取带回去 —— 否则按一次
   *   Ctrl+S 就会把请求从分组里踢出去（分组归属只由侧边栏的拖拽重排改动）。
   */
  const saveNow = async (): Promise<void> => {
    // 未保存草稿：名称是新建落盘的必需项；已填就不弹窗，没填才要用户补
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
        method,
        url: url.trim(),
        headers,
        body,
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
      // 草稿标签上记着「目标分组」：在分组里点「新建」时带过来
      const gid = useAppStore
        .getState()
        .ui.panelTabs.find((t) => t.id === apiTabId(NEW_API_REQUEST_ID))?.apiGroupId
      const id = await createApiRequest({
        name: nm,
        method,
        url: url.trim(),
        headers,
        body,
        groupId: gid
      })
      // 草稿标签 → 真实标签：关掉草稿，避免残留一个空白标签
      closePanelTab(apiTabId(NEW_API_REQUEST_ID))
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

  /** 切换请求：用新请求重置草稿（不冲刷未保存的改动 —— 那是用户自己的事） */
  useEffect(() => {
    const req = useAppStore.getState().apiRequests.find((r) => r.id === requestId) ?? null
    setName(req?.name ?? '')
    setMethod(req?.method ?? 'GET')
    setUrl(req?.url ?? '')
    setHeaders(req?.headers?.length ? normalizeHeaders(req.headers) : [emptyHeader()])
    // 查询参数表从 URL 的查询串解析出来（不另存，URL 才是事实来源）
    setParams(tidyHeaderRows(parseQueryParams(req?.url ?? '')))
    setBody(req?.body ?? '')
    // 编辑器语言跟着这个请求的 Content-Type 走（没有 Content-Type 时给 json）
    setBodyLanguage(bodyLanguageOf(contentTypeOf(req?.headers ?? [])))
    // 响应与错误属于「上一次请求的结果」，换请求时清空避免张冠李戴
    setResponse(null)
    setError(null)
    // 刚载入 = 与磁盘一致（新建草稿则是「还没有任何待保存内容」）
    setDirty(false)
  }, [requestId])

  /** 草稿变动后同步标签标题（否则改名/改地址后标签还停在旧文字） */
  useEffect(() => {
    updatePanelTabTitle(apiTabId(requestId), apiTabTitle({ name, method, url }))
  }, [name, method, url, requestId, updatePanelTabTitle])

  /**
   * 参数表 → URL 的同步（与 onUrlChange 形成双向）。
   * 仅当参数表变化时触发：把整张表序列化回 URL 的查询串。
   * 因为 onUrlChange 已经把「URL 改动」解析进了参数表，这里序列化回去
   * 得到的就是同源字符串，setUrl 会被 React 的同值跳过（除非确实存在差异，
   * 例如用户改了某个参数行的值），所以不会和地址框输入形成回环。
   */
  useEffect(() => {
    const candidate = withQuery(url, serializeParams(params))
    if (candidate !== url) setUrl(candidate)
    // 只依赖 params：本 effect 要的是「用当前 URL 替换其查询串」，
    // 闭包里的 url 就是本次提交时的地址（已是上一次同步后的结果）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  // ---------- 请求头增删改 ----------
  // 没有「添加请求头」按钮：末行填了内容就自动补一个空槽位（见 tidyHeaderRows），
  // 所以表格最后一行永远是待填的那一行。
  const updateHeader = (idx: number, field: keyof ApiHeaderPair, value: string): void => {
    setHeaders((prev) =>
      tidyHeaderRows(prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)))
    )
    // 改的是 Content-Type 的值 → 请求体编辑器的高亮语言跟着换
    // （只看「值」的改动，且这一行的键名得本来就是 content-type；
    //  否则用户随手改别的头名也会把手动选的语言冲掉）
    if (field === 'value' && (headers[idx]?.key ?? '').trim().toLowerCase() === 'content-type') {
      setBodyLanguage(bodyLanguageOf(value))
    }
    markDirty()
  }
  const removeHeader = (idx: number): void => {
    setHeaders((prev) => tidyHeaderRows(prev.filter((_, i) => i !== idx)))
    markDirty()
  }

  // ---------- 查询参数（与请求头同样的「末行空槽位」交互，但无补全/无下拉） ----------
  const updateParam = (idx: number, field: keyof ApiHeaderPair, value: string): void => {
    setParams((prev) =>
      tidyHeaderRows(prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)))
    )
    markDirty()
  }
  const removeParam = (idx: number): void => {
    setParams((prev) => tidyHeaderRows(prev.filter((_, i) => i !== idx)))
    markDirty()
  }

  /**
   * 地址框输入：直接把新 URL 落盘到草稿，同时把查询串解析进参数表
   * （这是「URL → 表格」这一向的同步；「表格 → URL」由下面的 effect 负责）。
   */
  const onUrlChange = (e: ReactChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value
    setUrl(raw)
    setParams(tidyHeaderRows(parseQueryParams(raw)))
    markDirty()
  }

  // ---------- 发送 ----------
  const send = async (): Promise<void> => {
    const trimmed = url.trim()
    if (!trimmed) {
      setError('请填写请求地址')
      return
    }
    setSending(true)
    setError(null)
    setResponse(null)
    let res: ApiHttpResponse | null = null
    try {
      res = await window.api.apiClient.send({
        method,
        url: trimmed,
        headers: pairsToHeaders(headers),
        body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
        timeoutMs: TIMEOUT_MS
      })
      setResponse(res)
      if (res.error) message.error('请求失败：' + res.error)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      message.error('请求失败：' + msg)
    } finally {
      setSending(false)
      // 失败也记历史（status=0），便于回看「当时发的是什么」
      void recordApiHistory({
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        method,
        url: trimmed,
        headers,
        body,
        status: res?.status ?? 0,
        statusText: res?.statusText ?? '',
        timeMs: res?.timeMs ?? 0,
        at: Date.now()
      })
    }
  }

  /** 载入一条历史到当前草稿 */
  const applyHistory = (entry: {
    method: string
    url: string
    headers: unknown
    body: string
  }): void => {
    const nextHeaders = normalizeHeaders(entry.headers)
    setMethod(entry.method || 'GET')
    setUrl(entry.url || '')
    setParams(tidyHeaderRows(parseQueryParams(entry.url || '')))
    setHeaders(nextHeaders)
    setBody(entry.body || '')
    setBodyLanguage(bodyLanguageOf(contentTypeOf(nextHeaders)))
    setReqTab('headers')
    // 载入历史 = 改动了草稿内容，同样算未保存
    markDirty()
  }

  /**
   * 拖动分隔条调整响应面板高度。
   *
   * 高度按「页面根容器」的高度换算成比例，所以窗口缩放后仍然正确；
   * 上限不是死比例，而是「请求构造区至少留 MIN_REQ_PANE_H」反推出来的，
   * 否则能一路把请求区压成 0、让响应面板盖住请求头。
   * 用 pointer capture 把后续事件锁在分隔条上，避免被页面里其它滚动容器 / 拖拽层
   * 抢走指针（拿不到 capture 时退化为 window 监听，行为一致）。
   */
  const startResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget
    const pointerId = e.pointerId
    const rootRect = rootRef.current?.getBoundingClientRect()
    const reqRect = reqRowRef.current?.getBoundingClientRect()
    if (!rootRect || !reqRect || rootRect.height <= 0) return
    const total = rootRect.height
    const startY = e.clientY
    const startRatio = resRatio
    // 请求构造区之上还有工具栏 + 请求行（固定高度），上限要从这里减掉，
    // 否则「上方留 120px」会被这两行吃掉，请求区实际只剩几十像素。
    const fixedAbove = reqRect.bottom - rootRect.top
    const maxRatio = Math.min(
      RES_RATIO_MAX,
      Math.max(RES_RATIO_MIN, (total - fixedAbove - MIN_REQ_PANE_H) / total)
    )

    const move = (ev: PointerEvent): void => {
      const next = startRatio - (ev.clientY - startY) / total
      setResRatio(Math.min(maxRatio, Math.max(RES_RATIO_MIN, next)))
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

  /**
   * 快捷键：Ctrl/Cmd+S 保存（这是唯一的保存方式），Ctrl/Cmd+Enter 发送。
   * 限定在页内（onKeyDown 挂在根容器上），避免多标签同时触发。
   */
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
        <Globe className="size-12 opacity-30" />
        <div className="text-sm">该请求已被删除</div>
        <div className="text-xs text-muted-foreground/70">从左侧列表选择其他请求</div>
      </div>
    )
  }

  const contentType = response?.headers?.['content-type'] || ''
  const respLang = bodyLanguageOf(contentType)
  const respHeaders = response ? Object.entries(response.headers || {}) : []
  const statusOk = response && response.status > 0 && response.status < 400

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-background" onKeyDown={onKeyDown}>
      {/* 工具栏：名称 + 历史（新建与导入 cURL 在侧边栏；保存状态在底部状态栏，见 EditorSaveStatus） */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            markDirty()
          }}
          placeholder="请求名称（可选，缺省显示「方法 + 路径」）"
          variant="borderless"
          className="min-w-0 flex-1 text-[15px] font-semibold"
        />
        <Button
          type="text"
          size="small"
          className="shrink-0 gap-1.5 text-[11px] text-muted-foreground"
          title="查看请求历史"
          onClick={() => setHistoryOpen(true)}
        >
          <History className="size-3.5" />
          历史 ({apiHistory.length})
        </Button>
      </div>

      {/* 请求行：方法 + 地址 + 发送 */}
      <div
        ref={reqRowRef}
        className="flex shrink-0 items-center gap-2 border-y border-border px-3 py-2"
      >
        <Select
          value={method}
          onChange={(m) => {
            setMethod(m)
            markDirty()
          }}
          options={METHODS.map((m) => ({ label: m, value: m }))}
          className="w-28 shrink-0"
        />
        <Input
          value={url}
          onChange={onUrlChange}
          placeholder="请求地址，如 https://api.example.com/users"
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          type="primary"
          icon={<Send className="size-4" />}
          loading={sending}
          onClick={() => void send()}
          disabled={sending}
          title="发送（Ctrl+Enter）"
        >
          发送
        </Button>
      </div>

      {/*
        请求构造区（overflow-hidden：被压扁时裁掉内容，不要溢出去糊在响应面板上）。
        切换条用与响应区同一个 TabButtons（原来是 antd Tabs，两边样式对不上）。
      */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 px-3 py-1.5 text-xs">
          <TabButtons tabs={REQ_TABS} value={reqTab} onChange={setReqTab} />
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {reqTab === 'headers' && (
            <div className="flex h-full flex-col overflow-auto px-3 py-3">
              {/* 不用 antd Table：它强制 rowKey，而这里每行没有稳定 id，
                  用 index 当 rowKey 已被 antd 弃用告警。行结构很简单（名称 / 值 / 删除），
                  直接铺 flex 行，行为与原来一致。 */}
              <div className="flex flex-col divide-y divide-border/40">
                {headers.map((h, i) => {
                  const suggestions = headerValueSuggestions(h.key)
                  return (
                    <div key={i} className="flex items-center gap-2 py-1">
                      <div className="w-[200px] shrink-0">
                        <AutoComplete
                          value={h.key}
                          options={COMMON_HEADERS.map((n) => ({ value: n }))}
                          onChange={(v) => updateHeader(i, 'key', v)}
                          placeholder="名称，如 Content-Type"
                          className="w-full"
                          showSearch={{
                            filterOption: (input, option) =>
                              (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                          }}
                        >
                          <Input
                            size="small"
                            variant="filled"
                            className="font-mono text-[11px]"
                            style={{ height: 32 }}
                          />
                        </AutoComplete>
                      </div>
                      <div className="min-w-0 flex-1">
                        <AutoComplete
                          value={h.value}
                          options={suggestions ? suggestions.map((v) => ({ value: v })) : []}
                          onChange={(v) => updateHeader(i, 'value', v)}
                          placeholder={suggestions ? '可从常见取值中选择' : '值，如 application/json'}
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
                            className="font-mono text-[11px]"
                            style={{ height: 32 }}
                          />
                        </AutoComplete>
                      </div>
                      <div className="w-10 shrink-0 text-center">
                        {/* 末行的空槽位不给删除按钮：删了 tidyHeaderRows 也会立刻补回来，是个空操作 */}
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
            </div>
          )}

          {reqTab === 'params' && (
            <div className="flex h-full flex-col overflow-auto px-3 py-3">
              {/* 同上：不用 antd Table，直接铺 flex 行（参数行无补全 / 无下拉） */}
              <div className="flex flex-col divide-y divide-border/40">
                {params.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 py-1">
                    <div className="w-[200px] shrink-0">
                      <Input
                        size="small"
                        variant="filled"
                        value={p.key}
                        onChange={(e) => updateParam(i, 'key', e.target.value)}
                        placeholder="参数名"
                        className="w-full font-mono text-[11px]"
                        style={{ height: 32 }}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Input
                        size="small"
                        variant="filled"
                        value={p.value}
                        onChange={(e) => updateParam(i, 'value', e.target.value)}
                        placeholder="参数值"
                        className="w-full font-mono text-[11px]"
                        style={{ height: 32 }}
                      />
                    </div>
                    <div className="w-10 shrink-0 text-center">
                      {/* 末行空槽位不给删除按钮（删了 tidyHeaderRows 也会立刻补回来） */}
                      {i === params.length - 1 && isBlankHeader(p) ? null : (
                        <Button
                          type="text"
                          size="small"
                          className="size-7 text-muted-foreground"
                          title="删除该参数"
                          icon={<Trash2 className="size-3.5" />}
                          onClick={() => removeParam(i)}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {reqTab === 'body' && (
            <div className="flex h-full min-h-0 flex-col px-3 pb-3">
              <div className="min-h-0 flex-1 overflow-hidden">
                <MonacoEditor
                  value={body}
                  onChange={(v) => {
                    setBody(v)
                    markDirty()
                  }}
                  language={bodyLanguage}
                  onLanguageChange={setBodyLanguage}
                  showLanguageSelector
                  showLineNumbersToggle
                  showWordWrapToggle
                  showCopyButton
                  // Monaco 没有 placeholder，GET/HEAD 的提醒改挂在工具栏上 ——
                  // 不额外占一行高度（请求构造区本来就容易被响应面板压扁）
                  toolbar={
                    method === 'GET' || method === 'HEAD' ? (
                      <span className="shrink-0 text-[11px] text-amber-600 dark:text-amber-400">
                        {method} 请求不携带请求体，这里的内容发送时会被忽略
                      </span>
                    ) : undefined
                  }
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/*
        拖拽条：调整响应面板高度。**常驻**（只在面板折叠时隐藏）——
        不能等有响应了才出现，否则没发过请求时根本抓不到这条分隔线。
      */}
      {!respCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整响应面板高度"
          className="group/res relative z-20 -my-1 h-2 shrink-0 cursor-row-resize select-none"
          title="拖动调整响应面板高度"
          onPointerDown={startResize}
        >
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover/res:bg-primary" />
        </div>
      )}

      {/*
        响应区：高度由上面的分隔条拖动决定（没折叠就固定占比，保证拖动一定有可见效果）。
        bg-background 必须显式写：这一块是不透明的面板，否则下面被压扁的请求区会透出来。
      */}
      <div
        className="flex shrink-0 flex-col overflow-hidden bg-background"
        style={respCollapsed ? undefined : { height: Math.round(resRatio * 100) + '%' }}
      >
        <div className="flex shrink-0 items-center gap-3 px-3 py-1.5 text-xs">
          {response ? (
            <TabButtons
              tabs={[
                { key: 'body' as const, label: '响应体' },
                {
                  key: 'headers' as const,
                  label: '响应头' + (respHeaders.length ? ' (' + respHeaders.length + ')' : '')
                }
              ]}
              value={resTab}
              onChange={setResTab}
            />
          ) : (
            <span className="shrink-0 font-medium text-muted-foreground">响应</span>
          )}
          {response && (
            <Tag color={statusOk ? 'success' : 'error'} className="font-medium">
              {response.status} {response.statusText}
            </Tag>
          )}
          {response && <span className="text-muted-foreground">{response.timeMs} ms</span>}
          {response && (
            <span className="text-muted-foreground">{formatBytes((response.body || '').length)}</span>
          )}
          {contentType && (
            <span className="truncate text-muted-foreground/80" title={contentType}>
              {contentType}
            </span>
          )}
          {error && <span className="text-destructive">错误：{error}</span>}
          <button
            className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title={respCollapsed ? '展开响应面板' : '折叠响应面板'}
            onClick={() => setRespCollapsed((v) => !v)}
          >
            {respCollapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </div>

        {!respCollapsed &&
          (response ? (
            resTab === 'body' ? (
              <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3">
                <div className="h-full overflow-hidden">
                  {/* 响应体用 Monaco：自带格式化按钮（工具栏的「代码」图标），无需再写自定义按钮 */}
                  <MonacoEditor
                    value={respBody}
                    onChange={setRespBody}
                    language={respLang}
                    showLanguageSelector
                    showCopyButton
                  />
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
                {respHeaders.length === 0 ? (
                  <div className="text-xs text-muted-foreground">暂无响应头。</div>
                ) : (
                  <div className="select-text space-y-0.5">
                    {respHeaders.map(([k, v]) => (
                      <div key={k} className="flex gap-3 border-b border-border/40 py-1">
                        <span className="w-56 shrink-0 break-all font-mono text-[11px] text-muted-foreground">
                          {k}
                        </span>
                        <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          ) : (
            <div className="px-3 pb-3 text-xs text-muted-foreground">
              发送请求后在此查看响应（状态码、耗时与正文）。
            </div>
          ))}
      </div>

      {/* 请求历史抽屉 */}
      <Drawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        placement="right"
        size={448}
        title={
          <div className="min-w-0">
            <div className="text-sm">请求历史</div>
            <div className="text-[11px] text-muted-foreground">发送请求后自动记录，最多保留 50 条</div>
          </div>
        }
        extra={
          <Button
            type="text"
            size="small"
            danger
            className="h-7 shrink-0 gap-1.5 px-2 text-[11px]"
            disabled={apiHistory.length === 0}
            onClick={() => void clearApiHistory()}
          >
            <Trash2 className="size-3.5" />
            清空
          </Button>
        }
        footer={
          <div className="flex justify-end">
            <Button size="small" onClick={() => setHistoryOpen(false)}>
              关闭
            </Button>
          </div>
        }
      >
        <div className="min-h-0 flex-1 overflow-auto">
          {apiHistory.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              还没有请求历史。发送请求后会自动记录到这里（最多保留 50 条）。
            </div>
          ) : (
            <div className="space-y-1">
              {apiHistory.map((entry, idx) => (
                <div
                  key={entry.id || idx}
                  className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
                >
                  <Tag className="m-0 shrink-0 font-mono text-[10px]">{entry.method || 'GET'}</Tag>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]',
                      statusClass(entry.status)
                    )}
                    title={entry.statusText || ''}
                  >
                    {entry.status || 'ERR'}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={entry.url}>
                    {entry.url}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {relTime(entry.at)}
                  </span>
                  <Button
                    type="text"
                    size="small"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => {
                      applyHistory(entry)
                      setHistoryOpen(false)
                    }}
                  >
                    载入
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Drawer>

      {/* 草稿按 Ctrl/Cmd+S 时名称为空才走到这里：要求补一个请求名再落盘 */}
      <Modal
        open={saveNameOpen}
        onCancel={() => setSaveNameOpen(false)}
        title="保存请求"
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
          placeholder="请求名称，如：查询用户列表"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onPressEnter={() => void confirmSaveDraft()}
        />
        <p className="mt-2 text-xs text-muted-foreground">保存后该请求才会显示在左侧列表中。</p>
      </Modal>
    </div>
  )
}

/**
 * 分段切换按钮（请求构造区与响应区共用）。
 *
 * 两处的切换条**必须**用同一个组件：以前请求侧是 antd `Tabs`、响应侧是手写按钮，
 * 样式对不上（内边距、选中底色、字号都不一样）。抽出来之后改一处两边一起变。
 */
function TabButtons<T extends string>({
  tabs,
  value,
  onChange
}: {
  tabs: ReadonlyArray<{ key: T; label: string }>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {tabs.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={cn(
            'rounded px-2 py-0.5 transition-colors',
            value === it.key
              ? 'bg-secondary font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
