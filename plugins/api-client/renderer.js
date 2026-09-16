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
    Textarea,
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
    TableCell,
    Drawer,
    DrawerClose,
    DrawerContent,
    DrawerHeader,
    DrawerFooter,
    DrawerTitle,
    DrawerDescription,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter
  } = api.ui
  const { Send, Save, Trash2, Plus, History, X, Terminal, ChevronUp, ChevronDown } = api.icons
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

  /**
   * 解析 cURL 命令为 { method, url, headers, body }。
   * 支持 -X/-H/-d 系列/--json/-F/-u/-G 与行接续符，其余选项忽略；解析失败抛错。
   */
  function parseCurl(cmd) {
    // 归一换行，再去掉三种 shell 的续行符：bash `\`、cmd `^`、PowerShell backtick
    const text = String(cmd || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\\\n/g, ' ')
      .replace(/\^\n/g, ' ')
      .replace(/`\n/g, ' ')
    const tokens = []
    let cur = ''
    let quote = null
    let has = false
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (quote) {
        if (ch === quote) {
          quote = null
        } else if (quote === '"' && ch === '\\' && text[i + 1] !== undefined) {
          cur += text[++i] // "..." 内 \x 转义取原字符
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

    const optValue = (i) => {
      const v = tokens[i + 1]
      if (v === undefined) throw new Error('cURL 参数缺少值：' + tokens[i])
      return v
    }

    let method = null
    let url = ''
    let basic = null
    let isGet = false
    const headerLines = []
    const dataParts = []
    const formParts = []
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
        // curl 8.x：--json 'body' 等价于 -d body + JSON 相关头
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
        // 其它选项（-L/-k/--compressed/-o 等）不影响请求语义，忽略
      } else if (!url) {
        url = t
      }
    }

    if (!url) throw new Error('cURL 命令中未找到请求地址')

    // 请求头行 -> 名称-值对
    const pairs = []
    for (const line of headerLines) {
      const idx = line.indexOf(':')
      if (idx <= 0) continue
      pairs.push({ key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() })
    }
    if (basic) {
      pairs.push({ key: 'Authorization', value: 'Basic ' + btoa(basic) })
    }

    let body = ''
    let autoCt = null
    if (formParts.length) {
      // -F 近似处理：字段以 & 拼接（文件字段 @path 需导入后手动调整）
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

    // -G：强制 GET，把 data 追加到 URL 查询串（此时不发送 body，撤回自动补的 Content-Type）
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

  /** 新建一个空白请求标签 */
  const newTab = () => ({
    id: 't' + Date.now() + Math.random().toString(36).slice(2, 6),
    method: 'GET',
    url: '',
    headers: [emptyHeader()],
    body: '',
    /** 请求构造区当前页：headers / body */
    tab: 'headers',
    sending: false,
    response: null,
    error: null,
    /** 响应体是否格式化（JSON 美化） */
    format: true,
    /** 响应区当前页：body / headers */
    resTab: 'body',
    /** 响应面板是否折叠为仅状态行 */
    respCollapsed: false,
    /** 请求体编辑器语言 */
    bodyLang: 'json'
  })

  function ApiClientView() {
    /** 请求标签列表（每个标签独立持有方法/地址/请求头/请求体/响应等状态） */
    const [tabs, setTabs] = useState(() => [newTab()])
    /** 当前激活的标签 id（null 时回退到第一个） */
    const [activeId, setActiveId] = useState(null)
    const [saved, setSaved] = useState([])
    const [history, setHistory] = useState([])
    /** 请求历史抽屉是否打开 */
    const [historyOpen, setHistoryOpen] = useState(false)
    /** cURL 导入弹窗 */
    const [curlOpen, setCurlOpen] = useState(false)
    const [curlText, setCurlText] = useState('')
    /** 响应面板高度占主列的比例（拖动分隔条调整，范围 0.15–0.8） */
    const [resRatio, setResRatio] = useState(0.5)

    const activeTab = tabs.find((t) => t.id === activeId) || tabs[0]

    useEffect(() => {
      api.storage.get(SAVED_KEY).then((v) => {
        if (Array.isArray(v)) setSaved(v)
      })
      api.storage.get(HISTORY_KEY).then((v) => {
        if (Array.isArray(v)) setHistory(v)
      })
    }, [])

    /** 局部更新当前激活标签的字段 */
    const updateActive = (patch) =>
      setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? { ...t, ...patch } : t)))

    /** 新增一个请求标签并激活 */
    const addTab = () => {
      const t = newTab()
      setTabs((prev) => [...prev, t])
      setActiveId(t.id)
    }

    /** 关闭标签：关闭最后一个时重置为空白标签 */
    const closeTab = (id) => {
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

    const updateHeader = (idx, field, value) => {
      updateActive({
        headers: activeTab.headers.map((p, i) => (i === idx ? { ...p, [field]: value } : p))
      })
    }
    const addHeader = () => updateActive({ headers: [...activeTab.headers, emptyHeader()] })
    const removeHeader = (idx) => {
      const next = activeTab.headers.filter((_, i) => i !== idx)
      updateActive({ headers: next.length ? next : [emptyHeader()] })
    }

    const pushHistory = (req, res) => {
      const entry = {
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
      let res = null
      try {
        res = await api.http({
          method: req.method,
          url: req.url.trim(),
          headers: pairsToHeaders(req.headers),
          body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
          timeoutMs: 30000
        })
        updateActive({ response: res })
        if (res.error) toast.error('请求失败', { description: res.error })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        updateActive({ error: msg })
        toast.error('请求失败', { description: msg })
      } finally {
        updateActive({ sending: false })
        pushHistory(req, res)
      }
    }

    const persistSaved = (next) => {
      setSaved(next)
      api.storage.set(SAVED_KEY, next)
    }

    const saveCurrent = () => {
      if (!activeTab.url.trim()) return
      persistSaved([
        ...saved,
        {
          id: String(Date.now()),
          method: activeTab.method,
          url: activeTab.url.trim(),
          headers: activeTab.headers,
          body: activeTab.body,
          at: Date.now()
        }
      ])
      toast.success('已保存请求')
    }

    /** 把保存的请求载入到当前激活标签 */
    const applyRequest = (req) => {
      updateActive({
        method: req.method || 'GET',
        url: req.url || '',
        headers: normalizeHeaders(req.headers ?? req.headersText),
        body: req.body || '',
        tab: 'headers'
      })
    }

    /** 解析粘贴的 cURL 命令，载入为新请求标签 */
    const importCurl = () => {
      try {
        const parsed = parseCurl(curlText)
        const t = {
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
        toast.success('已导入 cURL 命令')
      } catch (e) {
        toast.error('导入失败', { description: e instanceof Error ? e.message : String(e) })
      }
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

    const response = activeTab.response
    const error = activeTab.error
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
          ...activeTab.headers.map((p, i) => {
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
                  {
                    variant: 'ghost',
                    size: 'sm',
                    className: 'h-6 shrink-0 px-2 text-[11px]',
                    onClick: () => {
                      applyRequest(entry)
                      setHistoryOpen(false)
                    }
                  },
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

    // 左侧栏：保存的请求列表（点击即载入）
    const savedSidebar =
      saved.length === 0
        ? el('div', { className: 'px-2 py-3 text-center text-xs text-muted-foreground' }, '还没有保存的请求')
        : el(
            'div',
            { className: 'space-y-0.5 p-2' },
            ...saved.map((req, idx) =>
              el(
                'div',
                {
                  key: req.id || idx,
                  className:
                    'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent',
                  title: (req.method || 'GET') + ' ' + req.url,
                  onClick: () => applyRequest(req)
                },
                h(Badge, { variant: 'secondary', className: 'shrink-0 font-mono text-[10px]' }, req.method || 'GET'),
                el('span', { className: 'min-w-0 flex-1 truncate text-xs' }, req.url),
                h(
                  Button,
                  {
                    variant: 'ghost',
                    size: 'icon-xs',
                    className: 'shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100',
                    title: '删除',
                    onClick: (e) => {
                      e.stopPropagation()
                      deleteSaved(idx)
                    }
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
              { variant: 'ghost', size: 'sm', className: 'h-7 px-2 text-[11px]', onClick: () => updateActive({ format: !activeTab.format }) },
              activeTab.format ? '已格式化' : '格式化'
            ),
            el(
              'span',
              { className: 'text-[10px] text-muted-foreground' },
              activeTab.format ? '已按内容类型美化（JSON 缩进）' : '显示原始响应正文'
            )
          ),
          el(
            'div',
            { className: 'h-[320px] overflow-hidden rounded-md border border-border' },
            h(MonacoEditor, {
              value: formatBody(response.body, contentType, activeTab.format),
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
        className: 'api-client-root flex h-full bg-background text-foreground',
        // Ctrl/Cmd + Enter 发送请求（在插件区域内任意位置均可）
        onKeyDown: (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            void send()
          }
        }
      },
      // 左侧栏：保存的请求（点击行即载入到右侧编辑区）
      el(
        'aside',
        { className: 'flex w-52 shrink-0 flex-col border-r border-border bg-sidebar' },
        el(
          'div',
          { className: 'border-b border-border px-3 py-2' },
          el('span', { className: 'text-[11px] font-medium text-muted-foreground' }, '保存的请求 (' + saved.length + ')')
        ),
        el('div', { className: 'min-h-0 flex-1 overflow-y-auto' }, savedSidebar)
      ),
      // 右侧主列：请求标签条 + 工具栏 + 请求构造 + 响应区
      el(
        'div',
        { className: 'flex min-w-0 flex-1 flex-col' },
        // 请求标签条：切换不同请求，右侧 + 新建
        el(
          'div',
          { className: 'flex h-8 shrink-0 items-stretch border-b border-border' },
          el(
            'div',
            { className: 'no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto' },
            ...tabs.map((t) => {
              const active = t.id === activeTab.id
              return el(
                'div',
                {
                  key: t.id,
                  title: t.url || '未命名请求',
                  onClick: () => setActiveId(t.id),
                  className: cn(
                    'group/tt flex max-w-52 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border/60 px-2.5 text-xs transition-colors',
                    active ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground'
                  )
                },
                h(Badge, { variant: 'secondary', className: 'shrink-0 font-mono text-[10px]' }, t.method),
                el('span', { className: 'min-w-0 truncate' }, t.url || '未命名'),
                el('button', {
                  className:
                    'ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover/tt:opacity-100',
                  title: '关闭标签',
                  onClick: (e) => {
                    e.stopPropagation()
                    closeTab(t.id)
                  }
                }, h(X, { className: 'size-3' }))
              )
            }),
            // 右缘固定区：导入 cURL + 新建标签；标签溢出后 sticky 固定（bg-background 遮住滑过的内容）
            el(
              'div',
              { className: 'sticky right-0 flex shrink-0 items-center bg-background' },
              el('button', {
                className:
                  'flex h-8 items-center px-2 text-muted-foreground transition-colors hover:text-foreground',
                title: '导入 cURL 命令',
                onClick: () => setCurlOpen(true)
              }, h(Terminal, { className: 'size-3.5' })),
              el('button', {
                className:
                  'flex h-8 items-center px-2.5 text-muted-foreground transition-colors hover:text-foreground',
                title: '新建请求标签',
                onClick: addTab
              }, h(Plus, { className: 'size-3.5' }))
            )
          )
        ),
        // 顶部工具栏：方法 + 地址 + 发送
        el(
          'div',
          { className: 'flex items-center gap-2 border-b border-border px-3 py-2' },
          h(
            Select,
            { value: activeTab.method, onValueChange: (m) => updateActive({ method: m }) },
            h(SelectTrigger, { className: 'w-28' }, h(SelectValue, { placeholder: '方法' })),
            h(SelectContent, null, ...METHODS.map((m) => h(SelectItem, { key: m, value: m }, m)))
          ),
          h(Input, {
            value: activeTab.url,
            onChange: (e) => updateActive({ url: e.target.value }),
            placeholder: '请求地址，如 https://api.example.com/users',
            className: 'min-w-0 flex-1 font-mono text-xs'
          }),
          h(
            Button,
            { type: 'button', onClick: send, disabled: activeTab.sending, title: '发送（Ctrl+Enter）' },
            h(Send, { className: 'size-4' }),
            activeTab.sending ? '发送中…' : '发送'
          )
        ),
        // 请求构造区（Tab）：历史入口改为右侧抽屉，由工具栏按钮唤起
        h(
          Tabs,
          { value: activeTab.tab, onValueChange: (v) => updateActive({ tab: v }), className: 'flex min-h-0 flex-1 flex-col' },
          el(
            'div',
            { className: 'flex items-center border-b border-border' },
            h(
              TabsList,
              { className: 'w-full justify-start gap-1 rounded-none border-b-0 bg-transparent px-3' },
              h(TabsTrigger, { value: 'headers' }, '请求头'),
              h(TabsTrigger, { value: 'body' }, '请求体')
            ),
            h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                className: 'mr-2 shrink-0 gap-1.5 text-[11px] text-muted-foreground',
                title: '查看请求历史',
                onClick: () => setHistoryOpen(true)
              },
              h(History, { className: 'size-3.5' }),
              '历史 (' + history.length + ')'
            )
          ),
          h(TabsContent, { value: 'headers', className: 'min-h-0 flex-1 overflow-auto p-3' }, headerRows),
          h(TabsContent, { value: 'body', className: 'min-h-0 flex-1 overflow-auto p-3' },
            el(
              'div',
              { className: 'h-64 overflow-hidden rounded-md border border-border' },
              h(MonacoEditor, {
                value: activeTab.body,
                onChange: (v) => updateActive({ body: v || '' }),
                language: activeTab.bodyLang,
                onLanguageChange: (l) => updateActive({ bodyLang: l }),
                showLanguageSelector: true,
                showLineNumbersToggle: true,
                showWordWrapToggle: true
              })
            )
          )
        ),
      // 保存当前请求
      el(
        'div',
        { className: 'flex items-center justify-end gap-2 border-t border-border px-3 py-1.5' },
        h(Button, { variant: 'outline', size: 'sm', onClick: saveCurrent }, h(Save, { className: 'size-3.5' }), '保存当前请求')
      ),
      // 拖拽条：上下拖动调整响应面板高度（与项目内 ResizeHandle 同款的视觉与热区处理；响应折叠时隐藏）
      !activeTab.respCollapsed &&
      el(
        'div',
        {
          className: 'group/res relative z-10 -my-1 h-2 shrink-0 cursor-row-resize select-none',
          title: '拖动调整响应面板高度',
          onPointerDown: (e) => {
            e.preventDefault()
            const root = e.currentTarget.parentElement
            const total = root ? root.getBoundingClientRect().height : 0
            const startY = e.clientY
            const startRatio = resRatio
            const move = (ev) => {
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
          }
        },
        el('div', {
          className:
            'absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover/res:bg-primary'
        })
      ),
      // 响应区：状态行 + 响应体 / 响应头（高度由拖拽条决定；可折叠为仅状态行）
      el(
        'div',
        {
          className: 'flex shrink-0 flex-col',
          style: activeTab.respCollapsed ? undefined : { height: Math.round(resRatio * 100) + '%' }
        },
        el(
          'div',
          { className: 'flex items-center gap-3 px-3 py-1.5 text-xs' },
          el('span', { className: 'shrink-0 font-medium text-muted-foreground' }, '响应'),
          statusPill,
          response && el('span', { className: 'text-muted-foreground' }, response.timeMs + ' ms'),
          response && el('span', { className: 'text-muted-foreground' }, (response.body || '').length + ' B'),
          contentType && el('span', { className: 'truncate text-muted-foreground/80', title: contentType }, contentType),
          error && el('span', { className: 'text-destructive' }, '错误：' + error),
          // 响应面板折叠 / 展开
          el('button', {
            className:
              'ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
            title: activeTab.respCollapsed ? '展开响应面板' : '折叠响应面板',
            onClick: () => updateActive({ respCollapsed: !activeTab.respCollapsed })
          }, h(activeTab.respCollapsed ? ChevronUp : ChevronDown, { className: 'size-3.5' }))
        ),
        !activeTab.respCollapsed &&
        h(
          Tabs,
          { value: activeTab.resTab, onValueChange: (v) => updateActive({ resTab: v }), className: 'flex min-h-0 flex-1 flex-col' },
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
      ),
      // 请求历史抽屉（右侧滑出）
      h(
        Drawer,
        { open: historyOpen, onOpenChange: setHistoryOpen, direction: 'right' },
        h(
          DrawerContent,
          { className: 'sm:max-w-md' },
          h(
            DrawerHeader,
            { className: 'flex-row items-center justify-between gap-2 border-b border-border px-4 py-3' },
            el(
              'div',
              { className: 'min-w-0' },
              h(DrawerTitle, { className: 'text-sm' }, '请求历史'),
              h(
                DrawerDescription,
                { className: 'text-[11px]' },
                '发送请求后自动记录，最多保留 ' + HISTORY_LIMIT + ' 条'
              )
            ),
            h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                className: 'h-7 shrink-0 gap-1.5 px-2 text-[11px] text-destructive',
                disabled: history.length === 0,
                onClick: clearHistory
              },
              h(Trash2, { className: 'size-3.5' }),
              '清空'
            )
          ),
          el('div', { className: 'min-h-0 flex-1 overflow-auto p-4' }, historyList),
          h(
            DrawerFooter,
            { className: 'flex-row justify-end border-t border-border px-4 py-3' },
            h(
              DrawerClose,
              null,
              h(Button, { variant: 'outline', size: 'sm' }, '关闭')
            )
          )
        )
      ),
      // cURL 导入弹窗
      h(
        Dialog,
        { open: curlOpen, onOpenChange: setCurlOpen },
        h(
          DialogContent,
          { className: 'sm:max-w-xl' },
          h(
            DialogHeader,
            null,
            h(DialogTitle, { className: 'text-sm' }, '导入 cURL 命令'),
            h(DialogDescription, { className: 'text-[11px]' }, '粘贴 curl 命令，解析后载入为新的请求标签')
          ),
          el(Textarea, {
            value: curlText,
            onChange: (e) => setCurlText(e.target.value),
            placeholder:
              'curl -X POST https://api.example.com/users \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"foo"}\'',
            className: 'min-h-32 max-h-64 font-mono text-xs',
            spellCheck: false,
            autoFocus: true,
            // Ctrl/Cmd + Enter 直接导入
            onKeyDown: (e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                importCurl()
              }
            }
          }),
          h(
            DialogFooter,
            null,
            h(Button, { variant: 'outline', size: 'sm', onClick: () => setCurlOpen(false) }, '取消'),
            h(Button, { size: 'sm', disabled: !curlText.trim(), onClick: importCurl }, '导入')
          )
        )
      )
    )
  }

  return {
    name: '接口请求',
    views: [{ viewId: 'api-client', name: '接口请求', icon: '🌐', Component: ApiClientView }]
  }
}
