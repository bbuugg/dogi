/**
 * port-killer 插件渲染端。
 *
 * 运行时由宿主经 blob import 执行，只用 activate(api) 注入的能力：
 * api.react / api.h / api.antd / api.cn / api.icons / api.storage / api.invoke。
 *
 * 布局：顶栏标题 + 系统标签 → 端口查询输入 → 结果表（协议 / 本地地址 / 状态 / PID / 进程 / 操作）。
 * 结束失败且原因是「权限不足」（主进程 reason='elevating'）时，弹窗给出可在管理员终端执行的命令。
 *
 * 注意：所有 hooks 都必须在本文件唯一的 React 组件内部调用，
 * activate() 只是装配阶段，不能碰 hooks。
 */
export function activate(api) {
  const h = api.h
  const { useState, useEffect, useCallback } = api.react
  const {
    Button, Input, Table, Tag, Alert, Modal, Tooltip, Popconfirm, Space, message
  } = api.antd
  const { Search, RefreshCw, Copy, PlugZap } = api.icons

  /** 复制文本：优先 Clipboard API，失败退回隐藏 textarea + execCommand */
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      document.body.removeChild(ta)
      return ok
    }
  }

  /* ---------------------------------------------------------------
   * 主组件：全部状态与 handler
   * ------------------------------------------------------------- */
  function App() {
    const [platform, setPlatform] = useState(null)
    const [port, setPort] = useState('')
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState(null)
    const [busyPid, setBusyPid] = useState(null)
    const [elevate, setElevate] = useState(null)

    useEffect(() => {
      api.invoke('platform').then(setPlatform).catch(() => {})
      api.storage
        .get('lastPort')
        .then((v) => {
          if (Number.isInteger(v) && v > 0 && v < 65536) setPort(String(v))
        })
        .catch(() => {})
    }, [])

    const doSearch = useCallback(async (raw) => {
      const value = String(raw ?? '').trim()
      if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        message.warning('请输入 1-65535 的端口号')
        return
      }
      setLoading(true)
      try {
        const r = await api.invoke('search', { port: Number(value) })
        setResult(r)
        api.storage.set('lastPort', Number(value)).catch(() => {})
      } catch (e) {
        message.error(String(e?.message || e))
      } finally {
        setLoading(false)
      }
    }, [])

    /** 结束进程：按主进程返回的 reason 分支（elevating 弹管理员命令弹窗） */
    const doKill = async (row) => {
      setBusyPid(row.pid)
      try {
        const r = await api.invoke('kill', { pid: row.pid, name: row.name ?? null })
        if (r?.ok) {
          message.success(`已结束 ${row.name ?? '进程'}（PID ${row.pid}）`)
          await doSearch(port) // 自动复查：表里随即少一行
        } else if (r?.reason === 'elevating') {
          setElevate({ pid: row.pid, name: row.name, command: r.command, hint: r.hint })
        } else {
          message.warning(r?.error ?? '结束进程失败')
          if (r?.reason === 'not_found') await doSearch(port)
        }
      } catch (e) {
        message.error(String(e?.message || e))
      } finally {
        setBusyPid(null)
      }
    }

    const copyCommand = async (row) => {
      try {
        const r = await api.invoke('killCommand', { pid: row.pid })
        const ok = await copyText(r.command)
        if (ok) message.success('已复制命令')
        else message.error('复制失败，请手动选择复制')
      } catch (e) {
        message.error(String(e?.message || e))
      }
    }

    const copyElevate = async () => {
      const ok = await copyText(elevate?.command ?? '')
      if (ok) message.success('已复制命令')
      else message.error('复制失败，请手动选择复制')
    }

    /** PID 缺失或是系统关键进程时不可结束（主进程也会再挡一次） */
    const killDisabled = (row) => row.pid == null || row.pid <= (platform?.protectedPidMax ?? 1)

    const columns = [
      {
        title: '协议',
        dataIndex: 'proto',
        width: 72,
        render: (v) => h(Tag, { color: v === 'TCP' ? 'blue' : 'gold', className: 'm-0' }, v)
      },
      {
        title: '本地地址',
        dataIndex: 'address',
        render: (v) => h('span', { className: 'font-mono text-xs' }, v)
      },
      {
        title: '状态',
        dataIndex: 'state',
        width: 110,
        render: (v) => {
          if (!v) return h('span', { className: 'text-muted-foreground' }, '—')
          if (/LISTEN/i.test(v)) return h(Tag, { color: 'green', className: 'm-0' }, '监听中')
          if (v === 'UNCONN') return h(Tag, { color: 'green', className: 'm-0' }, '已绑定')
          return h(Tag, { className: 'm-0' }, v)
        }
      },
      {
        title: 'PID',
        dataIndex: 'pid',
        width: 90,
        render: (v) =>
          v == null
            ? h('span', { className: 'text-muted-foreground' }, '—')
            : h('span', { className: 'font-mono text-xs' }, String(v))
      },
      {
        title: '进程',
        dataIndex: 'name',
        render: (v, row) =>
          v ?? h('span', { className: 'text-muted-foreground' }, row.pid == null ? '未知（无权限查看）' : '未知进程')
      },
      {
        title: '操作',
        key: 'ops',
        width: 160,
        render: (_, row) =>
          h(
            Space,
            { size: 2 },
            h(
              Tooltip,
              { title: '复制结束进程的命令' },
              h(Button, {
                type: 'text',
                size: 'small',
                title: '复制结束进程的命令',
                icon: h(Copy, { className: 'size-3.5' }),
                disabled: row.pid == null,
                onClick: () => void copyCommand(row)
              })
            ),
            h(
              Popconfirm,
              {
                title: `结束进程${row.name ? ` ${row.name}` : ''}（PID ${row.pid}）？`,
                description: '进程会被强制终止，未保存的数据将丢失',
                okText: '强制结束',
                cancelText: '取消',
                okButtonProps: { danger: true },
                disabled: killDisabled(row),
                onConfirm: () => void doKill(row)
              },
              h(
                Button,
                {
                  type: 'text',
                  size: 'small',
                  danger: true,
                  disabled: killDisabled(row),
                  loading: busyPid === row.pid
                },
                '结束进程'
              )
            )
          )
      }
    ]

    /* ------------------------------ 主体 ------------------------------ */

    let body
    if (!result) {
      body = h(
        'div',
        { className: 'flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground' },
        h(PlugZap, { className: 'size-8 opacity-50' }),
        h('div', { className: 'text-sm' }, '输入端口号，查询本机占用它的进程'),
        h('div', { className: 'text-xs' }, `当前系统：${platform?.platformLabel ?? '…'} · 支持 Windows / Linux / macOS`),
        h('div', { className: 'text-xs' }, '无权限结束时，会给出可在管理员终端执行的命令')
      )
    } else {
      body = h(
        'div',
        { className: 'flex flex-col gap-3' },
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground' },
          h('span', null, `端口 ${result.port}`),
          h('span', null, `查询命令：${result.command}`),
          h('span', null, `占用进程：${result.rows.length} 个`)
        ),
        result.note && h(Alert, { type: 'info', showIcon: true, message: result.note }),
        result.pidUnknown &&
          result.viewAsRootCommand &&
          h(Alert, {
            type: 'warning',
            showIcon: true,
            message: '有进程信息不可见（需要管理员权限）',
            description: h(
              'div',
              { className: 'flex flex-col gap-2' },
              h('div', null, '用以下命令可以查到该端口上进程的 PID：'),
              h(
                'div',
                { className: 'flex flex-wrap items-center gap-2' },
                h(
                  'code',
                  { className: 'select-all rounded bg-muted px-2 py-1 font-mono text-xs' },
                  result.viewAsRootCommand
                ),
                h(
                  Button,
                  { size: 'small', icon: h(Copy, { className: 'size-3.5' }), onClick: () => void copyText(result.viewAsRootCommand).then((ok) => (ok ? message.success('已复制命令') : message.error('复制失败，请手动选择复制'))) },
                  '复制'
                )
              )
            )
          }),
        result.rows.length === 0
          ? h(
              'div',
              { className: 'flex flex-col items-center gap-2 py-12 text-muted-foreground' },
              h(PlugZap, { className: 'size-7 opacity-50' }),
              h('div', { className: 'text-sm' }, `端口 ${result.port} 未发现占用进程`)
            )
          : h(Table, {
              size: 'small',
              rowKey: (r) => `${r.proto}-${r.address}-${r.state}-${r.pid ?? 'x'}-${r.name ?? 'x'}`,
              columns,
              dataSource: result.rows,
              pagination: false,
              loading
            })
      )
    }

    return h(
      'div',
      { className: 'flex h-full flex-col gap-3 overflow-y-auto p-4' },
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        h('span', { className: 'text-base font-medium' }, '端口占用'),
        platform && h(Tag, { className: 'm-0' }, platform.platformLabel),
        h(
          'span',
          { className: 'text-xs text-muted-foreground' },
          '查询本机端口占用进程并可强制结束；无权限时给出命令'
        )
      ),
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        h(Input, {
          placeholder: '输入端口号，如 8080',
          value: port,
          allowClear: true,
          maxLength: 5,
          style: { width: 200 },
          onChange: (e) => setPort(e.target.value.replace(/\D/g, '')),
          onPressEnter: () => void doSearch(port)
        }),
        h(
          Button,
          { type: 'primary', icon: h(Search, { className: 'size-3.5' }), loading, onClick: () => void doSearch(port) },
          '查询'
        ),
        result &&
          h(
            Button,
            { icon: h(RefreshCw, { className: 'size-3.5' }), onClick: () => void doSearch(port) },
            '重新查询'
          )
      ),
      body,
      h(
        Modal,
        {
          open: elevate !== null,
          onCancel: () => setElevate(null),
          title: '需要管理员权限',
          centered: true,
          width: 520,
          destroyOnHidden: true,
          footer: h(Button, { type: 'primary', onClick: () => setElevate(null) }, '知道了')
        },
        elevate &&
          h(
            'div',
            { className: 'flex flex-col gap-3' },
            h(Alert, { type: 'warning', showIcon: true, message: elevate.hint ?? '当前权限不足' }),
            h('div', { className: 'text-sm' }, `无法直接结束 ${elevate.name ?? '该进程'}（PID ${elevate.pid}）。`),
            h('div', { className: 'text-xs text-muted-foreground' }, '复制下面的命令，到管理员终端里执行即可结束它：'),
            h(
              'div',
              { className: 'flex items-center gap-2' },
              h(Input, { readOnly: true, value: elevate.command, className: 'font-mono' }),
              h(
                Button,
                { type: 'primary', ghost: true, icon: h(Copy, { className: 'size-3.5' }), onClick: () => void copyElevate() },
                '复制'
              )
            )
          )
      )
    )
  }

  return {
    name: '端口占用',
    views: [{ viewId: 'port-killer', name: '端口占用', icon: '🔌', Component: App }]
  }
}
