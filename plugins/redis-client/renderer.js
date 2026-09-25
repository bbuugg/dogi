/**
 * redis-client 插件渲染端。
 *
 * 运行时由宿主经 blob import 执行，只用 activate(api) 注入的能力：
 * api.react / api.h / api.antd / api.cn / api.icons / api.storage / api.invoke / api.MonacoEditor。
 * 布局：左侧「连接 + 数据库 / key 浏览」，右侧「数据（值查看 / 编辑）」与「信息（INFO）」两个页签。
 *
 * 注意：所有 hooks 都必须在本文件唯一的 React 组件内部调用，
 * activate() 只是装配阶段，不能碰 hooks。
 */
export function activate(api) {
  const h = api.h
  const { useState, useEffect, useMemo, useCallback } = api.react
  const {
    Button, Input, Select, Tag, Empty, Modal, Skeleton, Tooltip, Popconfirm,
    Form, Table, Drawer, Divider, Row, Col, Segmented, InputNumber,
    Alert, Space, message
  } = api.antd
  const {
    Plus, PlugZap, Power, RefreshCw, Trash2, Pencil, Search, Play,
    Key, FileText, Layers, List, Boxes, TrendingUp, Waves,
    Loader2, Clock, Server, Info, Wifi, WifiOff,
    Save, RotateCcw, Timer, Database, PenLine, Filter, FileJson, Table2, Check
  } = api.icons
  const cn = api.cn
  const MonacoEditor = api.MonacoEditor

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

  /** 可编辑类型（stream 是追加型结构，不提供编辑） */
  const EDITABLE = ['string', 'hash', 'list', 'set', 'zset']
  /** 各类型「一条记录」的称呼 */
  const UNIT_LABEL = { hash: '字段', list: '元素', set: '成员', zset: '成员' }

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

  /**
   * 猜 Monaco 语言：能解析成 JSON 的给 json（可折叠 + 格式化），否则纯文本。
   * 只影响高亮，保存时始终按原样字符串写入，不做任何转换。
   */
  const detectLang = (text) => {
    const s = String(text ?? '').trim()
    if (!s) return 'plaintext'
    const looksJson =
      (s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))
    if (!looksJson) return 'plaintext'
    try {
      JSON.parse(s)
      return 'json'
    } catch {
      return 'plaintext'
    }
  }

  /** INFO 的 keyspace 行：`db0: keys=152,expires=0,avg_ttl=0` */
  const parseKeyspace = (text) => {
    const out = []
    for (const line of String(text || '').split(/\s{2,}/)) {
      const m = /^(db\d+):\s*(.*)$/.exec(line.trim())
      if (!m) continue
      const kv = {}
      for (const part of m[2].split(',')) {
        const i = part.indexOf('=')
        if (i > 0) kv[part.slice(0, i).trim()] = part.slice(i + 1).trim()
      }
      out.push({
        db: m[1],
        keys: Number(kv.keys) || 0,
        expires: Number(kv.expires) || 0,
        avgTtl: Number(kv.avg_ttl) || 0
      })
    }
    return out
  }

  /* ---------------------------------------------------------------
   * 连接表单弹窗（带 hooks 的稳定组件）
   * ------------------------------------------------------------- */
  function ConnFormModal({ open, editing, onSave, onClose }) {
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
   * 条目编辑器（Monaco）：hash 字段 / list 元素 / set 成员 / zset 成员
   * ------------------------------------------------------------- */
  function EntryEditorDrawer({ open, mode, kind, keyName, activeId, db, field, index, member, initialValue, initialScore, onClose, onSaved }) {
    const [fieldName, setFieldName] = useState('')
    const [value, setValue] = useState('')
    const [score, setScore] = useState('0')
    const [lang, setLang] = useState('plaintext')
    const [saving, setSaving] = useState(false)

    useEffect(() => {
      if (!open) return
      const v = initialValue ?? ''
      setFieldName(field ?? '')
      setValue(v)
      setScore(String(initialScore ?? '0'))
      setLang(detectLang(v))
      setSaving(false)
    }, [open, mode, kind, field, index, member, initialValue, initialScore])

    const isAdd = mode === 'add'
    const unit = UNIT_LABEL[kind] || '值'
    // set / zset 的「名字」就是编辑器里的内容（成员本身）；hash 的名字是单独的字段名输入框
    const memberFromEditor = kind === 'set' || kind === 'zset'
    const canSave =
      !saving &&
      (kind !== 'hash' || fieldName.trim().length > 0) &&
      (!memberFromEditor || value.length > 0) &&
      (kind !== 'zset' || String(score).trim() !== '')

    const save = async () => {
      if (!canSave) return
      setSaving(true)
      try {
        if (kind === 'hash') {
          await api.invoke('setHashField', { id: activeId, db, key: keyName, field: fieldName, value })
        } else if (kind === 'list') {
          if (isAdd) await api.invoke('pushListItem', { id: activeId, db, key: keyName, value })
          else await api.invoke('setListItem', { id: activeId, db, key: keyName, index, value })
        } else if (kind === 'set') {
          if (isAdd) {
            await api.invoke('addSetMember', { id: activeId, db, key: keyName, member: value })
          } else if (value !== member) {
            // SET 没有「原地改名」：删旧成员 + 加新成员
            await api.invoke('delSetMember', { id: activeId, db, key: keyName, member })
            await api.invoke('addSetMember', { id: activeId, db, key: keyName, member: value })
          }
        } else if (kind === 'zset') {
          await api.invoke('addZsetMember', { id: activeId, db, key: keyName, member: value, score })
        }
        message.success('已保存')
        onSaved?.()
        onClose()
      } catch (e) {
        message.error(String(e.message || e))
      } finally {
        setSaving(false)
      }
    }

    const editor = h('div', { className: 'h-[280px] min-h-0 border rounded-md overflow-hidden' },
      h(MonacoEditor, {
        value,
        onChange: (v) => setValue(v),
        language: lang,
        onLanguageChange: setLang,
        showLanguageSelector: true,
        showWordWrapToggle: true,
        showLineNumbersToggle: true,
        showCopyButton: true,
        height: '100%'
      }))

    return h(Drawer, {
      open,
      onClose,
      size: 560,
      title: `${isAdd ? '新增' : '编辑'}${unit}`,
      destroyOnHidden: true,
      footer: h('div', { className: 'flex justify-end gap-2' },
        h(Button, { onClick: onClose }, '取消'),
        h(Button, { type: 'primary', icon: h(Save, { className: 'w-3.5 h-3.5' }), loading: saving, disabled: !canSave, onClick: save }, '保存'))
    },
      h('div', { className: 'space-y-3' },
        h('div', { className: 'text-[12px] text-muted-foreground font-mono break-all' }, `key: ${keyName}`),
        kind === 'hash' &&
          h(Form, { layout: 'vertical' },
            h(Form.Item, { label: '字段名', required: true, className: 'mb-2' },
              h(Input, { value: fieldName, disabled: !isAdd, onChange: (e) => setFieldName(e.target.value), placeholder: 'field' }))),
        kind === 'list' && !isAdd &&
          h('div', { className: 'text-[12px] text-muted-foreground' }, `位置：#${index}（列表只能改值，不能改位置）`),
        kind === 'zset' &&
          h(Form, { layout: 'vertical' },
            h(Form.Item, { label: '分数 (score)', className: 'mb-2' },
              h(Input, { value: score, onChange: (e) => setScore(e.target.value), placeholder: '0' }))),
        h('div', {},
          h('div', { className: 'text-[12px] font-medium mb-1.5' }, kind === 'hash' ? '值' : unit),
          editor))
    )
  }

  /* ---------------------------------------------------------------
   * key 元信息弹窗：重命名 / 设置 TTL
   * ------------------------------------------------------------- */
  function KeyMetaModal({ open, mode, keyName, ttl, activeId, db, onClose, onSaved }) {
    const [name, setName] = useState('')
    const [ttlInput, setTtlInput] = useState(3600)
    const [busy, setBusy] = useState(false)

    useEffect(() => {
      if (!open) return
      setName(keyName ?? '')
      setTtlInput(ttl && ttl > 0 ? ttl : 3600)
      setBusy(false)
    }, [open, mode, keyName, ttl])

    const save = async () => {
      setBusy(true)
      try {
        if (mode === 'rename') {
          const next = name.trim()
          if (!next) throw new Error('新 key 不能为空')
          await api.invoke('renameKey', { id: activeId, db, key: keyName, newKey: next })
          message.success('已重命名')
          onSaved?.(next)
        } else {
          const sec = Math.floor(Number(ttlInput) || 0)
          await api.invoke('setTtl', { id: activeId, db, key: keyName, ttl: sec })
          message.success(sec > 0 ? `已设置 ${ttlLabel(sec)} 后过期` : '已设为永不过期')
          onSaved?.()
        }
        onClose()
      } catch (e) {
        message.error(String(e.message || e))
      } finally {
        setBusy(false)
      }
    }

    const presets = [
      { label: '1 分钟', value: 60 },
      { label: '10 分钟', value: 600 },
      { label: '1 小时', value: 3600 },
      { label: '1 天', value: 86400 }
    ]

    return h(Modal, {
      open,
      title: mode === 'rename' ? '重命名 key' : '设置过期时间',
      onCancel: onClose,
      onOk: save,
      okText: '保存',
      confirmLoading: busy,
      destroyOnHidden: true
    },
      mode === 'rename'
        ? h(Form, { layout: 'vertical', className: 'pt-2' },
            h(Form.Item, { label: '原 key' }, h(Input, { value: keyName, disabled: true })),
            h(Form.Item, { label: '新 key', required: true },
              h(Input, { value: name, onChange: (e) => setName(e.target.value), onPressEnter: save, placeholder: 'new:key:name' })))
        : h(Form, { layout: 'vertical', className: 'pt-2' },
            h(Form.Item, { label: 'key' }, h(Input, { value: keyName, disabled: true })),
            h(Form.Item, { label: '过期时间（秒）', extra: '0 表示永不过期（PERSIST）' },
              h(InputNumber, { value: ttlInput, min: 0, style: { width: '100%' }, onChange: (v) => setTtlInput(v ?? 0) })),
            h(Space, { size: 6, wrap: true },
              presets.map((p) => h(Button, { key: p.value, size: 'small', onClick: () => setTtlInput(p.value) }, p.label)),
              h(Button, { size: 'small', onClick: () => setTtlInput(0) }, '永不过期')))
    )
  }

  /* ---------------------------------------------------------------
   * 信息页面：INFO 解析成分节表格 + 原始文本（Monaco 只读）
   * ------------------------------------------------------------- */
  function InfoPage({ activeId, db, connectionName }) {
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [filter, setFilter] = useState('')
    const [view, setView] = useState('overview')
    const [autoSec, setAutoSec] = useState(0)
    const [updatedAt, setUpdatedAt] = useState(null)

    const fetchInfo = useCallback(async (silent) => {
      if (!activeId) return
      if (!silent) setLoading(true)
      try {
        const d = await api.invoke('infoSections', { id: activeId, db })
        setData(d)
        setUpdatedAt(new Date())
      } catch (e) {
        if (!silent) message.error(String(e.message || e))
      } finally {
        if (!silent) setLoading(false)
      }
    }, [activeId, db])

    useEffect(() => {
      setData(null)
      setFilter('')
      void fetchInfo(false)
    }, [fetchInfo])

    // 自动刷新：只在开启时挂定时器，切页签/关连接即随卸载清理
    useEffect(() => {
      if (!autoSec || !activeId) return
      const timer = setInterval(() => void fetchInfo(true), autoSec * 1000)
      return () => clearInterval(timer)
    }, [autoSec, activeId, fetchInfo])

    const sections = data?.sections || {}
    const order = data?.order || []
    const labels = data?.labels || {}

    const metrics = useMemo(() => {
      const g = (sec, k) => sections[sec]?.[k]
      const hits = Number(g('stats', 'keyspace_hits') || 0)
      const misses = Number(g('stats', 'keyspace_misses') || 0)
      const total = hits + misses
      const list = [
        { label: '版本', value: g('server', 'redis_version'), Icon: Server },
        { label: '运行模式', value: g('server', 'redis_mode'), Icon: Database },
        { label: '运行时长', value: fmtUptime(g('server', 'uptime_in_seconds')), Icon: Clock },
        { label: '客户端连接', value: g('clients', 'connected_clients'), Icon: Wifi },
        { label: '内存占用', value: g('memory', 'used_memory_human'), Icon: Layers },
        { label: '内存峰值', value: g('memory', 'used_memory_peak_human'), Icon: TrendingUp },
        { label: '瞬时 QPS', value: g('stats', 'instantaneous_ops_per_sec'), Icon: Play },
        { label: '命令总数', value: g('stats', 'total_commands_processed'), Icon: FileText },
        { label: '命中率', value: total ? `${((hits / total) * 100).toFixed(1)}%` : undefined, Icon: Check },
        { label: '当前 DB key 数', value: data?.dbsize, Icon: Key },
        { label: '复制角色', value: g('replication', 'role'), Icon: RefreshCw },
        { label: 'AOF', value: g('persistence', 'aof_enabled') === '1' ? '已开启' : g('persistence', 'aof_enabled') === '0' ? '未开启' : undefined, Icon: Save }
      ]
      return list.filter((m) => m.value != null && m.value !== '')
    }, [sections, data])

    const keyspace = useMemo(() => parseKeyspace(sections.keyspace ? Object.entries(sections.keyspace).map(([k, v]) => `${k}: ${v}`).join('  ') : ''), [sections])

    const filtered = useMemo(() => {
      const q = filter.trim().toLowerCase()
      const out = []
      for (const name of order) {
        const entries = Object.entries(sections[name] || {})
        const rows = (q
          ? entries.filter(([k, v]) => k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q))
          : entries
        ).map(([k, v]) => ({ k, v }))
        if (rows.length) out.push({ name, rows })
      }
      return out
    }, [order, sections, filter])

    const sectionTitle = (name) => {
      const map = {
        server: '服务器', clients: '客户端', memory: '内存', persistence: '持久化',
        stats: '统计', replication: '复制', cpu: 'CPU', cluster: '集群',
        keyspace: '键空间', commandstats: '命令统计', latencystats: '延迟统计',
        errorstats: '错误统计', modules: '模块'
      }
      return map[name] || labels[name] || name
    }

    const raw = data?.raw ?? ''
    const matchCount = useMemo(() => {
      const q = filter.trim().toLowerCase()
      if (!q) return null
      return filtered.reduce((n, s) => n + s.rows.length, 0)
    }, [filtered, filter])

    const toolbar = h('div', { className: 'border-b p-2 flex items-center gap-2 flex-wrap bg-muted/20 shrink-0' },
      h(Segmented, {
        size: 'small',
        value: view,
        onChange: setView,
        options: [
          { label: '分节概览', value: 'overview', icon: h(Table2, { className: 'w-3.5 h-3.5' }) },
          { label: '原始文本', value: 'raw', icon: h(FileJson, { className: 'w-3.5 h-3.5' }) }
        ]
      }),
      h(Input, {
        size: 'small',
        allowClear: true,
        value: filter,
        onChange: (e) => setFilter(e.target.value),
        prefix: h(Filter, { className: 'w-3.5 h-3.5 text-muted-foreground' }),
        placeholder: view === 'raw' ? '在原始文本里搜索（高亮匹配）' : '过滤参数名 / 值',
        style: { width: 240 }
      }),
      h('div', { className: 'flex-1' }),
      updatedAt && h('span', { className: 'text-xs text-muted-foreground tabular-nums' },
        `${updatedAt.toLocaleTimeString()} 更新`),
      h(Select, {
        size: 'small',
        value: autoSec,
        style: { width: 108 },
        options: [
          { label: '不自动刷新', value: 0 },
          { label: '每 3 秒', value: 3 },
          { label: '每 5 秒', value: 5 },
          { label: '每 10 秒', value: 10 },
          { label: '每 30 秒', value: 30 }
        ],
        onChange: setAutoSec
      }),
      h(Tooltip, { title: '立即刷新' },
        h(Button, { size: 'small', type: 'text', icon: h(RefreshCw, { className: cn('w-4 h-4', loading && 'animate-spin') }), onClick: () => void fetchInfo(false) })))

    let body
    if (view === 'raw') {
      body = h('div', { className: 'flex-1 min-h-0 p-2' },
        h('div', { className: 'h-full min-h-0 border rounded-md overflow-hidden' },
          h(MonacoEditor, {
            value: raw,
            language: 'plaintext',
            readOnly: true,
            showWordWrapToggle: true,
            showLineNumbersToggle: true,
            showCopyButton: true,
            height: '100%'
          })))
    } else if (!data && loading) {
      body = h('div', { className: 'p-4 space-y-2' }, Array.from({ length: 8 }).map((_, i) => h(Skeleton, { key: i, active: true, paragraph: { rows: 1 }, title: false })))
    } else {
      body = h('div', { className: 'flex-1 min-h-0 overflow-auto p-3 space-y-3' },
        h('div', { className: 'grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2' },
          metrics.map((m) => h('div', { key: m.label, className: 'border rounded-md p-2.5 bg-card' },
            h('div', { className: 'flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground' },
              m.Icon ? h(m.Icon, { className: 'w-3 h-3' }) : null, m.label),
            h('div', { className: 'text-[14px] font-mono font-medium mt-0.5 break-all' }, String(m.value))))),
        keyspace.length > 0 && h('div', { className: 'border rounded-md overflow-hidden' },
          h('div', { className: 'px-3 py-1.5 border-b bg-muted/40 text-[12px] font-medium flex items-center gap-1.5' },
            h(Key, { className: 'w-3.5 h-3.5' }), '键空间 (keyspace)'),
          h(Table, {
            size: 'small',
            rowKey: (r) => r.db,
            dataSource: keyspace,
            pagination: false,
            columns: [
              { title: '数据库', dataIndex: 'db', width: 100, render: (v) => h('span', { className: 'font-mono text-[12px]' }, v) },
              { title: 'key 数', dataIndex: 'keys', width: 120, render: (v) => h('span', { className: 'font-mono text-[12px]' }, v) },
              { title: '带过期时间', dataIndex: 'expires', width: 140, render: (v) => h('span', { className: 'font-mono text-[12px]' }, v) },
              { title: '平均 TTL', dataIndex: 'avgTtl', render: (v) => h('span', { className: 'font-mono text-[12px] text-muted-foreground' }, v ? ttlLabel(Math.round(v / 1000)) : '-') }
            ]
          })),
        filter.trim() && matchCount === 0 &&
          h(Alert, { type: 'info', showIcon: true, message: `没有匹配「${filter.trim()}」的 INFO 参数` }),
        filtered.map((s) => h('div', { key: s.name, className: 'border rounded-md overflow-hidden' },
          h('div', { className: 'px-3 py-1.5 border-b bg-muted/40 text-[12px] font-medium flex items-center gap-1.5' },
            h(ChevronRightSafe, null),
            sectionTitle(s.name),
            h('span', { className: 'text-muted-foreground font-mono text-xs' }, s.name),
            h('span', { className: 'ml-auto text-xs text-muted-foreground' }, `${s.rows.length} 项`)),
          h(Table, {
            size: 'small',
            rowKey: (r) => r.k,
            dataSource: s.rows,
            pagination: false,
            columns: [
              { title: '参数', dataIndex: 'k', width: '38%', render: (v) => h('span', { className: 'font-mono text-[12px] text-muted-foreground break-all' }, v) },
              { title: '值', dataIndex: 'v', render: (v) => h('span', { className: 'font-mono text-[12px] break-all' }, String(v)) }
            ]
          }))),
        !loading && filtered.length === 0 && !filter.trim() &&
          h(Empty, { className: 'pt-10', description: '没有拿到 INFO 数据' }))
    }

    return h('div', { className: 'flex-1 min-w-0 flex flex-col min-h-0' },
      toolbar,
      body,
      connectionName && h('div', { className: 'border-t px-3 py-1 text-xs text-muted-foreground shrink-0' },
        `数据源：${connectionName} · DB${db} · INFO ALL`))
  }

  /** INFO 小节标题前的小箭头（单独包一层，避免直接把图标当组件名传） */
  function ChevronRightSafe() {
    const Chevron = api.icons.ChevronRight
    return h(Chevron, { className: 'w-3.5 h-3.5 text-muted-foreground' })
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
    // 每个连接各自最后使用的 DB（切走再切回要保住，不能直接跳回连接配置里的 db）
    const [dbByConn, setDbByConn] = useState({})
    const [pattern, setPattern] = useState('*')
    const [keys, setKeys] = useState([])
    const [cursor, setCursor] = useState(0)
    const [scanDone, setScanDone] = useState(false)
    const [loadingKeys, setLoadingKeys] = useState(false)
    const [selKey, setSelKey] = useState(null)
    const [keyMeta, setKeyMeta] = useState(null)
    const [keyView, setKeyView] = useState(null)
    const [loadingView, setLoadingView] = useState(false)
    const [stats, setStats] = useState(null)
    const [loadingStats, setLoadingStats] = useState(false)
    const [cmdInput, setCmdInput] = useState('')
    const [cmdLog, setCmdLog] = useState([])
    const [cmdBusy, setCmdBusy] = useState(false)

    // 右侧页签：数据 / 信息
    const [rightTab, setRightTab] = useState('data')
    // string 值的编辑草稿（null = 未进入编辑态）
    const [strDraft, setStrDraft] = useState(null)
    const [strLang, setStrLang] = useState('plaintext')
    const [savingStr, setSavingStr] = useState(false)
    // 条目编辑抽屉 / key 元信息弹窗
    const [entry, setEntry] = useState(null)
    const [metaModal, setMetaModal] = useState(null)

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

    /**
     * 与主进程连接状态对账。
     * 必要：插件「重新加载」会重建主进程的连接表（conns = new Map()），此前建立的连接全部失效，
     * 但渲染端本地 connStates 仍显示「已连接」→ 界面一直停在旧数据上。
     * 这里按字段比较后只在真正变化时 setState（state 每次返回新对象，直接 set 会无限重渲染）。
     */
    useEffect(() => {
      if (!conns.length) return
      let cancelled = false
      const sync = async () => {
        const entries = await Promise.all(
          conns.map(async (c) => {
            try {
              const st = await api.invoke('state', c.id)
              return [c.id, { connected: !!st?.connected, error: st?.error ?? null }]
            } catch {
              return [c.id, { connected: false, error: '未连接' }]
            }
          })
        )
        if (cancelled) return
        setConnStates((prev) => {
          let changed = false
          const next = { ...prev }
          for (const [id, st] of entries) {
            const cur = prev[id]
            if (!cur || cur.connected !== st.connected || (cur.error ?? null) !== (st.error ?? null)) {
              next[id] = st
              changed = true
            }
          }
          return changed ? next : prev
        })
      }
      void sync()
      const timer = setInterval(() => {
        if (document.visibilityState === 'visible') void sync()
      }, 4000)
      return () => {
        cancelled = true
        clearInterval(timer)
      }
    }, [conns])

    const resetBrowse = (d) => {
      setDb(d ?? 0)
      setPattern('*')
      setKeys([])
      setCursor(0)
      setScanDone(false)
      setSelKey(null)
      setKeyMeta(null)
      setKeyView(null)
      setStrDraft(null)
    }

    // db 必须显式传入：调用方常常是「setDb(新值) 之后同一 tick 里就调本函数」，
    // 那时闭包里的 db 还是旧值，会把 stats 拉到上一个（别的连接的）DB 上。
    const loadStats = async (id, d) => {
      setLoadingStats(true)
      try {
        const s = await api.invoke('serverStats', { id, db: d })
        setStats(s)
      } catch {} finally {
        setLoadingStats(false)
      }
    }

    // 注意：id 必须显式传入。connect() 里 setActiveId 后立刻调本函数，
    // 此时 activeId 还是旧值（首次连接是 null），靠闭包读会直接 return 导致列表空白。
    const doScan = async (id, d, pat, cur, append) => {
      if (!id) return
      setLoadingKeys(true)
      try {
        const res = await api.invoke('scanKeys', { id, db: d, pattern: pat, cursor: cur, count: 200 })
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
        setRightTab('data')
        const d = dbByConn[conn.id] ?? conn.db ?? 0
        resetBrowse(d)
        loadStats(conn.id, d)
        doScan(conn.id, d, '*', 0, false)
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

    const onPatternSubmit = () => doScan(activeId, db, pattern, 0, false)
    const onLoadMore = () => doScan(activeId, db, pattern, cursor, true)

    const onSwitchDb = (d) => {
      setDb(d)
      setDbByConn((prev) => (activeId ? { ...prev, [activeId]: d } : prev))
      setSelKey(null)
      setKeyMeta(null)
      setKeyView(null)
      setStrDraft(null)
      doScan(activeId, d, '*', 0, false)
      // stats 里有「当前 DB key 数」且 serverStats 会 ensureDb，切库必须一起重载
      if (activeId) loadStats(activeId, d)
    }

    /**
     * 切换当前连接。
     * 原来这里只做 setActiveId —— 结果左侧「数据库」区会继续显示上一个连接的
     * DB / 匹配模式 / key 列表，右侧也留着上一个 key 的值，看起来就是「切了连接但没刷新」。
     * 必须把「连接成功后」那一整套（重置浏览态 + 重载 stats + 重新 SCAN）复用一遍。
     */
    const selectConn = (conn) => {
      if (conn.id === activeId) return
      const d = dbByConn[conn.id] ?? conn.db ?? 0
      setActiveId(conn.id)
      resetBrowse(d)
      if (connStates[conn.id]?.connected) {
        loadStats(conn.id, d)
        doScan(conn.id, d, '*', 0, false)
      } else {
        // 还没连上：清掉上一个连接的残留，别让左边继续显示别人的 key
        setStats(null)
      }
    }

    /** 载入某个 key 的元信息 + 值；编辑保存后也复用它刷新 */
    const onSelectKey = useCallback(async (key, opts) => {
      if (!activeId) return
      const silent = opts?.silent
      setSelKey(key)
      if (!silent) {
        setLoadingView(true)
        setKeyMeta(null)
        setKeyView(null)
        setStrDraft(null)
      }
      try {
        const meta = await api.invoke('keyMeta', { id: activeId, db, key })
        setKeyMeta(meta)
        if (meta.exists && meta.type !== 'none') {
          const view = await api.invoke('getValue', { id: activeId, db, key, type: meta.type })
          setKeyView(view)
          if (view?.type === 'string') {
            setStrDraft(view.data?.value ?? '')
            setStrLang(detectLang(view.data?.value ?? ''))
          }
        } else {
          setKeyView(null)
        }
      } catch (e) {
        message.error(String(e.message || e))
      } finally {
        if (!silent) setLoadingView(false)
      }
    }, [activeId, db])

    const refreshView = () => { if (selKey && activeId) void onSelectKey(selKey) }

    const onDeleteKey = async () => {
      if (!activeId || !selKey) return
      try {
        await api.invoke('deleteKey', { id: activeId, db, key: selKey })
        message.success('已删除')
        setKeys((prev) => prev.filter((k) => k.key !== selKey))
        setSelKey(null)
        setKeyMeta(null)
        setKeyView(null)
        setStrDraft(null)
      } catch (e) {
        message.error(String(e.message || e))
      }
    }

    /* ---------- 写入：string / 条目 / TTL / 重命名 ---------- */

    const saveString = async () => {
      if (!activeId || !selKey || strDraft == null) return
      setSavingStr(true)
      try {
        await api.invoke('setString', { id: activeId, db, key: selKey, value: strDraft })
        message.success('已保存')
        await onSelectKey(selKey, { silent: true })
      } catch (e) {
        message.error(String(e.message || e))
      } finally {
        setSavingStr(false)
      }
    }

    const removeEntry = async (kind, row) => {
      if (!activeId || !selKey) return
      try {
        if (kind === 'hash') await api.invoke('delHashField', { id: activeId, db, key: selKey, field: row.field })
        else if (kind === 'list') await api.invoke('delListItem', { id: activeId, db, key: selKey, index: row.index })
        else if (kind === 'set') await api.invoke('delSetMember', { id: activeId, db, key: selKey, member: row })
        else if (kind === 'zset') await api.invoke('delZsetMember', { id: activeId, db, key: selKey, member: row.member })
        message.success('已删除')
        await onSelectKey(selKey, { silent: true })
      } catch (e) {
        message.error(String(e.message || e))
      }
    }

    const openEntry = (mode, kind, row) => {
      setEntry({
        open: true,
        mode,
        kind,
        field: kind === 'hash' ? row?.field : undefined,
        index: kind === 'list' ? row?.index : undefined,
        member: kind === 'set' ? row : kind === 'zset' ? row?.member : undefined,
        initialValue:
          kind === 'hash' || kind === 'list' ? row?.value
            : kind === 'set' ? row
              : kind === 'zset' ? row?.member
                : '',
        initialScore: kind === 'zset' ? row?.score : undefined
      })
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
        // 写命令后顺手刷新当前视图，省得手动点刷新
        if (/^(SET|DEL|HSET|HDEL|LPUSH|RPUSH|LSET|LREM|SADD|SREM|ZADD|ZREM|EXPIRE|PERSIST|RENAME)$/i.test(cmd)) {
          void doScan(activeId, db, pattern, 0, false)
          if (selKey) void onSelectKey(selKey, { silent: true })
        }
      } catch (e) {
        setCmdLog((prev) => [{ cmd: raw, out: String(e.message || e), ok: false }, ...prev].slice(0, 50))
      } finally {
        setCmdBusy(false)
      }
    }

    /* --------- 各区域渲染 --------- */

    const deleteConn = async (conn) => {
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
        onClick: () => selectConn(conn),
        key: conn.id
      },
        h('span', { className: 'text-[13px]' },
          connected
            ? h(Wifi, { className: 'w-4 h-4 text-green-500' })
            : h(WifiOff, { className: 'w-4 h-4 text-muted-foreground' })),
        h('div', { className: 'flex-1 min-w-0' },
          h('div', { className: 'truncate text-[13px] font-medium' }, conn.name),
          h('div', { className: 'truncate text-xs text-muted-foreground font-mono' }, `${conn.host}:${conn.port}`)),
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
            // key 名不是合法 UTF-8：主进程给的是 hex，不是真 key，点了必然「无数据」。
            // 这里禁掉点击并说明原因，避免变成一个让人白试的死条目。
            if (k.binary) {
              return h('div', {
                key: k.key,
                title: '该 key 名不是合法 UTF-8，界面无法安全地按名操作（列表里显示的是 hex）。请在下方命令框用 \\xNN 形式操作。',
                className: 'flex items-center gap-1.5 px-1.5 py-1 rounded opacity-55 cursor-not-allowed text-[12.5px]'
              },
                h(Icon, { className: 'w-3.5 h-3.5 shrink-0 text-muted-foreground' }),
                h('span', { className: 'flex-1 truncate font-mono' }, k.key),
                h(Tag, { color: 'orange', className: 'm-0 text-[10px] leading-4 shrink-0' }, '二进制名'))
            }
            return h('div', {
              key: k.key,
              className: cn('flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer hover:bg-muted text-[12.5px]',
                selected && 'bg-primary/10'),
              onClick: () => void onSelectKey(k.key)
            },
              h(Icon, { className: 'w-3.5 h-3.5 shrink-0 text-muted-foreground' }),
              h('span', { className: 'flex-1 truncate font-mono' }, k.key))
          })),
        h('div', { className: 'shrink-0 p-1.5 space-y-1' },
          (!scanDone && keys.length > 0) &&
            h(Button, { size: 'small', block: true, type: 'dashed', loading: loadingKeys, onClick: onLoadMore }, '加载更多'),
          scanDone &&
            h('div', { className: 'text-center text-xs text-muted-foreground' }, `共 ${keys.length} 个 key`))
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

    /** 通用「操作」列：编辑 + 删除 */
    const entryActions = (kind) => ({
      title: '操作',
      key: 'ops',
      width: 88,
      render: (_, row) => h('div', { className: 'flex items-center gap-0.5' },
        h(Tooltip, { title: '编辑' },
          h(Button, { size: 'small', type: 'text', icon: h(Pencil, { className: 'w-3.5 h-3.5' }), onClick: () => openEntry('edit', kind, row) })),
        h(Popconfirm, {
          title: `确认删除该${UNIT_LABEL[kind]}？`,
          okText: '删除',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onConfirm: () => void removeEntry(kind, row)
        }, h(Button, { size: 'small', type: 'text', danger: true, icon: h(Trash2, { className: 'w-3.5 h-3.5' }) })))
    })

    const renderValueView = () => {
      const typ = keyMeta?.type || 'unknown'
      const t = TYPE_STYLE[typ] || TYPE_STYLE.unknown
      const Icon = t.Icon
      const data = keyView?.data
      const editable = EDITABLE.includes(typ)

      let body
      if (loadingView) {
        body = h('div', { className: 'p-4 space-y-2' }, Array.from({ length: 6 }).map((_, i) => h(Skeleton, { key: i, active: true })))
      } else if (!keyView || !data) {
        body = h(Empty, { className: 'pt-16', description: '该 key 无数据或不存在' })
      } else if (typ === 'string') {
        const binary = !!data.binary
        // 二进制值只读：编辑器 readOnly 挡得住用户输入，但挡不住程序化 setValue，
        // 那种情况下 strDraft 会与 data.value 不等 → 会错误地把「还原/保存」点亮。
        // 这里直接按 binary 短路，保证只读态下两个按钮恒为禁用。
        const dirty = !binary && strDraft != null && strDraft !== data.value
        body = h('div', { className: 'flex-1 min-h-0 flex flex-col gap-2' },
          h('div', { className: 'flex items-center gap-2 text-[12px] text-muted-foreground flex-wrap' },
            h('span', {}, `长度 ${data.strlen} 字节`),
            binary ? h(Tag, { color: 'orange' }, '二进制 / HEX（只读）') : h(Tag, { color: 'green' }, 'UTF-8'),
            dirty && h(Tag, { color: 'gold' }, '未保存')),
          binary &&
            h(Alert, {
              type: 'warning',
              showIcon: true,
              message: '该值不是合法 UTF-8，当前以 HEX 显示；为避免写坏数据，编辑器为只读。'
            }),
          h('div', {
            className: 'flex-1 min-h-0 overflow-hidden',
            // Monaco 会吃掉 Ctrl+S，所以在捕获阶段先截住（捕获先于编辑器自身的监听）
            onKeyDownCapture: (e) => {
              if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
                e.preventDefault()
                e.stopPropagation()
                if (dirty && !binary) void saveString()
              }
            }
          },
            h(MonacoEditor, {
              value: strDraft ?? '',
              onChange: (v) => setStrDraft(v),
              language: strLang,
              onLanguageChange: setStrLang,
              showLanguageSelector: true,
              readOnly: binary,
              showWordWrapToggle: true,
              showLineNumbersToggle: true,
              showCopyButton: true,
              height: '100%',
              actions: h(Space, { size: 6 },
                h(Button, {
                  type: 'text',
                  size: 'small',
                  icon: h(RotateCcw, { className: 'w-3.5 h-3.5' }),
                  disabled: !dirty,
                  onClick: () => setStrDraft(data.value ?? '')
                }),
                h(Button, {
                  size: 'small',
                  type: 'text',
                  icon: h(Save, { className: 'w-3.5 h-3.5' }),
                  loading: savingStr,
                  disabled: !dirty || binary,
                  onClick: () => void saveString()
                }))
            })))
      } else if (typ === 'hash' || typ === 'zset' || typ === 'list') {
        const cols =
          typ === 'hash'
            ? [
                { title: '字段', dataIndex: 'field', width: '32%', render: (v) => h('span', { className: 'font-mono text-[12px]' }, v) },
                { title: '值', dataIndex: 'value', render: (v) => h('span', { className: 'font-mono text-[12px] whitespace-pre-wrap break-all' }, v) },
                entryActions(typ)
              ]
            : typ === 'zset'
              ? [
                  { title: '成员', dataIndex: 'member', width: '60%', render: (v) => h('span', { className: 'font-mono text-[12px] break-all' }, v) },
                  { title: '分数', dataIndex: 'score', render: (v) => h('span', { className: 'font-mono text-[12px] text-green-600' }, v) },
                  entryActions(typ)
                ]
              : [
                  { title: '#', dataIndex: 'index', width: 64, render: (v) => h('span', { className: 'text-muted-foreground font-mono text-[12px]' }, v) },
                  { title: '值', dataIndex: 'value', render: (v) => h('span', { className: 'font-mono text-[12px] whitespace-pre-wrap break-all' }, v) },
                  entryActions(typ)
                ]
        body = h(Table, {
          size: 'small',
          rowKey: (r) => (typ === 'hash' ? r.field : typ === 'zset' ? r.member : r.index),
          dataSource: data.entries,
          pagination: false,
          scroll: { y: 'calc(100vh - 320px)', x: true },
          columns: cols
        })
      } else if (typ === 'set') {
        body = h('div', { className: 'p-3 flex flex-wrap gap-1.5 overflow-auto max-h-[60vh]' },
          data.entries.map((v) => h(Tag, {
            key: v,
            color: 'cyan',
            className: 'font-mono text-[12px] m-0 inline-flex items-center gap-1 pr-1'
          },
            v,
            h(Popconfirm, {
              title: `确认删除成员「${v}」？`,
              okText: '删除',
              okButtonProps: { danger: true },
              cancelText: '取消',
              onConfirm: () => void removeEntry('set', v)
            }, h(Button, { size: 'small', type: 'text', className: 'w-4 h-4 p-0', icon: h(Trash2, { className: 'w-3 h-3' }) })))))
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
              h('span', { className: 'text-xs text-muted-foreground' }, e.fields.length + ' 个字段')),
            h('div', { className: 'grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[12px] font-mono pl-2' }, cells))
        })
        body = h('div', { className: 'p-1.5 space-y-1.5 overflow-auto max-h-[60vh]' }, streamCards)
      } else {
        body = h(Empty, { className: 'pt-16', description: '暂不支持该类型查看' })
      }

      const addLabel = typ === 'hash' ? '新增字段' : typ === 'list' ? '新增元素' : typ === 'set' || typ === 'zset' ? '新增成员' : null

      return h('div', { className: 'p-3 flex-1 min-h-0 flex flex-col' },
        h('div', { className: 'flex items-center gap-2 mb-2 flex-wrap' },
          h(Icon, { className: 'w-4 h-4' }),
          h('span', { className: 'font-mono text-[13px] font-semibold break-all' }, selKey),
          h(Tag, { color: t.color }, typ),
          h(Tooltip, { title: '设置过期时间' },
            h('span', { className: 'text-[12px] text-muted-foreground inline-flex items-center gap-1 cursor-pointer hover:text-foreground' },
              h(Clock, { className: 'w-3.5 h-3.5' }), `TTL ${ttlLabel(keyMeta?.ttl)}`)),
          h('div', { className: 'flex-1' }),
          addLabel && h(Button, {
            size: 'small',
            icon: h(Plus, { className: 'w-3.5 h-3.5' }),
            onClick: () => openEntry('add', typ)
          }, addLabel),
          h(Tooltip, { title: '设置 TTL' },
            h(Button, { size: 'small', type: 'text', icon: h(Timer, { className: 'w-3.5 h-3.5' }), onClick: () => setMetaModal({ mode: 'ttl' }) })),
          h(Tooltip, { title: '重命名 key' },
            h(Button, { size: 'small', type: 'text', icon: h(PenLine, { className: 'w-3.5 h-3.5' }), onClick: () => setMetaModal({ mode: 'rename' }) })),
          h(Button, { size: 'small', type: 'text', icon: h(RefreshCw, { className: 'w-3.5 h-3.5' }), onClick: refreshView, title: '刷新' }),
          h(Popconfirm, {
            title: '确认删除该 key？',
            okText: '删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            onConfirm: onDeleteKey
          }, h(Button, { size: 'small', danger: true, type: 'text', icon: h(Trash2, { className: 'w-3.5 h-3.5' }), title: '删除' }))),
        (data?.count != null || editable) && h(Divider, { className: 'my-2', plain: true, titlePlacement: 'left' },
          h('span', { className: 'text-[12px] text-muted-foreground' },
            data?.count != null && `共 ${data.count} 条`,
            data?.truncated && h('span', { className: 'text-amber-600 ml-2' }, '(仅展示前 500 条)'),
            typ === 'string' && h('span', {}, '直接编辑后按「保存」或 Ctrl+S 写回'))),
        // 必须是 flex 容器：body 里的 string 编辑器靠 `flex-1` 吃满剩余高度，
        // 而 `flex-1` 只在 flex 父容器下生效 —— 这里原来是纯 block，
        // 结果 body 塌成内容高度（约 70px），再往下 Monaco 只剩 5px（Monaco 的 5×5 保底尺寸）。
        // 其他类型（表格/集合/流）各自带 viewport 定高（calc(100vh - N) / max-h-[60vh]），
        // 所以只有 string 会踩到这个坑。
        h('div', { className: 'flex-1 min-h-0 flex flex-col overflow-auto' }, body))
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
                h('div', { className: 'text-xs uppercase tracking-wide text-muted-foreground' }, c.label),
                h('div', { className: 'text-[14px] font-mono font-medium mt-0.5' }, c.value)))),
        (s.keyspaceText || !stats) && h('div', { className: 'border rounded-md p-2.5 bg-card', style: { display: stats ? undefined : 'none' } },
          h('div', { className: 'text-[12px] text-muted-foreground mb-1' }, '键空间 (keyspace)'),
          h('div', { className: 'text-[12.5px] font-mono whitespace-pre-wrap' }, s.keyspaceText)),
        h('div', { className: 'border rounded-md p-3 bg-card flex items-center gap-2 text-[12.5px] text-muted-foreground' },
          h(Info, { className: 'w-4 h-4 shrink-0' }),
          h('span', {}, '完整服务器信息（分节概览 / 原始文本、自动刷新）在右上角「信息」页签；左侧选一个 key 即可查看并编辑数据。')))
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
      // 已连接：头栏（含 数据/信息 页签）+ 内容区 + 命令行（仅数据页）
      const isInfo = rightTab === 'info'
      return h('div', { className: 'flex-1 min-w-0 flex flex-col min-h-0' },
        h('div', { className: 'border-b p-2.5 flex items-center gap-2 flex-wrap bg-muted/20 shrink-0' },
          h('span', { className: 'relative flex w-2.5 h-2.5 shrink-0' },
            h('span', { className: 'animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75' }),
            h('span', { className: 'relative inline-flex rounded-full w-2.5 h-2.5 bg-green-500' })),
          h('span', { className: 'text-[13px] font-medium' }, active.name),
          h('span', { className: 'text-[12px] text-muted-foreground font-mono' }, `${active.host}:${active.port}`),
          stats?.redis_version && h(Tag, { color: 'blue' }, `Redis ${stats.redis_version}`),
          h('div', { className: 'flex-1' }),
          h(Segmented, {
            size: 'small',
            value: rightTab,
            onChange: setRightTab,
            options: [
              { label: '数据', value: 'data', icon: h(Key, { className: 'w-3.5 h-3.5' }) },
              { label: '信息', value: 'info', icon: h(Info, { className: 'w-3.5 h-3.5' }) }
            ]
          }),
          h('span', { className: 'text-[12px] text-muted-foreground' }, `DB${db}`),
          h(Button, { size: 'small', danger: true, type: 'text', icon: h(Power, { className: 'w-4 h-4' }), onClick: () => disconnect(active) }, '断开')),
        isInfo
          ? h(InfoPage, { activeId: active.id, db, connectionName: active.name })
          : h('div', { className: 'flex-1 min-h-0 flex flex-col' },
              h('div', { className: 'flex-1 min-h-0 overflow-hidden flex' },
                selKey ? renderValueView() : h('div', { className: 'flex-1 min-w-0 overflow-auto' }, renderOverview())),
              h('div', { className: 'p-1.5 flex flex-col gap-1 bg-muted/20 shrink-0' },
                h('div', { className: 'flex gap-1.5 items-center' },
                  h('span', { className: 'text-xs text-muted-foreground font-mono shrink-0' }, '$_'),
                  h(Input, {
                    value: cmdInput,
                    onChange: (e) => setCmdInput(e.target.value),
                    onPressEnter: runCommand,
                    disabled: cmdBusy,
                    placeholder: '执行 Redis 命令，如 GET user:1、TYPE mykey'
                  }),
                  h(Button, { icon: h(Play, { className: 'w-3.5 h-3.5' }), type: 'primary', loading: cmdBusy, onClick: runCommand }, '执行')),
                cmdLog.length > 0 && h('div', { className: 'max-h-32 overflow-y-auto space-y-0.5' },
                  cmdLog.map((l, i) => h('div', { key: i, className: 'text-[12px] font-mono flex gap-2 px-1' },
                    h('span', { className: 'text-muted-foreground shrink-0' }, l.cmd),
                    h('span', { className: cn('break-all', l.ok ? 'text-green-600' : 'text-red-500') }, l.out)))))),
        h(EntryEditorDrawer, {
          open: !!entry?.open,
          mode: entry?.mode,
          kind: entry?.kind,
          keyName: selKey,
          activeId: active.id,
          db,
          field: entry?.field,
          index: entry?.index,
          member: entry?.member,
          initialValue: entry?.initialValue,
          initialScore: entry?.initialScore,
          onClose: () => setEntry(null),
          onSaved: () => { if (selKey) void onSelectKey(selKey, { silent: true }) }
        }),
        h(KeyMetaModal, {
          open: !!metaModal,
          mode: metaModal?.mode,
          keyName: selKey,
          ttl: keyMeta?.ttl,
          activeId: active.id,
          db,
          onClose: () => setMetaModal(null),
          onSaved: (newKey) => {
            if (metaModal?.mode === 'rename' && newKey) {
              setSelKey(newKey)
              void doScan(activeId, db, pattern, 0, false)
              void onSelectKey(newKey, { silent: true })
            } else if (selKey) {
              void onSelectKey(selKey, { silent: true })
            }
          }
        })
      )
    }

    return h('div', { className: 'h-full w-full flex bg-background text-foreground min-h-0 overflow-hidden' },
      renderSidebar(),
      renderRight(),
      h(ConnFormModal, {
        open: !!modal,
        editing: modal?.editing || null,
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
