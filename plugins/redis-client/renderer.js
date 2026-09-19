/**
 * redis-client 插件渲染端。
 *
 * 运行时由宿主经 blob import 执行，只用 activate(api) 注入的能力：
 * api.react / api.h / api.antd / api.cn / api.icons / api.storage / api.invoke。
 * 布局：左侧「连接 + 数据库 / key 浏览」，右侧「值查看器」。
 *
 * 注意：所有 hooks 都必须在本文件唯一的 React 组件 App() 内部调用，
 * activate() 只是装配阶段，不能碰 hooks。
 */
export function activate(api) {
  const h = api.h
  const { useState, useEffect } = api.react
  const {
    Button, Input, Select, Tag, Empty, Modal, Skeleton, Tooltip, Popconfirm,
    Form, Table, Drawer, Divider, Row, Col, message
  } = api.antd
  const {
    Plus, PlugZap, Power, RefreshCw, Trash2, Pencil, Search, Play,
    Key, FileText, Layers, List, Boxes, TrendingUp, Waves,
    Loader2, Clock, Server, Info, Wifi, WifiOff
  } = api.icons
  const cn = api.cn

  const CONN_KEY = 'connections'
  const DB_COUNT = 16

  const TYPE_STYLE = {
    string: { color: 'blue', Icon: FileText },
    hash: { color: 'gold', Icon: Layers },
    list: { color: 'cyan', Icon: List },
    set: { color: 'magenta', Icon: Boxes },
    zset: { color: 'green', Icon: TrendingUp },
    stream: { color: 'purple', Icon: Waves },
    none: { color: 'default', Icon: Key },
    unknown: { color: 'default', Icon: Key }
  }

  const ttlLabel = (ttl) => {
    if (ttl == null) return '-'
    if (ttl === -1) return '永不过期'
    if (ttl === -2) return '不存在'
    if (ttl < 60) return `${ttl}s`
    if (ttl < 3600) return `${Math.floor(ttl / 60)}m ${ttl % 60}s`
    if (ttl < 86400) return `${Math.floor(ttl / 3600)}h ${Math.floor((ttl % 3600) / 60)}m`
    return `${Math.floor(ttl / 86400)}d`
  }

  const genId = () => 'con_' + Math.random().toString(36).slice(2, 10)

  const fmtUptime = (sec) => {
    const n = Number(sec)
    if (!n || n < 0) return '-'
    if (n < 60) return `${n}s`
    if (n < 3600) return `${Math.floor(n / 60)}m`
    if (n < 86400) return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`
    return `${Math.floor(n / 86400)}天 ${Math.floor((n % 86400) / 3600)}h`
  }

  /* ---------------------------------------------------------------
   * 连接表单弹窗（带 hooks 的稳定组件）
   * ------------------------------------------------------------- */
  function ConnFormModal({ open, editing, conns, onSave, onClose }) {
    const [f, setF] = useState({
      name: editing?.name ?? '',
      host: editing?.host ?? '127.0.0.1',
      port: editing?.port ?? 6379,
      username: editing?.username ?? '',
      password: editing?.password ?? '',
      db: editing?.db ?? 0,
      tls: editing?.tls ?? false,
      timeoutMs: editing?.timeoutMs ?? 10000
    })
    useEffect(() => {
      if (!open) return
      setF({
        name: editing?.name ?? '',
        host: editing?.host ?? '127.0.0.1',
        port: editing?.port ?? 6379,
        username: editing?.username ?? '',
        password: editing?.password ?? '',
        db: editing?.db ?? 0,
        tls: editing?.tls ?? false,
        timeoutMs: editing?.timeoutMs ?? 10000
      })
    }, [open, editing])
    const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))
    const okDisabled = !f.name.trim() || !f.host.trim() || !/^\d+$/.test(String(f.port))
    const save = () => {
      const obj = {
        id: editing?.id ?? genId(),
        name: f.name.trim(),
        host: f.host.trim(),
        port: Number(f.port),
        username: f.username,
        password: f.password,
        db: Number(f.db ?? 0),
        tls: !!f.tls,
        timeoutMs: Number(f.timeoutMs || 10000)
      }
      onSave(obj, !!editing)
      onClose()
    }

    return h(Modal, {
      open,
      title: editing ? '编辑连接' : '新建连接',
      onCancel: onClose,
      onOk: save,
      okText: '保存',
      okButtonProps: { disabled: okDisabled },
      destroyOnHidden: true
    }, h(Form, { layout: 'vertical', className: 'pt-2' },
      h(Form.Item, { label: '名称', required: true }, h(Input, { value: f.name, onChange: set('name'), placeholder: '如 本地 Redis' })),
      h(Row, { gutter: 12 },
        h(Col, { span: 12 }, h(Form.Item, { label: '主机', required: true }, h(Input, { value: f.host, onChange: set('host'), placeholder: '127.0.0.1' }))),
        h(Col, { span: 12 }, h(Form.Item, { label: '端口', required: true }, h(Input, { value: String(f.port), onChange: set('port') })))
      ),
      h(Row, { gutter: 12 },
        h(Col, { span: 12 }, h(Form.Item, { label: '数据库', required: true },
          h(Select, {
            value: f.db,
            style: { width: '100%' },
            options: Array.from({ length: DB_COUNT }, (_, i) => ({ label: `DB${i}`, value: i })),
            onChange: (v) => setF((p) => ({ ...p, db: v }))
          }))),
        h(Col, { span: 12 }, h(Form.Item, { label: '用户名 (ACL，可选)' }, h(Input, { value: f.username, onChange: set('username'), placeholder: 'default' })))
      ),
      h(Row, { gutter: 12 },
        h(Col, { span: 12 }, h(Form.Item, { label: '密码', extra: '无密码可留空' }, h(Input.Password, { value: f.password, onChange: set('password'), placeholder: '******' }))),
        h(Col, { span: 12 }, h(Form.Item, { label: 'TLS 加密' },
          h(Select, {
            value: f.tls ? 'tls' : 'plain',
            style: { width: '100%' },
            options: [{ label: '普通', value: 'plain' }, { label: 'TLS', value: 'tls' }],
            onChange: (v) => setF((p) => ({ ...p, tls: v === 'tls' }))
          })))
      ),
      h(Form.Item, { label: '连接超时 (ms)' }, h(Input, { value: f.timeoutMs, onChange: set('timeoutMs'), placeholder: '10000' }))
    ))
  }

  /* ---------------------------------------------------------------
   * INFO 抽屉（带 hooks 的稳定组件）
   * ------------------------------------------------------------- */
  function InfoDrawer({ open, onClose, activeId, db }) {
    const [txt, setTxt] = useState(null)
    useEffect(() => {
      if (!open) return
      setTxt(null)
      let alive = true
      if (activeId) {
        api.invoke('info', { id: activeId, db })
          .then((r) => alive && setTxt(String(r)))
          .catch((e) => alive && setTxt(String(e.message || e)))
      }
      return () => { alive = false }
    }, [open, activeId, db])
    return h(Drawer, { open, onClose, size: 480, title: 'Redis INFO' },
      h('pre', { className: 'whitespace-pre-wrap break-all text-[12px] font-mono select-text' }, txt ?? '加载中...')
    )
  }

  /* ---------------------------------------------------------------
   * 主组件：全部状态与 handler
   * ------------------------------------------------------------- */
  function App() {
    const [conns, setConns] = useState([])
    const [activeId, setActiveId] = useState(null)
    const [connStates, setConnStates] = useState({})
    const [busyConn, setBusyConn] = useState(null)
    const [modal, setModal] = useState(null) // { editing: conn|null }

    const [db, setDb] = useState(0)
    const [pattern, setPattern] = useState('*')
    const [keys, setKeys] = useState([])
    const [cursor, setCursor] = useState(0)
    const [scanDone, setScanDone] = useState(false)
    const [loadingKeys, setLoadingKeys] = useState(false)
    const [reloading, setReloading] = useState(false)
    const [selKey, setSelKey] = useState(null)
    const [keyMeta, setKeyMeta] = useState(null)
    const [keyView, setKeyView] = useState(null)
    const [loadingView, setLoadingView] = useState(false)
    const [stats, setStats] = useState(null)
    const [loadingStats, setLoadingStats] = useState(false)
    const [infoDrawer, setInfoDrawer] = useState(false)
    const [cmdInput, setCmdInput] = useState('')
    const [cmdLog, setCmdLog] = useState([])
    const [cmdBusy, setCmdBusy] = useState(false)

    const active = conns.find((c) => c.id === activeId) || null
    const activeState = connStates[activeId]
    const isConnected = Boolean(activeState && activeState.connected)

    const persist = (list) => {
      setConns(list)
      api.storage.set(CONN_KEY, list).catch((e) => message.error(`保存失败：${e.message}`))
    }

    useEffect(() => {
      api.storage.get(CONN_KEY).then((list) => {
        if (Array.isArray(list)) setConns(list)
      }).catch(() => {})
    }, [])

    const resetBrowse = (d) => {
      setDb(d ?? 0)
      setPattern('*')
      setKeys([])
      setCursor(0)
      setScanDone(false)
      setSelKey(null)
      setKeyMeta(null)
      setKeyView(null)
    }

    const loadStats = async (id) => {
      setLoadingStats(true)
      try {
        const s = await api.invoke('serverStats', { id, db })
        setStats(s)
      } catch {} finally {
        setLoadingStats(false)
      }
    }

    const doScan = async (d, pat, cur, append) => {
      if (!activeId) return
      setLoadingKeys(true)
      try {
        const res = await api.invoke('scanKeys', { id: activeId, db: d, pattern: pat, cursor: cur, count: 200 })
        setKeys((prev) => (append ? [...prev, ...res.keys] : res.keys))
        setCursor(res.cursor)
        setScanDone(res.done)
      } catch (e) {
        message.error(String(e.message || e))
      } finally {
        setLoadingKeys(false)
      }
    }

    const connect = async (conn) => {
      setBusyConn(conn.id)
      setConnStates((s) => ({ ...s, [conn.id]: { connected: false, error: null } }))
      try {
        await api.invoke('connect', {
          id: conn.id,
          host: conn.host,
          port: conn.port,
          username: conn.username || '',
          password: conn.password || '',
          db: conn.db ?? 0,
          tls: !!conn.tls,
          timeoutMs: conn.timeoutMs || 10000
        })
        setConnStates((s) => ({ ...s, [conn.id]: { connected: true, error: null } }))
        setActiveId(conn.id)
        resetBrowse(conn.db ?? 0)
        loadStats(conn.id)
        doScan(conn.db ?? 0, '*', 0, false)
        message.success(`已连接到 ${conn.name}`)
      } catch (e) {
        setConnStates((s) => ({ ...s, [conn.id]: { connected: false, error: String(e.message || e) } }))
        message.error(String(e.message || e))
      } finally {
        setBusyConn(null)
      }
    }

    const disconnect = async (conn) => {
      try { await api.invoke('disconnect', conn.id) } catch {}
      setConnStates((s) => ({ ...s, [conn.id]: { connected: false, error: null } }))
      if (activeId === conn.id) {
        resetBrowse(0)
        setStats(null)
      }
    }

    const onPatternSubmit = () => doScan(db, pattern, 0, false)
    const onLoadMore = () => doScan(db, pattern, cursor, true)

    const onSwitchDb = (d) => {
      setDb(d)
      setSelKey(null)
      setKeyMeta(null)
      setKeyView(null)
      doScan(d, '*', 0, false)
    }

    const onSelectKey = async (key) => {
      if (!activeId) return
      setSelKey(key)
      setLoadingView(true)
      setKeyMeta(null)
      setKeyView(null)
      try {
        const meta = await api.invoke('keyMeta', { id: activeId, db, key })
        setKeyMeta(meta)
        if (meta.exists && meta.type !== 'none') {
          const view = await api.invoke('getValue', { id: activeId, db, key, type: meta.type })
          setKeyView(view)
        }
      } catch (e) {
        message.error(String(e.message || e))
      } finally {
        setLoadingView(false)
      }
    }

    const refreshView = () => { if (selKey && activeId) onSelectKey(selKey) }

    const onDeleteKey = async () => {
      if (!activeId || !selKey) return
      try {
        await api.invoke('deleteKey', { id: activeId, db, key: selKey })
        message.success('已删除')
        setKeys((prev) => prev.filter((k) => k.key !== selKey))
        setSelKey(null)
        setKeyMeta(null)
        setKeyView(null)
      } catch (e) {
        message.error(String(e.message || e))
      }
    }

    const runCommand = async () => {
      const raw = cmdInput.trim()
      if (!raw || !activeId) return
      const parts = raw.match(/("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)/g) || []
      const args = parts.map((p) =>
        (p[0] === '"' && p[p.length - 1] === '"') || (p[0] === "'" && p[p.length - 1] === "'") ? p.slice(1, -1) : p)
      const cmd = args.shift()
      setCmdBusy(true)
      try {
        const res = await api.invoke('command', { id: activeId, db, cmd, args })
        const out = typeof res === 'string' ? res : JSON.stringify(res)
        setCmdLog((prev) => [{ cmd: raw, out, ok: true }, ...prev].slice(0, 50))
      } catch (e) {
        setCmdLog((prev) => [{ cmd: raw, out: String(e.message || e), ok: false }, ...prev].slice(0, 50))
      } finally {
        setCmdBusy(false)
      }
    }

    /* --------- 各区域渲染 --------- */

    const deleteConn = async (conn) => {
      // 如果已连接，先断开
      const st = connStates[conn.id]
      if (st?.connected) {
        try { await api.invoke('disconnect', conn.id) } catch {}
      }
      setConnStates((s) => {
        const next = { ...s }
        delete next[conn.id]
        return next
      })
      if (activeId === conn.id) {
        setActiveId(null)
        resetBrowse(0)
        setStats(null)
      }
      persist(conns.filter((c) => c.id !== conn.id))
      message.success(`已删除连接「${conn.name}」`)
    }

    const renderConnRow = (conn) => {
      const st = connStates[conn.id]
      const connected = st?.connected
      const selected = conn.id === activeId
      return h('div', {
        className: cn(
          'group flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors border',
          selected ? 'bg-primary/10 border-primary/30' : 'border-transparent hover:bg-muted'
        ),
        onClick: () => setActiveId(conn.id),
        key: conn.id
      },
        h('span', { className: 'text-[13px]' },
          connected
            ? h(Wifi, { className: 'w-4 h-4 text-green-500' })
            : h(WifiOff, { className: 'w-4 h-4 text-muted-foreground' })),
        h('div', { className: 'flex-1 min-w-0' },
          h('div', { className: 'truncate text-[13px] font-medium' }, conn.name),
          h('div', { className: 'truncate text-[11px] text-muted-foreground font-mono' }, `${conn.host}:${conn.port}`)),
        h('div', { className: 'flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity' },
          h(Tooltip, { title: '编辑' },
            h(Button, { size: 'small', type: 'text', icon: h(Pencil, { className: 'w-3.5 h-3.5' }),
              onClick: (e) => { e.stopPropagation(); setModal({ editing: conn }) } })),
          h(Popconfirm, {
            title: `确认删除连接「${conn.name}」？`,
            okText: '删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            onConfirm: () => deleteConn(conn)
          },
            h(Button, { size: 'small', type: 'text', danger: true, icon: h(Trash2, { className: 'w-3.5 h-3.5' }),
              onClick: (e) => e.stopPropagation() }))),
        busyConn === conn.id
          ? h(Loader2, { className: 'w-3.5 h-3.5 animate-spin text-muted-foreground' })
          : h(Button, {
              size: 'small',
              type: connected ? 'text' : 'primary',
              icon: connected ? h(Power, { className: 'w-3.5 h-3.5' }) : h(PlugZap, { className: 'w-3.5 h-3.5' }),
              danger: connected,
              onClick: (e) => {
                e.stopPropagation()
                connected ? disconnect(conn) : connect(conn)
              }
            }, connected ? '断开' : '连接'))
    }

    const renderKeyList = () => {
      if (loadingKeys && keys.length === 0) {
        return h('div', { className: 'space-y-1 p-1' },
          Array.from({ length: 8 }).map((_, i) => h(Skeleton, { key: i, active: true, paragraph: { rows: 1 }, title: false })))
      }
      if (keys.length === 0) {
        return h(Empty, { className: 'pt-8', description: '无匹配 key' })
      }
      return h('div', { className: 'flex flex-col h-full' },
        h('div', { className: 'flex-1 min-h-0 overflow-y-auto space-y-0.5 p-0.5' },
          keys.map((k) => {
            const t = TYPE_STYLE[k.type] || TYPE_STYLE.unknown
            const Icon = t.Icon
            const selected = selKey === k.key
            return h('div', {
              key: k.key,
              className: cn('flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer hover:bg-muted text-[12.5px]',
                selected && 'bg-primary/10'),
              onClick: () => onSelectKey(k.key)
            },
              h(Icon, { className: 'w-3.5 h-3.5 shrink-0 text-muted-foreground' }),
              h('span', { className: 'flex-1 truncate font-mono' }, k.key))
          })),
        h('div', { className: 'shrink-0 p-1.5 space-y-1' },
          (!scanDone && keys.length > 0) &&
            h(Button, { size: 'small', block: true, type: 'dashed', loading: loadingKeys, onClick: onLoadMore }, '加载更多'),
          scanDone &&
            h('div', { className: 'text-center text-[11px] text-muted-foreground' }, `共 ${keys.length} 个 key`))
      )
    }

    const renderSidebar = () => h('div',
      { className: 'w-[300px] shrink-0 border-r bg-muted/30 flex flex-col min-h-0' },
      h('div', { className: 'px-3 py-2 flex items-center justify-between border-b' },
        h('span', { className: 'text-xs uppercase tracking-wider text-muted-foreground' }, '连接管理'),
        h(Button, { size: 'small', type: 'primary', icon: h(Plus, { className: 'w-3.5 h-3.5' }), onClick: () => setModal({ editing: null }) }, '新建')),
      h('div', { className: 'flex-1 min-h-0 overflow-y-auto p-2 space-y-1' },
        conns.length === 0
          ? h(Empty, { className: 'pt-10', description: '暂无连接' })
          : conns.map(renderConnRow)),
      isConnected
        ? h('div', { className: 'border-t flex flex-col min-h-0 flex-[1.6]' },
            h('div', { className: 'px-3 py-2 flex items-center gap-1.5 border-b' },
              h('span', { className: 'text-xs uppercase tracking-wider text-muted-foreground' }, '数据库'),
              h(Select, {
                size: 'small',
                value: db,
                style: { width: 76 },
                options: Array.from({ length: DB_COUNT }, (_, i) => ({ label: `DB${i}`, value: i })),
                onChange: onSwitchDb
              })),
            h('div', { className: 'px-3 py-2 border-b flex gap-1.5' },
              h(Input, {
                size: 'small',
                value: pattern,
                onChange: (e) => setPattern(e.target.value),
                onPressEnter: onPatternSubmit,
                prefix: h(Search, { className: 'w-3.5 h-3.5 text-muted-foreground' }),
                placeholder: '模式，如 user:*'
              }),
              h(Tooltip, { title: '刷新' }, h(Button, { size: 'small', type: 'text', icon: h(RefreshCw, { className: 'w-3.5 h-3.5' }), onClick: onPatternSubmit }))),
            h('div', { className: 'flex-1 min-h-0 overflow-hidden', style: { maxHeight: 'calc(100vh - 300px)' } }, renderKeyList()))
        : null
    )

    const renderValueView = () => {
      const typ = keyMeta?.type || 'unknown'
      const t = TYPE_STYLE[typ] || TYPE_STYLE.unknown
      const Icon = t.Icon
      const data = keyView?.data

      let body
      if (loadingView) {
        body = h('div', { className: 'p-4 space-y-2' }, Array.from({ length: 6 }).map((_, i) => h(Skeleton, { key: i, active: true })))
      } else if (!keyView || !data) {
        body = h(Empty, { className: 'pt-16', description: '该 key 无数据或不存在' })
      } else if (typ === 'string') {
        body = h('div', { className: 'p-3 space-y-2' },
          h('div', { className: 'flex items-center gap-2 text-[12px] text-muted-foreground' },
            h('span', {}, `长度为 ${data.strlen} 字节`),
            data.binary ? h(Tag, { color: 'orange' }, '二进制 / HEX') : h(Tag, { color: 'green' }, 'UTF-8')),
          h('pre', {
            className: cn('p-3 rounded-md border bg-slate-950 text-green-300 text-[12.5px] font-mono whitespace-pre-wrap break-all select-text max-h-[60vh] overflow-auto', data.binary && 'text-amber-300')
          }, data.value))
      } else if (typ === 'hash' || typ === 'zset' || typ === 'list') {
        const cols =
          typ === 'hash'
            ? [
                { title: '字段', dataIndex: 'field', width: '40%', render: (v) => h('span', { className: 'font-mono text-[12px]' }, v) },
                { title: '值', dataIndex: 'value', render: (v) => h('span', { className: 'font-mono text-[12px] whitespace-pre-wrap break-all' }, v) }
              ]
            : typ === 'zset'
              ? [
                  { title: '成员', dataIndex: 'member', width: '70%', render: (v) => h('span', { className: 'font-mono text-[12px] break-all' }, v) },
                  { title: '分数', dataIndex: 'score', render: (v) => h('span', { className: 'font-mono text-[12px] text-green-600' }, v) }
                ]
              : [
                  { title: '#', dataIndex: 'index', width: 64, render: (v) => h('span', { className: 'text-muted-foreground font-mono text-[12px]' }, v) },
                  { title: '值', dataIndex: 'value', render: (v) => h('span', { className: 'font-mono text-[12px] whitespace-pre-wrap break-all' }, v) }
                ]
        body = h(Table, {
          size: 'small',
          rowKey: (r) => (typ === 'hash' ? r.field : typ === 'zset' ? r.member : r.index),
          dataSource: data.entries,
          pagination: false,
          scroll: { y: 'calc(100vh - 300px)', x: true },
          columns: cols
        })
      } else if (typ === 'set') {
        body = h('div', { className: 'p-3 flex flex-wrap gap-1.5 overflow-auto max-h-[60vh]' },
          data.entries.map((v) => h(Tag, { key: v, color: 'cyan', className: 'font-mono text-[12px]' }, v)))
      } else if (typ === 'stream') {
        const streamCards = data.entries.map(function (e) {
          const cells = []
          for (const f of e.fields) {
            cells.push(h('span', { key: 'k-' + f.field, className: 'text-muted-foreground' }, f.field))
            cells.push(h('span', { key: 'v-' + f.field, className: 'break-all' }, f.value))
          }
          return h('div', { key: e.id, className: 'border rounded p-2' },
            h('div', { className: 'flex items-center gap-2 mb-1' },
              h('span', { className: 'font-mono text-[12px] text-purple-600' }, e.id),
              h('span', { className: 'text-[11px] text-muted-foreground' }, e.fields.length + ' 个字段')),
            h('div', { className: 'grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[12px] font-mono pl-2' }, cells))
        })
        body = h('div', { className: 'p-1.5 space-y-1.5 overflow-auto max-h-[60vh]' }, streamCards)
      } else {
        body = h(Empty, { className: 'pt-16', description: '暂不支持该类型查看' })
      }

      return h('div', { className: 'p-3 flex-1 min-h-0 flex flex-col' },
        h('div', { className: 'flex items-center gap-2 mb-2 flex-wrap' },
          h(Icon, { className: 'w-4 h-4' }),
          h('span', { className: 'font-mono text-[13px] font-semibold break-all' }, selKey),
          h(Tag, { color: t.color }, typ),
          h('span', { className: 'text-[12px] text-muted-foreground inline-flex items-center gap-1' },
            h(Clock, { className: 'w-3.5 h-3.5' }), `TTL ${ttlLabel(keyMeta?.ttl)}`),
          h('div', { className: 'flex-1' }),
          h(Button, { size: 'small', type: 'text', icon: h(RefreshCw, { className: 'w-3.5 h-3.5' }), onClick: refreshView, title: '刷新' }),
          h(Popconfirm, {
            title: '确认删除该 key？',
            okText: '删除',
            okButtonProps: { danger: true },
            onConfirm: onDeleteKey
          }, h(Button, { size: 'small', danger: true, type: 'text', icon: h(Trash2, { className: 'w-3.5 h-3.5' }), title: '删除' }))),
        h(Divider, { className: 'my-2', plain: true, orientation: 'left' },
          h('span', { className: 'text-[12px] text-muted-foreground' },
            data?.count != null && `共 ${data.count} 条`,
            data?.truncated && h('span', { className: 'text-amber-600 ml-2' }, '(仅展示前 500 条)'))),
        h('div', { className: 'flex-1 min-h-0 overflow-auto' }, body))
    }

    const renderOverview = () => {
      const s = stats || {}
      const chips = [
        { label: '版本', value: s.redis_version },
        { label: '运行时长', value: fmtUptime(s.uptime) },
        { label: '连接数', value: s.connected_clients },
        { label: '内存', value: s.used_memory_human },
        { label: '累计连接', value: s.total_connections }
      ].filter((c) => c.value != null && c.value !== '-')
      return h('div', { className: 'p-4 space-y-4' },
        h('div', { className: 'text-[15px] font-semibold flex items-center gap-2' }, h(Server, { className: 'w-4 h-4' }), '服务器信息'),
        loadingStats
          ? h(Skeleton, { active: true, paragraph: { rows: 3 } })
          : h('div', { className: 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2' },
              chips.map((c) => h('div', { key: c.label, className: 'border rounded-md p-2.5 bg-card' },
                h('div', { className: 'text-[11px] uppercase tracking-wide text-muted-foreground' }, c.label),
                h('div', { className: 'text-[14px] font-mono font-medium mt-0.5' }, c.value)))),
        (s.keyspaceText || !stats) && h('div', { className: 'border rounded-md p-2.5 bg-card', style: { display: stats ? undefined : 'none' } },
          h('div', { className: 'text-[12px] text-muted-foreground mb-1' }, '键空间 (keyspace)'),
          h('div', { className: 'text-[12.5px] font-mono whitespace-pre-wrap' }, s.keyspaceText)),
        h(Empty, { className: 'pt-8', description: '在左侧选择 key 查看具体数据' }))
    }

    const renderRight = () => {
      if (!active) {
        return h('div', { className: 'flex-1 min-w-0 flex items-center justify-center' },
          h(Empty, { description: '从左侧新建或选择一个连接' }))
      }
      if (!isConnected) {
        const err = activeState?.error
        return h('div', { className: 'flex-1 min-w-0 overflow-auto p-6' },
          h('div', { className: 'border rounded-lg p-5 bg-card space-y-3 max-w-md' },
            h('div', { className: 'flex items-center gap-2' },
              h('span', { className: 'text-[15px] font-semibold' }, active.name),
              h(Tag, { color: err ? 'red' : 'default' }, err ? '连接失败' : '未连接')),
            h('div', { className: 'space-y-1 text-[13px] text-muted-foreground' },
              h('div', {}, `地址：${active.host}:${active.port}`),
              h('div', {}, `数据库：DB${active.db ?? 0}`),
              h('div', {}, `TLS：${active.tls ? '是' : '否'}`),
              active.username ? h('div', {}, `用户名：${active.username}`) : null,
              active.password ? h('div', {}, '密码：******') : null),
            err && h('div', { className: 'text-red-500 text-[12.5px] bg-red-500/5 border border-red-500/20 rounded p-2' }, err),
            h('div', { className: 'flex gap-2 pt-1' },
              h(Button, { type: 'primary', icon: h(PlugZap, { className: 'w-4 h-4' }), loading: busyConn === active.id, onClick: () => connect(active) }, '连接'),
              h(Button, { icon: h(Pencil, { className: 'w-4 h-4' }), onClick: () => setModal({ editing: active }) }, '编辑'),
              h(Popconfirm, {
                title: `确认删除连接「${active.name}」？`,
                okText: '删除',
                okButtonProps: { danger: true },
                cancelText: '取消',
                onConfirm: () => deleteConn(active)
              }, h(Button, { danger: true, icon: h(Trash2, { className: 'w-4 h-4' }) }, '删除')))))
      }
      // 已连接：头栏 + 内容区（值查看或总览）+ 命令行
      return h('div', { className: 'flex-1 min-w-0 flex flex-col min-h-0' },
        h('div', { className: 'border-b p-2.5 flex items-center gap-2 flex-wrap bg-muted/20 shrink-0' },
          h('span', { className: 'relative flex w-2.5 h-2.5 shrink-0' },
            h('span', { className: 'animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75' }),
            h('span', { className: 'relative inline-flex rounded-full w-2.5 h-2.5 bg-green-500' })),
          h('span', { className: 'text-[13px] font-medium' }, active.name),
          h('span', { className: 'text-[12px] text-muted-foreground font-mono' }, `${active.host}:${active.port}`),
          stats?.redis_version && h(Tag, { color: 'blue' }, `Redis ${stats.redis_version}`),
          h('div', { className: 'flex-1' }),
          h('span', { className: 'text-[12px] text-muted-foreground' }, `DB${db}`),
          h(Tooltip, { title: 'INFO' }, h(Button, { size: 'small', type: 'text', icon: h(Info, { className: 'w-4 h-4' }), onClick: () => setInfoDrawer(true) })),
          h(Button, { size: 'small', danger: true, type: 'text', icon: h(Power, { className: 'w-4 h-4' }), onClick: () => disconnect(active) }, '断开')),
        h('div', { className: 'flex-1 min-h-0 overflow-hidden flex' },
          selKey ? renderValueView() : h('div', { className: 'flex-1 min-w-0 overflow-auto' }, renderOverview())),
        h('div', { className: 'border-t p-1.5 flex flex-col gap-1 bg-muted/20 shrink-0' },
          h('div', { className: 'flex gap-1.5 items-center' },
            h('span', { className: 'text-[11px] text-muted-foreground font-mono shrink-0' }, '$_'),
            h(Input, {
              size: 'small',
              value: cmdInput,
              onChange: (e) => setCmdInput(e.target.value),
              onPressEnter: runCommand,
              disabled: cmdBusy,
              placeholder: '执行 Redis 命令，如 GET user:1、TYPE mykey'
            }),
            h(Button, { size: 'small', icon: h(Play, { className: 'w-3.5 h-3.5' }), type: 'primary', loading: cmdBusy, onClick: runCommand }, '执行')),
          cmdLog.length > 0 && h('div', { className: 'max-h-32 overflow-y-auto space-y-0.5' },
            cmdLog.map((l, i) => h('div', { key: i, className: 'text-[12px] font-mono flex gap-2 px-1' },
              h('span', { className: 'text-muted-foreground shrink-0' }, l.cmd),
              h('span', { className: cn('break-all', l.ok ? 'text-green-600' : 'text-red-500') }, l.out))))))
    }

    return h('div', { className: 'h-full w-full flex bg-background text-foreground min-h-0 overflow-hidden' },
      renderSidebar(),
      renderRight(),
      h(InfoDrawer, { open: infoDrawer, onClose: () => setInfoDrawer(false), activeId, db }),
      h(ConnFormModal, {
        open: !!modal,
        editing: modal?.editing || null,
        conns,
        onClose: () => setModal(null),
        onSave: (obj, isEdit) => {
          if (isEdit) {
            persist(conns.map((c) => (c.id === obj.id ? obj : c)))
            message.success('已更新连接')
          } else {
            persist([...conns, obj])
            setConnStates((s) => ({ ...s, [obj.id]: { connected: false, error: null } }))
            setActiveId(obj.id)
            message.success('已保存连接')
          }
        }
      })
    )
  }

  return {
    name: 'Redis客户端',
    views: [
      { viewId: 'redis-client', name: 'Redis', icon: '🔴', Component: App }
    ]
  }
}