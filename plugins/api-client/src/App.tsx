import { AutoComplete, Button, Drawer, Input, Modal, Select, Table, Tabs, Tag, message } from 'antd'
import {
    ChevronDown,
    ChevronUp,
    History,
    Plus,
    Save,
    Terminal,
    Trash2,
    X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

/* ------------------------------------------------------------------ */
/* 常量与工具函数                                                       */
/* ------------------------------------------------------------------ */

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
const SAVED_KEY = 'requests'
const HISTORY_KEY = 'history'
const HISTORY_LIMIT = 50

const COMMON_HEADERS = [
    'Accept',
    'Accept-Encoding',
    'Accept-Language',
    'Authorization',
    'Cache-Control',
    'Connection',
    'Content-Type',
    'Cookie',
    'If-None-Match',
    'Origin',
    'Referer',
    'User-Agent',
    'X-Api-Key',
    'X-Requested-With'
]

const COMMON_MIME_TYPES = [
    'application/json',
    'application/x-www-form-urlencoded',
    'application/xml',
    'application/octet-stream',
    'application/pdf',
    'application/zip',
    'application/javascript',
    'text/plain',
    'text/html',
    'text/css',
    'text/csv',
    'text/xml',
    'multipart/form-data',
    '*/*'
]

const HEADER_VALUE_SUGGESTIONS: Record<string, string[]> = {
    'content-type': COMMON_MIME_TYPES,
    accept: COMMON_MIME_TYPES,
    'accept-encoding': ['gzip', 'deflate', 'br', 'identity', '*/*'],
    'accept-language': ['zh-CN', 'zh-CN,zh;q=0.9', 'en-US', 'en-US,en;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8', '*'],
    'accept-charset': ['UTF-8', 'ISO-8859-1', 'UTF-8,ISO-8859-1;q=0.8'],
    authorization: ['Bearer ', 'Basic ', 'Token '],
    'cache-control': ['no-cache', 'no-store', 'max-age=0', 'max-age=3600', 'public', 'private', 'must-revalidate'],
    connection: ['keep-alive', 'close', 'Upgrade'],
    pragma: ['no-cache'],
    'if-none-match': ['*'],
    'x-requested-with': ['XMLHttpRequest'],
    'content-encoding': ['gzip', 'deflate', 'br', 'identity'],
    origin: ['http://localhost:5174', 'https://example.com'],
    'upgrade-insecure-requests': ['1'],
    dnt: ['1', '0'],
    'sec-fetch-mode': ['cors', 'navigate', 'no-cors', 'same-origin'],
    'sec-fetch-site': ['same-origin', 'cross-site', 'same-site', 'none']
}

function headerValueSuggestions(key: string): string[] | null {
    const k = String(key || '').trim().toLowerCase()
    if (!k) return null
    return HEADER_VALUE_SUGGESTIONS[k] || null
}

interface HeaderPair {
    key: string
    value: string
}

function emptyHeader(): HeaderPair {
    return { key: '', value: '' }
}

function pairsToHeaders(pairs: HeaderPair[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const p of pairs || []) {
        const k = (p.key || '').trim()
        if (!k) continue
        out[k] = (p.value || '').trim()
    }
    return out
}

function normalizeHeaders(raw: unknown): HeaderPair[] {
    if (Array.isArray(raw)) {
        const pairs = raw
            .filter((p) => p && typeof p === 'object')
            .map((p) => ({ key: String((p as HeaderPair).key ?? ''), value: String((p as HeaderPair).value ?? '') }))
        return pairs.length ? pairs : [emptyHeader()]
    }
    if (typeof raw === 'string') {
        const pairs: HeaderPair[] = []
        for (const line of raw.split('\n')) {
            const i = line.indexOf(':')
            if (i <= 0) continue
            pairs.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() })
        }
        return pairs.length ? pairs : [emptyHeader()]
    }
    return [emptyHeader()]
}

function parseCurl(cmd: string) {
    const text = String(cmd || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\\\n/g, ' ')
        .replace(/\^\n/g, ' ')
        .replace(/`\n/g, ' ')
    const tokens: string[] = []
    let cur = ''
    let quote: string | null = null
    let has = false
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (quote) {
            if (ch === quote) {
                quote = null
            } else if (quote === '"' && ch === '\\' && text[i + 1] !== undefined) {
                cur += text[++i]
            } else {
                cur += ch
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch
            has = true
        } else if (/\s/.test(ch)) {
            if (cur || has) {
                tokens.push(cur)
                cur = ''
                has = false
            }
        } else {
            cur += ch
        }
    }
    if (cur || has) tokens.push(cur)

    if (!tokens.length || tokens[0] !== 'curl') throw new Error('不是有效的 cURL 命令（需以 curl 开头）')

    const optValue = (i: number) => {
        const v = tokens[i + 1]
        if (v === undefined) throw new Error('cURL 参数缺少值：' + tokens[i])
        return v
    }

    let method: string | null = null
    let url = ''
    let basic: string | null = null
    let isGet = false
    const headerLines: string[] = []
    const dataParts: string[] = []
    const formParts: string[] = []
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i]
        if (t === '-X' || t === '--request') {
            method = optValue(i).toUpperCase()
            i++
        } else if (t === '-H' || t === '--header') {
            headerLines.push(optValue(i))
            i++
        } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii' || t === '--data-urlencode') {
            dataParts.push(optValue(i))
            i++
        } else if (t === '--json') {
            headerLines.push('Content-Type: application/json', 'Accept: application/json')
            dataParts.push(optValue(i))
            i++
        } else if (t === '-F' || t === '--form') {
            formParts.push(optValue(i))
            i++
        } else if (t === '-u' || t === '--user') {
            basic = optValue(i)
            i++
        } else if (t === '-G' || t === '--get') {
            isGet = true
        } else if (t.startsWith('-')) {
            // 忽略其它选项
        } else if (!url) {
            url = t
        }
    }

    if (!url) throw new Error('cURL 命令中未找到请求地址')

    const pairs: HeaderPair[] = []
    for (const line of headerLines) {
        const idx = line.indexOf(':')
        if (idx <= 0) continue
        pairs.push({ key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() })
    }
    if (basic) {
        pairs.push({ key: 'Authorization', value: 'Basic ' + btoa(basic) })
    }

    let body = ''
    let autoCt: string | null = null
    if (formParts.length) {
        body = formParts.join('&')
        if (!pairs.some((p) => p.key.toLowerCase() === 'content-type')) {
            autoCt = 'multipart/form-data'
            pairs.push({ key: 'Content-Type', value: autoCt })
        }
    } else if (dataParts.length) {
        body = dataParts.join('&')
        if (!pairs.some((p) => p.key.toLowerCase() === 'content-type')) {
            autoCt = 'application/x-www-form-urlencoded'
            pairs.push({ key: 'Content-Type', value: autoCt })
        }
    }

    if (isGet) {
        method = 'GET'
        if (body) {
            url += (url.includes('?') ? '&' : '?') + body.replace(/&$/, '')
            body = ''
        }
        if (autoCt) {
            const idx = pairs.findIndex((p) => p.key.toLowerCase() === 'content-type' && p.value === autoCt)
            if (idx >= 0) pairs.splice(idx, 1)
        }
    }

    return {
        method: method || (dataParts.length || formParts.length ? 'POST' : 'GET'),
        url,
        headers: pairs,
        body
    }
}

function formatBody(body: string, contentType: string, enabled: boolean): string {
    if (!body || !enabled) return body
    const ct = String(contentType || '').toLowerCase()
    const trimmed = body.trimStart()
    const looksJson = ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')
    if (looksJson) {
        try {
            return JSON.stringify(JSON.parse(body), null, 2)
        } catch {
            return body
        }
    }
    return body
}

function relTime(ts: number): string {
    const d = Date.now() - ts
    if (d < 60_000) return '刚刚'
    if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前'
    if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前'
    return new Date(ts).toLocaleString()
}

function statusClass(status: number): string {
    if (!status) return 'bg-destructive/15 text-destructive'
    return status < 400 ? 'bg-emerald-500/15 text-emerald-500' : 'bg-destructive/15 text-destructive'
}

/* ------------------------------------------------------------------ */
/* 类型定义                                                             */
/* ------------------------------------------------------------------ */

interface HttpResponse {
    ok: boolean
    status: number
    statusText: string
    headers: Record<string, string>
    body: string
    timeMs: number
    error?: string
}

interface SavedRequest {
    id: string
    method: string
    url: string
    headers: HeaderPair[]
    body: string
    at: number
}

interface HistoryEntry {
    id: string
    method: string
    url: string
    headers: HeaderPair[]
    body: string
    status: number
    statusText: string
    timeMs: number
    at: number
}

interface RequestTab {
    id: string
    method: string
    url: string
    headers: HeaderPair[]
    body: string
    tab: 'headers' | 'body'
    sending: boolean
    response: HttpResponse | null
    error: string | null
    format: boolean
    resTab: 'body' | 'headers'
    respCollapsed: boolean
    savedId: string | null
}

function newTab(): RequestTab {
    return {
        id: crypto.randomUUID(),
        method: 'GET',
        url: '',
        headers: [emptyHeader()],
        body: '',
        tab: 'headers',
        sending: false,
        response: null,
        error: null,
        format: true,
        resTab: 'body',
        respCollapsed: false,
        savedId: null
    }
}

/* ------------------------------------------------------------------ */
/* 主组件                                                               */
/* ------------------------------------------------------------------ */

export default function App() {
    const api = window.api

    const [tabs, setTabs] = useState<RequestTab[]>(() => [newTab()])
    const [activeId, setActiveId] = useState<string | null>(null)
    const [saved, setSaved] = useState<SavedRequest[]>([])
    const [history, setHistory] = useState<HistoryEntry[]>([])
    const [historyOpen, setHistoryOpen] = useState(false)
    const [curlOpen, setCurlOpen] = useState(false)
    const [curlText, setCurlText] = useState('')
    const [resRatio, setResRatio] = useState(0.5)

    const activeTab = tabs.find((t) => t.id === activeId) || tabs[0]
    const [messageApi, contextHolder] = message.useMessage()

    useEffect(() => {
        api.storage.get(SAVED_KEY).then((v) => {
            if (Array.isArray(v)) setSaved(v as SavedRequest[])
        })
        api.storage.get(HISTORY_KEY).then((v) => {
            if (Array.isArray(v)) setHistory(v as HistoryEntry[])
        })
    }, [api])

    const updateActive = useCallback(
        (patch: Partial<RequestTab>) =>
            setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? { ...t, ...patch } : t))),
        [activeTab.id]
    )

    const addTab = () => {
        const t = newTab()
        setTabs((prev) => [...prev, t])
        setActiveId(t.id)
    }

    const closeTab = (id: string) => {
        if (tabs.length === 1) {
            const t = newTab()
            setTabs([t])
            setActiveId(t.id)
            return
        }
        const idx = tabs.findIndex((t) => t.id === id)
        const next = tabs.filter((t) => t.id !== id)
        setTabs(next)
        if (id === activeTab.id) {
            setActiveId(next[Math.max(0, Math.min(idx, next.length - 1))].id)
        }
    }

    const updateHeader = (idx: number, field: keyof HeaderPair, value: string) => {
        updateActive({
            headers: activeTab.headers.map((p, i) => (i === idx ? { ...p, [field]: value } : p))
        })
    }
    const addHeader = () => updateActive({ headers: [...activeTab.headers, emptyHeader()] })
    const removeHeader = (idx: number) => {
        const next = activeTab.headers.filter((_, i) => i !== idx)
        updateActive({ headers: next.length ? next : [emptyHeader()] })
    }

    const pushHistory = (req: RequestTab, res: HttpResponse | null) => {
        const entry: HistoryEntry = {
            id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
            method: req.method,
            url: req.url.trim(),
            headers: req.headers,
            body: req.body,
            status: res ? res.status : 0,
            statusText: res ? res.statusText : '',
            timeMs: res ? res.timeMs : 0,
            at: Date.now()
        }
        setHistory((prev) => {
            const next = [entry, ...prev].slice(0, HISTORY_LIMIT)
            api.storage.set(HISTORY_KEY, next)
            return next
        })
    }

    const send = async () => {
        const req = activeTab
        if (!req.url.trim()) {
            updateActive({ error: '请填写请求地址' })
            return
        }
        updateActive({ sending: true, error: null, response: null })
        let res: HttpResponse | null = null
        try {
            res = (await api.http({
                method: req.method,
                url: req.url.trim(),
                headers: pairsToHeaders(req.headers),
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                timeoutMs: 30000
            })) as HttpResponse
            updateActive({ response: res })
            if (res.error) messageApi.error('请求失败：' + res.error)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            updateActive({ error: msg })
            messageApi.error('请求失败：' + msg)
        } finally {
            updateActive({ sending: false })
            pushHistory(req, res)
        }
    }

    const persistSaved = (next: SavedRequest[]) => {
        setSaved(next)
        api.storage.set(SAVED_KEY, next)
    }

    const saveTab = (t: RequestTab) => {
        if (!t.url.trim()) return
        const savedId = t.savedId || t.id
        const entry: SavedRequest = {
            id: savedId,
            method: t.method,
            url: t.url.trim(),
            headers: t.headers,
            body: t.body,
            at: Date.now()
        }
        const exists = saved.some((s) => s.id === savedId)
        persistSaved(exists ? saved.map((s) => (s.id === savedId ? entry : s)) : [...saved, entry])
        setTabs((prev) => prev.map((x) => (x.id === t.id ? { ...x, savedId } : x)))
        messageApi.success('已保存请求')
    }

    const saveCurrent = () => saveTab(activeTab)

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 's') {
                e.preventDefault()
                saveCurrent()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    })

    const applyRequest = (req: { method?: string; url?: string; headers?: unknown; body?: string; id?: string | null }) => {
        updateActive({
            method: req.method || 'GET',
            url: req.url || '',
            headers: normalizeHeaders(req.headers),
            body: req.body || '',
            tab: 'headers',
            savedId: req.id ?? null
        })
    }

    const importCurl = () => {
        try {
            const parsed = parseCurl(curlText)
            const t: RequestTab = {
                ...newTab(),
                method: parsed.method,
                url: parsed.url,
                headers: parsed.headers.length ? normalizeHeaders(parsed.headers) : newTab().headers,
                body: parsed.body || ''
            }
            setTabs((prev) => [...prev, t])
            setActiveId(t.id)
            setCurlOpen(false)
            setCurlText('')
            messageApi.success('已导入 cURL 命令')
        } catch (e) {
            messageApi.error('导入失败：' + (e instanceof Error ? e.message : String(e)))
        }
    }

    const deleteSaved = (idx: number) => {
        persistSaved(saved.filter((_, i) => i !== idx))
    }

    const deleteHistory = (idx: number) => {
        setHistory((prev) => {
            const next = prev.filter((_, i) => i !== idx)
            api.storage.set(HISTORY_KEY, next)
            return next
        })
    }

    const clearHistory = () => {
        setHistory([])
        api.storage.set(HISTORY_KEY, [])
        messageApi.success('已清空请求历史')
    }

    const response = activeTab.response
    const error = activeTab.error
    const statusOk = response && response.status > 0 && response.status < 400
    const contentType = response?.headers?.['content-type'] || ''
    const respHeaders = response ? Object.entries(response.headers || {}) : []

    return (
        <div
            className="api-client-root flex h-full bg-background text-foreground"
            onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    void send()
                }
            }}
        >
            {contextHolder}

            {/* 左侧栏：保存的请求 */}
            <aside className="flex w-52 shrink-0 flex-col bg-sidebar">
                <div className="border-b border-border px-3 py-2">
                    <span className="text-[11px] font-medium text-muted-foreground">
                        保存的请求 ({saved.length})
                    </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {saved.length === 0 ? (
                        <div className="px-2 py-3 text-center text-xs text-muted-foreground">还没有保存的请求</div>
                    ) : (
                        <div className="space-y-0.5 p-2">
                            {saved.map((req, idx) => (
                                <div
                                    key={req.id || idx}
                                    className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent"
                                    title={(req.method || 'GET') + ' ' + req.url}
                                    onClick={() => applyRequest(req)}
                                >
                                    <Tag className="m-0 shrink-0 font-mono text-[10px]">{req.method || 'GET'}</Tag>
                                    <span className="min-w-0 flex-1 truncate text-xs">{req.url}</span>
                                    <Button
                                        type="text"
                                        size="small"
                                        className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                                        title="删除"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            deleteSaved(idx)
                                        }}
                                    >
                                        <Trash2 className="size-3" />
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </aside>

            {/* 右侧主列 */}
            <div className="flex min-w-0 flex-1 flex-col">
                {/* 请求标签条 */}
                <div className="flex h-8 shrink-0 items-stretch border-b border-border">
                    <div className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
                        {tabs.map((t) => {
                            const active = t.id === activeTab.id
                            return (
                                <div
                                    key={t.id}
                                    title={t.url || '未命名请求'}
                                    onClick={() => setActiveId(t.id)}
                                    className={`group/tt flex max-w-52 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border/60 px-2.5 text-xs transition-colors ${active ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground'
                                        }`}
                                >
                                    <Tag className="m-0 shrink-0 font-mono text-[10px]">{t.method}</Tag>
                                    <span className="min-w-0 truncate">{t.url || '未命名'}</span>
                                    <button
                                        className="ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover/tt:opacity-100"
                                        title="保存当前请求"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            saveTab(t)
                                        }}
                                    >
                                        <Save className="size-3" />
                                    </button>
                                    <button
                                        className="ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover/tt:opacity-100"
                                        title="关闭标签"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            closeTab(t.id)
                                        }}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </div>
                            )
                        })}
                        <div className="sticky right-0 flex shrink-0 items-center bg-background">
                            <button
                                className="flex h-8 items-center px-2 text-muted-foreground transition-colors hover:text-foreground"
                                title="导入 cURL 命令"
                                onClick={() => setCurlOpen(true)}
                            >
                                <Terminal className="size-3.5" />
                            </button>
                            <button
                                className="flex h-8 items-center px-2.5 text-muted-foreground transition-colors hover:text-foreground"
                                title="新建请求标签"
                                onClick={addTab}
                            >
                                <Plus className="size-3.5" />
                            </button>
                        </div>
                    </div>
                </div>

                {/* 顶部工具栏：方法 + 地址 + 发送 */}
                <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                    <Select
                        value={activeTab.method}
                        onChange={(m) => updateActive({ method: m })}
                        options={METHODS.map((m) => ({ label: m, value: m }))}
                        className="w-28 shrink-0"
                    />
                    <Input
                        value={activeTab.url}
                        onChange={(e) => updateActive({ url: e.target.value })}
                        placeholder="请求地址，如 https://api.example.com/users"
                        className="min-w-0 flex-1 font-mono text-xs"
                    />
                    <Button
                        type="primary"
                        loading={activeTab.sending}
                        onClick={send}
                        disabled={activeTab.sending}
                        title="发送（Ctrl+Enter）"
                    >
                        发送
                    </Button>
                </div>

                {/* 请求构造区 */}
                <Tabs
                    size="small"
                    activeKey={activeTab.tab}
                    onChange={(v) => updateActive({ tab: v as 'headers' | 'body' })}
                    className="flex min-h-0 flex-1 flex-col px-4!"
                    tabBarStyle={{ margin: 0 }}
                    styles={{ body: { height: '100%' }, content: { height: '100%' } }}
                    tabBarExtraContent={
                        <Button
                            type="text"
                            size="small"
                            className="mr-2 shrink-0 gap-1.5 text-[11px] text-muted-foreground"
                            title="查看请求历史"
                            onClick={() => setHistoryOpen(true)}
                        >
                            <History className="size-3.5" />
                            历史 ({history.length})
                        </Button>
                    }
                    items={[
                        {
                            key: 'headers',
                            label: '请求头',
                            children: (
                                <div className="h-full py-3 flex flex-col">
                                    <Table<HeaderPair>
                                        className="api-client-header-table"
                                        size="small"
                                        columns={[
                                            {
                                                key: 'name',
                                                width: 176,
                                                onCell: () => ({ style: { padding: 0 } }),
                                                render: (_, _r, i) => (
                                                    <AutoComplete
                                                        value={activeTab.headers[i].key}
                                                        options={COMMON_HEADERS.map((name) => ({ value: name }))}
                                                        onChange={(v) => updateHeader(i, 'key', v)}
                                                        placeholder="名称，如 Content-Type"
                                                        className="w-full"
                                                        showSearch={{ filterOption: (input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase()) }}
                                                    >
                                                        <Input
                                                            size="small"
                                                            variant="filled"
                                                            className="font-mono text-[11px]"
                                                            style={{ height: 32 }}
                                                        />
                                                    </AutoComplete>
                                                )
                                            },
                                            {
                                                key: 'value',
                                                onCell: () => ({ style: { padding: 0 } }),
                                                render: (_, _r, i) => {
                                                    const p = activeTab.headers[i]
                                                    const suggestions = headerValueSuggestions(p.key)
                                                    return (
                                                        <AutoComplete
                                                            value={p.value}
                                                            options={suggestions ? suggestions.map((v) => ({ value: v })) : []}
                                                            onChange={(v) => updateHeader(i, 'value', v)}
                                                            placeholder={suggestions ? '可从常见取值中选择' : '值，如 application/json'}
                                                            className="w-full"
                                                            showSearch={{ filterOption: suggestions ? (input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase()) : false }}
                                                        >
                                                            <Input
                                                                size="small"
                                                                variant="filled"
                                                                className="font-mono text-[11px]"
                                                                style={{ height: 32 }}
                                                            />
                                                        </AutoComplete>
                                                    )
                                                }
                                            },
                                            {
                                                key: 'action',
                                                width: 40,
                                                onCell: () => ({ style: { padding: 0, textAlign: 'center' } }),
                                                render: (_, _r, i) => (
                                                    <Button
                                                        type="text"
                                                        size="small"
                                                        className="size-7 text-muted-foreground opacity-50 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                                                        title="删除该请求头"
                                                        onClick={() => removeHeader(i)}
                                                    >
                                                        <Trash2 className="size-3.5" />
                                                    </Button>
                                                )
                                            }
                                        ]}
                                        dataSource={activeTab.headers}
                                        rowKey={(_, i) => 'h' + i}
                                        pagination={false}
                                        showHeader={false}
                                        rowHoverable={false}
                                        tableLayout="fixed"
                                        rowClassName={() => 'group'}
                                    />
                                    <div className="mt-2 flex items-center gap-2">
                                        <Button type="dashed" size="small" className="gap-1.5 text-[11px]" onClick={addHeader}>
                                            <Plus className="size-3.5" />
                                            添加请求头
                                        </Button>
                                    </div>
                                </div>
                            )
                        },
                        {
                            key: 'body',
                            label: '请求体',
                            children: (
                                <div className="h-full overflow-auto p-3">
                                    <Input.TextArea
                                        value={activeTab.body}
                                        onChange={(e) => updateActive({ body: e.target.value })}
                                        placeholder='请求体 JSON，如 {"name":"foo"}'
                                        className="min-h-64 font-mono text-xs"
                                        spellCheck={false}
                                    />
                                </div>
                            )
                        }
                    ]}
                />

                {/* 拖拽条 */}
                {!activeTab.respCollapsed && (
                    <div
                        className="group/res relative z-10 -my-1 h-2 shrink-0 cursor-row-resize select-none"
                        title="拖动调整响应面板高度"
                        onPointerDown={(e) => {
                            e.preventDefault()
                            const root = e.currentTarget.parentElement
                            const total = root ? root.getBoundingClientRect().height : 0
                            const startY = e.clientY
                            const startRatio = resRatio
                            const move = (ev: PointerEvent) => {
                                if (!total) return
                                const next = startRatio - (ev.clientY - startY) / total
                                setResRatio(Math.max(0.15, Math.min(0.8, next)))
                            }
                            const up = () => {
                                window.removeEventListener('pointermove', move)
                                window.removeEventListener('pointerup', up)
                                document.body.style.cursor = ''
                                document.body.style.userSelect = ''
                            }
                            document.body.style.cursor = 'row-resize'
                            document.body.style.userSelect = 'none'
                            window.addEventListener('pointermove', move)
                            window.addEventListener('pointerup', up)
                        }}
                    >
                        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover/res:bg-primary" />
                    </div>
                )}

                {/* 响应区 */}
                <div
                    className="flex shrink-0 flex-col"
                    style={activeTab.respCollapsed ? undefined : { height: Math.round(resRatio * 100) + '%' }}
                >
                    <div className="flex items-center gap-3 px-3 py-1.5 text-xs">
                        {response ? (
                            <div className="flex shrink-0 items-center gap-1">
                                {[
                                    { key: 'body' as const, label: '响应体' },
                                    { key: 'headers' as const, label: '响应头' + (respHeaders.length ? ' (' + respHeaders.length + ')' : '') }
                                ].map((it) => (
                                    <button
                                        key={it.key}
                                        onClick={() => updateActive({ resTab: it.key })}
                                        className={`rounded px-2 py-0.5 transition-colors ${activeTab.resTab === it.key
                                            ? 'bg-secondary font-medium text-foreground'
                                            : 'text-muted-foreground hover:text-foreground'
                                            }`}
                                    >
                                        {it.label}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <span className="shrink-0 font-medium text-muted-foreground">响应</span>
                        )}
                        {response && (
                            <Tag color={statusOk ? 'success' : 'error'} className="font-medium">
                                {response.status} {response.statusText}
                            </Tag>
                        )}
                        {response && <span className="text-muted-foreground">{response.timeMs} ms</span>}
                        {response && <span className="text-muted-foreground">{(response.body || '').length} B</span>}
                        {contentType && (
                            <span className="truncate text-muted-foreground/80" title={contentType}>
                                {contentType}
                            </span>
                        )}
                        {error && <span className="text-destructive">错误：{error}</span>}
                        <button
                            className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                            title={activeTab.respCollapsed ? '展开响应面板' : '折叠响应面板'}
                            onClick={() => updateActive({ respCollapsed: !activeTab.respCollapsed })}
                        >
                            {activeTab.respCollapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                        </button>
                    </div>
                    {!activeTab.respCollapsed &&
                        (response ? (
                            <Tabs
                                size="small"
                                activeKey={activeTab.resTab}
                                onChange={(v) => updateActive({ resTab: v as 'body' | 'headers' })}
                                className="flex min-h-0 flex-1 flex-col px-4!"
                                tabBarStyle={{ margin: 0, display: 'none' }}
                                styles={{ body: { height: '100%' }, content: { height: '100%' } }}
                                items={[
                                    {
                                        key: 'body',
                                        label: '响应体',
                                        children: (
                                            <div className="h-full flex flex-col py-3">
                                                <div className="flex items-center gap-2">
                                                    <Button
                                                        type="text"
                                                        size="small"
                                                        className="h-7 px-2 text-[11px]"
                                                        onClick={() => updateActive({ format: !activeTab.format })}
                                                    >
                                                        {activeTab.format ? '已格式化' : '格式化'}
                                                    </Button>
                                                    <span className="text-[10px] text-muted-foreground">
                                                        {activeTab.format ? '已按内容类型美化（JSON 缩进）' : '显示原始响应正文'}
                                                    </span>
                                                </div>
                                                <textarea
                                                    readOnly
                                                    value={formatBody(response.body, contentType, activeTab.format)}
                                                    className="flex-1 w-full resize-none rounded-md border border-border bg-muted/30 p-3 font-mono text-xs text-foreground"
                                                />
                                            </div>
                                        )
                                    },
                                    {
                                        key: 'headers',
                                        label: '响应头',
                                        children: (
                                            <div className="h-full overflow-auto py-3">
                                                {respHeaders.length === 0 ? (
                                                    <div className="text-xs text-muted-foreground">暂无响应头。</div>
                                                ) : (
                                                    <div className="space-y-0.5">
                                                        {respHeaders.map(([k, v]) => (
                                                            <div key={k} className="flex gap-3 border-b border-border/40 py-1">
                                                                <span className="w-56 shrink-0 break-all font-mono text-[11px] text-muted-foreground">{k}</span>
                                                                <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{v}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    }
                                ]}
                            />
                        ) : (
                            <div className="h-full overflow-auto px-4 py-3">
                                <div className="text-xs text-muted-foreground">发送请求后在此查看响应（状态码、耗时与正文）。</div>
                            </div>
                        ))}
                </div>
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
                        <div className="text-[11px] text-muted-foreground">
                            发送请求后自动记录，最多保留 {HISTORY_LIMIT} 条
                        </div>
                    </div>
                }
                extra={
                    <Button
                        type="text"
                        size="small"
                        danger
                        className="h-7 shrink-0 gap-1.5 px-2 text-[11px]"
                        disabled={history.length === 0}
                        onClick={clearHistory}
                    >
                        <Trash2 className="size-3.5" />
                        清空
                    </Button>
                }
                footer={
                    <div className="flex justify-end">
                        <Button variant="outlined" color="default" size="small" onClick={() => setHistoryOpen(false)}>
                            关闭
                        </Button>
                    </div>
                }
            >
                <div className="min-h-0 flex-1 overflow-auto">
                    {history.length === 0 ? (
                        <div className="text-xs text-muted-foreground">
                            还没有请求历史。发送请求后会自动记录到这里（最多保留 {HISTORY_LIMIT} 条）。
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {history.map((entry, idx) => (
                                <div
                                    key={entry.id || idx}
                                    className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
                                >
                                    <Tag className="m-0 shrink-0 font-mono text-[10px]">{entry.method || 'GET'}</Tag>
                                    <span
                                        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${statusClass(entry.status)}`}
                                        title={entry.statusText || ''}
                                    >
                                        {entry.status || 'ERR'}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={entry.url}>
                                        {entry.url}
                                    </span>
                                    <span className="shrink-0 text-[10px] text-muted-foreground">{relTime(entry.at)}</span>
                                    <Button
                                        type="text"
                                        size="small"
                                        className="h-6 shrink-0 px-2 text-[11px]"
                                        onClick={() => {
                                            applyRequest(entry)
                                            setHistoryOpen(false)
                                        }}
                                    >
                                        载入
                                    </Button>
                                    <Button
                                        type="text"
                                        size="small"
                                        className="shrink-0 text-muted-foreground"
                                        title="删除记录"
                                        onClick={() => deleteHistory(idx)}
                                    >
                                        <Trash2 className="size-3" />
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </Drawer>

            {/* cURL 导入弹窗 */}
            <Modal
                open={curlOpen}
                onCancel={() => setCurlOpen(false)}
                width={576}
                title={
                    <div>
                        <div className="text-sm">导入 cURL 命令</div>
                        <div className="text-[11px] text-muted-foreground">粘贴 curl 命令，解析后载入为新的请求标签</div>
                    </div>
                }
                footer={
                    <div className="flex justify-end gap-2">
                        <Button variant="outlined" color="default" size="small" onClick={() => setCurlOpen(false)}>
                            取消
                        </Button>
                        <Button type="primary" size="small" disabled={!curlText.trim()} onClick={importCurl}>
                            导入
                        </Button>
                    </div>
                }
            >
                <Input.TextArea
                    value={curlText}
                    onChange={(e) => setCurlText(e.target.value)}
                    placeholder={
                        'curl -X POST https://api.example.com/users \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"foo"}\''
                    }
                    className="min-h-32 max-h-64 font-mono text-xs"
                    spellCheck={false}
                    autoFocus
                    onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                            e.preventDefault()
                            importCurl()
                        }
                    }}
                />
            </Modal>
        </div>
    )
}
