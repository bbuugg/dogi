/**
 * api-client 插件渲染端（类 Postman 的 HTTP 调试工具）。
 *
 * 以「运行时加载」方式由宿主经 blob import 执行：不打包进主应用，
 * 通过 activate(api) 拿到宿主注入的 React 实例、shadcn 组件（api.ui）、
 * lucide 图标（api.icons）、全局通知（api.toast）以及 http/storage 能力。
 */
export function activate(api) {
  const { useState, useEffect } = api.react
  const h = api.h
  const {
    Button,
    Input,
    Badge,
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
    Table,
    TableHeader,
    TableBody,
    TableHead,
    TableRow,
    TableCell
  } = api.ui
  const { Send, Save, Trash2, Plus } = api.icons
  const cn = api.ui.cn
  const toast = api.toast
  const MonacoEditor = api.MonacoEditor

  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
  const SAVED_KEY = 'requests'
  const HISTORY_KEY = 'history'
  const HISTORY_LIMIT = 50
  const HEADER_DATALIST_ID = 'api-client-common-headers'
  const HEADER_VALUE_DATALIST_PREFIX = 'api-client-header-values-'

  /** 常见请求头：作为名称输入框的自动补全候选 */
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

  /** 常见 MIME 类型：Content-Type / Accept 的取值候选 */
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

  /**
   * 请求头取值候选：键为小写头名，值为常见取值数组。
   * 用于值输入框的自动补全（依据当前行填写的头名动态匹配）。
   */
  const HEADER_VALUE_SUGGESTIONS = {
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
    origin: ['http://localhost:5173', 'https://example.com'],
    'upgrade-insecure-requests': ['1'],
    dnt: ['1', '0'],
    'sec-fetch-mode': ['cors', 'navigate', 'no-cors', 'same-origin'],
    'sec-fetch-site': ['same-origin', 'cross-site', 'same-site', 'none']
  }

  /** 依据头名（大小写不敏感）取该头的常见取值候选，无匹配返回 null */
  function headerValueSuggestions(key) {
    const k = String(key || '').trim().toLowerCase()
    if (!k) return null
    return HEADER_VALUE_SUGGESTIONS[k] || null
  }

  /** 单元格内的扁平输入框：无边框无阴影、无聚焦/悬停背景变化，视觉上与表格浑然一体 */
  const HEADER_CELL_INPUT =
    'h-8 w-full min-w-0 bg-transparent px-2.5 font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70'

  /**
   * 注入一次性样式：Chromium 在从 datalist 提示中选中值时会给输入框打上 :-webkit-autofill，
   * 表现为浅蓝色背景。这里用背景色内阴影覆盖 + 超长 transition 将其抹平，保持透明观感。
   */
  if (typeof document !== 'undefined' && !document.getElementById('api-client-autofill-style')) {
    const style = document.createElement('style')
    style.id = 'api-client-autofill-style'
    style.textContent = `
.api-client-root input:-webkit-autofill,
.api-client-root input:-webkit-autofill:hover,
.api-client-root input:-webkit-autofill:focus,
.api-client-root input:-webkit-autofill:active {
  -webkit-box-shadow: 0 0 0 1000px var(--background, #fff) inset;
  -webkit-text-fill-color: currentColor;
  caret-color: currentColor;
  transition: background-color 9999s ease-in-out 0s;
}`
    document.head.appendChild(style)
  }

  const el = (tag, props, ...children) => h(tag, props, ...children)

  const emptyHeader = () => ({ key: '', value: '' })

  /** 名称-值对数组 -> 请求头对象（忽略空名称） */
  function pairsToHeaders(pairs) {
    const out = {}
    for (const p of pairs || []) {
      const k = (p.key || '').trim()
      if (!k) continue
      out[k] = (p.value || '').trim()
    }
    return out
  }

  /** 归一化存储的请求头：兼容旧的纯文本格式，保证至少一行空行 */
  function normalizeHeaders(raw) {
    if (Array.isArray(raw)) {
      const pairs = raw
        .filter((p) => p && typeof p === 'object')
        .map((p) => ({ key: String(p.key ?? ''), value: String(p.value ?? '') }))
      return pairs.length ? pairs : [emptyHeader()]
    }
    if (typeof raw === 'string') {
      const pairs = []
      for (const line of raw.split('\n')) {
        const i = line.indexOf(':')
        if (i <= 0) continue
        pairs.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() })
      }
      return pairs.length ? pairs : [emptyHeader()]
    }
    return [emptyHeader()]
  }

  /** 按内容类型格式化响应体：JSON 美化缩进，其余原样返回 */
  function formatBody(body, contentType, enabled) {
    if (!body || !enabled) return body
    const ct = String(contentType || '').toLowerCase()
    const trimmed = body.trimStart()
    const looksJson =
      ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')
    if (looksJson) {
      try {
        return JSON.stringify(JSON.parse(body), null, 2)
      } catch {
        return body
      }
    }
    return body
  }

  /** 依据响应内容类型/正文推断 Monaco 语言 */
  function detectLanguage(contentType, body) {
    const ct = String(contentType || '').toLowerCase()
    const t = String(body || '').trimStart()
    if (ct.includes('json') || t.startsWith('{') || t.startsWith('[')) return 'json'
    if (ct.includes('html')) return 'html'
    if (ct.includes('xml')) return 'xml'
    if (ct.includes('css')) return 'css'
    if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript'
    return 'plaintext'
  }

  function relTime(ts) {
    const d = Date.now() - ts
    if (d < 60_000) return '刚刚'
    if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前'
    if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前'
    return new Date(ts).toLocaleString()
  }

  function statusClass(status) {
    if (!status) return 'bg-destructive/15 text-destructive'
    return status < 400 ? 'bg-emerald-500/15 text-emerald-500' : 'bg-destructive/15 text-destructive'
  }

  function ApiClientView() {
    const [method, setMethod] = useState('GET')
    const [url, setUrl] = useState('')
    const [headers, setHeaders] = useState([emptyHeader()])
    const [body, setBody] = useState('')
    const [tab, setTab] = useState('headers')
    const [sending, setSending] = useState(false)
    const [response, setResponse] = useState(null)
    const [error, setError] = useState(null)
    const [saved, setSaved] = useState([])
    const [history, setHistory] = useState([])
    const [resTab, setResTab] = useState('body')
    /** 响应体是否格式化（JSON 美化） */
    const [format, setFormat] = useState(true)
    /** 请求体编辑器语言 */
    const [bodyLang, setBodyLang] = useState('json')

    useEffect(() => {
      api.storage.get(SAVED_KEY).then((v) => {
        if (Array.isArray(v)) setSaved(v)
      })
      api.storage.get(HISTORY_KEY).then((v) => {
        if (Array.isArray(v)) setHistory(v)
      })
    }, [])

    const updateHeader = (idx, field, value) => {
      setHeaders((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)))
    }
    const addHeader = () => setHeaders((prev) => [...prev, emptyHeader()])
    const removeHeader = (idx) =>
      setHeaders((prev) => {
        const next = prev.filter((_, i) => i !== idx)
        return next.length ? next : [emptyHeader()]
      })

    const pushHistory = (res) => {
      const entry = {
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        method,
        url: url.trim(),
        headers,
        body,
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
      if (!url.trim()) {
        setError('请填写请求地址')
        return
      }
      setSending(true)
      setError(null)
      setResponse(null)
      let res = null
      try {
        res = await api.http({
          method,
          url: url.trim(),
          headers: pairsToHeaders(headers),
          body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
          timeoutMs: 30000
        })
        setResponse(res)
        if (res.error) toast.error('请求失败', { description: res.error })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        toast.error('请求失败', { description: msg })
      } finally {
        setSending(false)
        pushHistory(res)
      }
    }

    const persistSaved = (next) => {
      setSaved(next)
      api.storage.set(SAVED_KEY, next)
    }

    const saveCurrent = () => {
      if (!url.trim()) return
      persistSaved([
        ...saved,
        { id: String(Date.now()), method, url: url.trim(), headers, body, at: Date.now() }
      ])
      toast.success('已保存请求')
    }

    const applyRequest = (req) => {
      setMethod(req.method || 'GET')
      setUrl(req.url || '')
      setHeaders(normalizeHeaders(req.headers ?? req.headersText))
      setBody(req.body || '')
      setTab('headers')
    }

    const deleteSaved = (idx) => {
      persistSaved(saved.filter((_, i) => i !== idx))
    }

    const deleteHistory = (idx) => {
      setHistory((prev) => {
        const next = prev.filter((_, i) => i !== idx)
        api.storage.set(HISTORY_KEY, next)
        return next
      })
    }

    const clearHistory = () => {
      setHistory([])
      api.storage.set(HISTORY_KEY, [])
      toast('已清空请求历史')
    }

    const statusOk = response && response.status > 0 && response.status < 400
    const statusPill = response
      ? h(
          Badge,
          {
            className: cn(
              'font-medium',
              statusOk ? 'bg-emerald-500/15 text-emerald-500' : 'bg-destructive/15 text-destructive'
            )
          },
          response.status + ' ' + response.statusText
        )
      : null

    const contentType = response?.headers?.['content-type'] || ''
    const respHeaders = response ? Object.entries(response.headers || {}) : []

    // 请求头表格（shadcn Table：单一容器 + 分隔线，单元格输入框扁平无边框）
    const headerRows = el(
      'div',
      { className: 'overflow-hidden rounded-md border border-border' },
      h(
        Table,
        { className: 'text-[11px]' },
        h(
          TableHeader,
          { className: 'bg-muted/50' },
          h(
            TableRow,
            { className: 'hover:bg-transparent' },
            h(
              TableHead,
              { className: 'h-8 w-[176px] px-2.5 text-[10px] font-medium text-muted-foreground' },
              '名称'
            ),
            h(
              TableHead,
              { className: 'h-8 px-2.5 text-[10px] font-medium text-muted-foreground' },
              '值'
            ),
            h(TableHead, { className: 'h-8 w-8 px-0' })
          )
        ),
        h(
          TableBody,
          null,
          ...headers.map((p, i) => {
            const valueSuggestions = headerValueSuggestions(p.key)
            const valueDatalistId = valueSuggestions ? HEADER_VALUE_DATALIST_PREFIX + i : undefined
            return h(
              TableRow,
              // hover:bg-transparent / transition-none 覆盖 shadcn TableRow 默认的悬停高亮
              { key: i, className: 'group transition-none hover:bg-transparent' },
              h(
                TableCell,
                { className: 'p-0' },
                el('input', {
                  value: p.key,
                  list: HEADER_DATALIST_ID,
                  placeholder: '名称，如 Content-Type',
                  onChange: (e) => updateHeader(i, 'key', e.target.value),
                  className: HEADER_CELL_INPUT
                })
              ),
              h(
                TableCell,
                { className: 'p-0' },
                el('input', {
                  value: p.value,
                  list: valueDatalistId,
                  placeholder: valueSuggestions ? '可从常见取值中选择' : '值，如 application/json',
                  onChange: (e) => updateHeader(i, 'value', e.target.value),
                  className: HEADER_CELL_INPUT
                }),
                valueSuggestions
                  ? el(
                      'datalist',
                      { id: valueDatalistId },
                      ...valueSuggestions.map((v) => el('option', { key: v, value: v }))
                    )
                  : null
              ),
              h(
                TableCell,
                { className: 'p-0 text-center' },
                h(
                  Button,
                  {
                    variant: 'ghost',
                    size: 'icon-sm',
                    className: 'size-7 text-muted-foreground opacity-50 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100',
                    title: '删除该请求头',
                    onClick: () => removeHeader(i)
                  },
                  h(Trash2, { className: 'size-3.5' })
                )
              )
            )
          })
        )
      ),
      // 底部：添加按钮 + 提示
      el(
        'div',
        { className: 'flex items-center gap-2 border-t border-border bg-muted/30 px-2 py-1.5' },
        h(
          Button,
          { variant: 'ghost', size: 'sm', className: 'h-7 px-2 text-[11px]', onClick: addHeader },
          h(Plus, { className: 'size-3.5' }),
          '添加请求头'
        ),
        el(
          'span',
          { className: 'text-[10px] text-muted-foreground' },
          '名称可从常见请求头中选择；填写 Accept / Content-Type / Authorization 等后，值也会给出常见候选'
        )
      ),
      el(
        'datalist',
        { id: HEADER_DATALIST_ID },
        ...COMMON_HEADERS.map((name) => el('option', { key: name, value: name }))
      )
    )

    // 历史记录行
    const historyList =
      history.length === 0
        ? el(
            'div',
            { className: 'text-xs text-muted-foreground' },
            '还没有请求历史。发送请求后会自动记录到这里（最多保留 ' + HISTORY_LIMIT + ' 条）。'
          )
        : el(
            'div',
            { className: 'space-y-1' },
            ...history.map((entry, idx) =>
              el(
                'div',
                {
                  key: entry.id || idx,
                  className: 'flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5'
                },
                h(Badge, { variant: 'secondary', className: 'shrink-0 font-mono text-[10px]' }, entry.method || 'GET'),
                el(
                  'span',
                  {
                    className: 'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ' + statusClass(entry.status),
                    title: entry.statusText || ''
                  },
                  entry.status || 'ERR'
                ),
                el('span', { className: 'min-w-0 flex-1 truncate font-mono text-[11px]', title: entry.url }, entry.url),
                el('span', { className: 'shrink-0 text-[10px] text-muted-foreground' }, relTime(entry.at)),
                h(
                  Button,
                  { variant: 'ghost', size: 'sm', className: 'h-6 shrink-0 px-2 text-[11px]', onClick: () => applyRequest(entry) },
                  '载入'
                ),
                h(
                  Button,
                  {
                    variant: 'ghost',
                    size: 'icon-xs',
                    className: 'shrink-0 text-muted-foreground',
                    title: '删除记录',
                    onClick: () => deleteHistory(idx)
                  },
                  h(Trash2, { className: 'size-3' })
                )
              )
            )
          )

    // 已保存请求行
    const savedList =
      saved.length === 0
        ? el(
            'div',
            { className: 'text-xs text-muted-foreground' },
            '还没有保存的请求。填好地址后在「请求头 / 请求体」页点下方的「保存当前请求」。'
          )
        : el(
            'div',
            { className: 'space-y-1' },
            ...saved.map((req, idx) =>
              el(
                'div',
                { key: req.id || idx, className: 'flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5' },
                h(Badge, { variant: 'secondary', className: 'font-mono text-[10px]' }, req.method || 'GET'),
                el('span', { className: 'min-w-0 flex-1 truncate font-mono text-[11px]', title: req.url }, req.url),
                h(Button, { variant: 'ghost', size: 'sm', className: 'h-6 px-2 text-[11px]', onClick: () => applyRequest(req) }, '载入'),
                h(
                  Button,
                  {
                    variant: 'ghost',
                    size: 'icon-xs',
                    className: 'text-muted-foreground',
                    title: '删除',
                    onClick: () => deleteSaved(idx)
                  },
                  h(Trash2, { className: 'size-3' })
                )
              )
            )
          )

    // 响应体内容
    const responseBody = !response
      ? el('div', { className: 'text-xs text-muted-foreground' }, '发送请求后在此查看响应（状态码、耗时与正文）。')
      : el(
          'div',
          { className: 'space-y-2' },
          el(
            'div',
            { className: 'flex items-center gap-2' },
            h(
              Button,
              { variant: 'ghost', size: 'sm', className: 'h-7 px-2 text-[11px]', onClick: () => setFormat((f) => !f) },
              format ? '已格式化' : '格式化'
            ),
            el(
              'span',
              { className: 'text-[10px] text-muted-foreground' },
              format ? '已按内容类型美化（JSON 缩进）' : '显示原始响应正文'
            )
          ),
          el(
            'div',
            { className: 'h-[320px] overflow-hidden rounded-md border border-border' },
            h(MonacoEditor, {
              value: formatBody(response.body, contentType, format),
              language: detectLanguage(contentType, response.body),
              readOnly: true,
              showCopyButton: true,
              showWordWrapToggle: true
            })
          )
        )

    // 响应头内容
    const responseHeaders =
      respHeaders.length === 0
        ? el('div', { className: 'text-xs text-muted-foreground' }, '暂无响应头。')
        : el(
            'div',
            { className: 'space-y-0.5' },
            ...respHeaders.map(([k, v]) =>
              el(
                'div',
                { key: k, className: 'flex gap-3 border-b border-border/40 py-1' },
                el('span', { className: 'w-56 shrink-0 break-all font-mono text-[11px] text-muted-foreground' }, k),
                el('span', { className: 'min-w-0 flex-1 break-all font-mono text-[11px]' }, v)
              )
            )
          )

    return el(
      'div',
      {
        className: 'api-client-root flex h-full flex-col bg-background text-foreground',
        // Ctrl/Cmd + Enter 发送请求（在插件区域内任意位置均可）
        onKeyDown: (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            void send()
          }
        }
      },
      // 顶部工具栏：方法 + 地址 + 发送
      el(
        'div',
        { className: 'flex items-center gap-2 border-b border-border px-3 py-2' },
        h(
          Select,
          { value: method, onValueChange: setMethod },
          h(SelectTrigger, { className: 'w-28' }, h(SelectValue, { placeholder: '方法' })),
          h(SelectContent, null, ...METHODS.map((m) => h(SelectItem, { key: m, value: m }, m)))
        ),
        h(Input, {
          value: url,
          onChange: (e) => setUrl(e.target.value),
          placeholder: '请求地址，如 https://api.example.com/users',
          className: 'min-w-0 flex-1 font-mono text-xs'
        }),
        h(
          Button,
          { type: 'button', onClick: send, disabled: sending, title: '发送（Ctrl+Enter）' },
          h(Send, { className: 'size-4' }),
          sending ? '发送中…' : '发送'
        )
      ),
      // 请求构造区（Tab）
      h(
        Tabs,
        { value: tab, onValueChange: setTab, className: 'flex min-h-0 flex-1 flex-col' },
        h(
          TabsList,
          { className: 'w-full justify-start gap-1 rounded-none border-b border-border bg-transparent px-3' },
          h(TabsTrigger, { value: 'headers' }, '请求头'),
          h(TabsTrigger, { value: 'body' }, '请求体'),
          h(TabsTrigger, { value: 'history' }, '历史 (' + history.length + ')'),
          h(TabsTrigger, { value: 'saved' }, '已保存 (' + saved.length + ')')
        ),
        h(TabsContent, { value: 'headers', className: 'min-h-0 flex-1 overflow-auto p-3' }, headerRows),
        h(
          TabsContent,
          { value: 'body', className: 'min-h-0 flex-1 overflow-auto p-3' },
          el(
            'div',
            { className: 'h-64 overflow-hidden rounded-md border border-border' },
            h(MonacoEditor, {
              value: body,
              onChange: (v) => setBody(v || ''),
              language: bodyLang,
              onLanguageChange: setBodyLang,
              showLanguageSelector: true,
              showLineNumbersToggle: true,
              showWordWrapToggle: true
            })
          )
        ),
        h(
          TabsContent,
          { value: 'history', className: 'min-h-0 flex-1 overflow-auto p-3' },
          history.length > 0 &&
            el(
              'div',
              { className: 'mb-2 flex items-center justify-between' },
              el('span', { className: 'text-[11px] text-muted-foreground' }, '共 ' + history.length + ' 条记录'),
              h(
                Button,
                { variant: 'ghost', size: 'sm', className: 'h-7 px-2 text-[11px] text-destructive', onClick: clearHistory },
                h(Trash2, { className: 'size-3.5' }),
                '清空历史'
              )
            ),
          historyList
        ),
        h(TabsContent, { value: 'saved', className: 'min-h-0 flex-1 overflow-auto p-3' }, savedList)
      ),
      // 非「已保存 / 历史」页时的保存按钮
      (tab === 'headers' || tab === 'body') &&
        el(
          'div',
          { className: 'flex items-center justify-end gap-2 border-t border-border px-3 py-1.5' },
          h(Button, { variant: 'outline', size: 'sm', onClick: saveCurrent }, h(Save, { className: 'size-3.5' }), '保存当前请求')
        ),
      // 响应区：状态行 + 响应体 / 响应头
      el(
        'div',
        { className: 'flex min-h-0 flex-1 flex-col border-t border-border' },
        el(
          'div',
          { className: 'flex items-center gap-3 px-3 py-1.5 text-xs' },
          el('span', { className: 'shrink-0 font-medium text-muted-foreground' }, '响应'),
          statusPill,
          response && el('span', { className: 'text-muted-foreground' }, response.timeMs + ' ms'),
          response && el('span', { className: 'text-muted-foreground' }, (response.body || '').length + ' B'),
          contentType && el('span', { className: 'truncate text-muted-foreground/80', title: contentType }, contentType),
          error && el('span', { className: 'text-destructive' }, '错误：' + error)
        ),
        h(
          Tabs,
          { value: resTab, onValueChange: setResTab, className: 'flex min-h-0 flex-1 flex-col' },
          h(
            TabsList,
            { className: 'w-full justify-start gap-1 rounded-none border-b border-border bg-transparent px-3' },
            h(TabsTrigger, { value: 'body' }, '响应体'),
            h(TabsTrigger, { value: 'headers' }, '响应头' + (respHeaders.length ? ' (' + respHeaders.length + ')' : ''))
          ),
          h(TabsContent, { value: 'body', className: 'min-h-0 flex-1 overflow-auto px-3 pb-3 pt-2' }, responseBody),
          h(TabsContent, { value: 'headers', className: 'min-h-0 flex-1 overflow-auto px-3 pb-3 pt-2' }, responseHeaders)
        )
      )
    )
  }

  return {
    name: '接口请求',
    views: [{ viewId: 'api-client', name: '接口请求', icon: '🌐', Component: ApiClientView }]
  }
}
