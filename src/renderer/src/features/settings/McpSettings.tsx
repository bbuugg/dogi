import type { BrowserToolMode, McpServerConfig, McpToolInfo, McpTransport } from '@shared/types'
import { MCP_TRANSPORT_HINTS, MCP_TRANSPORT_LABELS, mcpServerSummary, mcpTransportOf } from '@shared/mcp'
import { Button, Input, Modal, Popconfirm, Segmented, Switch, Tag, message } from 'antd'
import { Pencil, Plus, Trash2, Wrench } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useAppStore } from '../../stores/app-store'

interface McpStatus extends McpServerConfig {
  error?: string
}

interface FormState {
  id: string
  name: string
  transport: McpTransport
  command: string
  args: string
  env: Record<string, string>
  url: string
  headers: Record<string, string>
  enabled: boolean
}

const EMPTY: FormState = {
  id: '',
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: {},
  url: '',
  headers: {},
  enabled: true
}

function toForm(server: McpServerConfig | null): FormState {
  if (!server) return { ...EMPTY }
  return {
    id: server.id,
    name: server.name,
    transport: mcpTransportOf(server),
    command: server.command,
    args: (server.args ?? []).join(' '),
    env: server.env ? { ...server.env } : {},
    url: server.url ?? '',
    headers: server.headers ? { ...server.headers } : {},
    enabled: server.enabled
  }
}

export function McpSettings() {
  const [servers, setServers] = useState<McpStatus[]>([])
  const [editing, setEditing] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [fetchingToolsId, setFetchingToolsId] = useState<string | null>(null)
  const [toolsModal, setToolsModal] = useState<{
    name: string
    tools: McpToolInfo[]
    error?: string
  } | null>(null)

  const load = async () => setServers(await window.api.mcp.list())
  useEffect(() => {
    void load()
  }, [])

  // 浏览器工具来源（三态，见 @shared/types 的 BrowserToolMode）：缺省用应用自带的浏览器
  const preferences = useAppStore((s) => s.preferences)
  const browserToolMode = (preferences.browserToolMode ?? 'in-app') as BrowserToolMode
  /** 关掉开关时记住「关之前用的是哪套」，重新打开能回到它 */
  const [lastOnMode, setLastOnMode] = useState<BrowserToolMode>(
    browserToolMode === 'off' ? 'in-app' : browserToolMode
  )
  useEffect(() => {
    if (browserToolMode !== 'off') setLastOnMode(browserToolMode)
  }, [browserToolMode])
  const saveBrowserToolMode = async (next: BrowserToolMode) => {
    try {
      await window.api.prefs.save({ browserToolMode: next })
    } catch {
      // 忽略持久化失败
    }
  }

  const patch = (partial: Partial<FormState>) =>
    setEditing((f) => (f ? { ...f, ...partial } : f))

  /**
   * 键值对编辑（环境变量 / 请求头共用一套逻辑）。
   *
   * 抽成按字段名参数化而不是各写一遍：两处的行为必须完全一致（改名要保持顺序、
   * 空 key 保存时忽略），复制一份迟早会漂。
   */
  type KvField = 'env' | 'headers'
  const setKvKey = (field: KvField, oldKey: string, newKey: string) =>
    setEditing((f) => {
      if (!f) return f
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(f[field])) next[k === oldKey ? newKey : k] = v
      return { ...f, [field]: next }
    })
  const setKvValue = (field: KvField, key: string, value: string) =>
    setEditing((f) => (f ? { ...f, [field]: { ...f[field], [key]: value } } : f))
  const removeKv = (field: KvField, key: string) =>
    setEditing((f) => {
      if (!f) return f
      const next = { ...f[field] }
      delete next[key]
      return { ...f, [field]: next }
    })
  const addKv = (field: KvField, base: string) =>
    setEditing((f) => {
      if (!f) return f
      let key = base
      let i = 1
      while (key in f[field]) key = `${base}_${i++}`
      return { ...f, [field]: { ...f[field], [key]: '' } }
    })

  /** 键值对编辑区的渲染（env 与 headers 只是文案不同） */
  const renderKvEditor = (
    field: KvField,
    opts: { addBase: string; emptyHint: ReactNode; keyPlaceholder: string }
  ) => (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">{opts.emptyHint}</span>
        <Button
          size="small"
          type="text"
          icon={<Plus className="size-3.5" />}
          onClick={() => addKv(field, opts.addBase)}
        >
          添加
        </Button>
      </div>
      {Object.keys(editing?.[field] ?? {}).length === 0 ? (
        <p className="text-xs leading-4 text-muted-foreground">
          暂无。留空的 key 保存时会忽略。
        </p>
      ) : (
        <div className="space-y-1.5">
          {Object.entries(editing?.[field] ?? {}).map(([key, value], index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                className="min-w-0 flex-1 font-mono"
                placeholder={opts.keyPlaceholder}
                value={key}
                onChange={(e) => setKvKey(field, key, e.target.value)}
              />
              <span className="shrink-0 font-mono text-muted-foreground">=</span>
              <Input
                className="min-w-0 flex-1 font-mono"
                placeholder="VALUE"
                value={value}
                onChange={(e) => setKvValue(field, key, e.target.value)}
              />
              <Button
                size="small"
                type="text"
                icon={<Trash2 className="size-3.5" />}
                className="w-7 shrink-0 p-0"
                onClick={() => removeKv(field, key)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )

  const openCreate = () => {
    setEditing({ ...EMPTY })
  }
  const openEdit = (server: McpStatus) => {
    setEditing(toForm(server))
  }
  const closeModal = () => {
    if (saving) return
    setEditing(null)
  }

  const handleSave = async () => {
    if (!editing) return
    const isStdio = editing.transport === 'stdio'
    // 两种传输的必填项不同：本地进程要命令，远端要地址 —— 别用一条「都必填」的规则
    // 逼用户去填那个根本用不上的字段
    if (!editing.name.trim() || (isStdio ? !editing.command.trim() : !editing.url.trim())) {
      message.error(isStdio ? '请填写名称与启动命令' : '请填写名称与服务地址')
      return
    }
    setSaving(true)
    try {
      const clean = (kv: Record<string, string>) =>
        Object.fromEntries(Object.entries(kv).filter(([k]) => k.trim().length > 0))
      const env = clean(editing.env)
      const headers = clean(editing.headers)
      await window.api.mcp.save({
        id: editing.id,
        name: editing.name.trim(),
        transport: editing.transport,
        // 非 stdio 的配置里把 command / args / env 清空：留着旧值会让列表摘要与
        // 「这个 server 到底怎么连」对不上（而且下次改回 stdio 会突然复活一份旧命令）
        command: isStdio ? editing.command.trim() : '',
        args: isStdio ? editing.args.split(/\s+/).filter(Boolean) : [],
        env: isStdio ? env : undefined,
        url: isStdio ? undefined : editing.url.trim(),
        headers: isStdio ? undefined : headers,
        enabled: editing.enabled
      })
      setEditing(null)
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (server: McpStatus) => {
    await window.api.mcp.remove(server.id)
    await load()
  }

  const handleToggle = async (server: McpStatus, enabled: boolean) => {
    await window.api.mcp.save({ ...server, enabled })
    await load()
  }

  /** 拉取单个 MCP 服务的工具清单，结果用 modal 展示 */
  const handleFetchTools = async (server: McpStatus) => {
    setFetchingToolsId(server.id)
    try {
      const result = await window.api.mcp.serverTools(server.id)
      setToolsModal({ name: server.name, tools: result.tools, error: result.error })
    } catch (err) {
      message.error(`拉取工具失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setFetchingToolsId(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          MCP 工具将自动提供给 AI 使用（支持本地进程 / HTTP / SSE 三种传输）
        </p>
        <div className="flex gap-2">
          <Button type="text" icon={<Plus className="size-4" />} size="small" variant="filled" onClick={openCreate}>
            新建
          </Button>
        </div>
      </div>

      {/* 浏览器工具：一个开关（AI 有没有浏览器能力）+ 一个二选一（用哪套引擎）。
          两套工具同名（browser_navigate 等），只能二选一，所以是三态而不是两个开关 */}
      <div className="rounded-md border border-border px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium">浏览器工具</div>
            <div className="text-xs leading-4 text-muted-foreground">
              给 AI 用的浏览器能力。关闭后 AI 拿不到任何浏览器工具（界面里的浏览器面板
              仍可手动使用）。
            </div>
          </div>
          <Switch
            checked={browserToolMode !== 'off'}
            onChange={(v) => void saveBrowserToolMode(v ? lastOnMode : 'off')}
          />
        </div>
        {browserToolMode !== 'off' && (
          <>
            <Segmented
              size="small"
              className="mt-2"
              value={browserToolMode}
              onChange={(v) => void saveBrowserToolMode(v as BrowserToolMode)}
              options={[
                { label: '应用内浏览器', value: 'in-app' },
                { label: '系统浏览器', value: 'system' }
              ]}
            />
            <div className="mt-1.5 text-xs leading-4 text-muted-foreground">
              {browserToolMode === 'in-app'
                ? '应用自带：无窗口运行，画面镜像到右侧「浏览器」标签，不弹本机窗口。'
                : '内置 Playwright MCP 驱动：独立进程，会拉起本机的 Edge / Chrome 窗口。'}
            </div>
          </>
        )}
      </div>

      {servers.length === 0 && (
        <p className="rounded-md py-8 text-center text-xs text-muted-foreground">
          还没有 MCP 服务配置
        </p>
      )}
      {servers.map((server) => (
        <div
          key={server.id}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{server.name}</span>
              {/* 传输方式必须露出来：光看名字猜不出它是本地进程还是远端服务 */}
              <Tag variant="outlined" className="m-0 h-4 px-1.5 text-[9px] leading-4">
                {MCP_TRANSPORT_LABELS[mcpTransportOf(server)]}
              </Tag>
              {server.enabled ? (
                <Tag color="default" className="m-0 h-4 border-0 bg-secondary px-1.5 text-[9px] leading-4">
                  启用
                </Tag>
              ) : (
                <Tag variant="outlined" className="m-0 h-4 px-1.5 text-[9px] leading-4">
                  停用
                </Tag>
              )}
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              {mcpServerSummary(server)}
              {server.error ? ` · ⚠ ${server.error}` : ''}
            </div>
          </div>
          <Switch
            checked={server.enabled}
            onChange={(v) => void handleToggle(server, v)}
          />
          <Button
            size="small"
            type="text"
            icon={<Pencil className="size-3.5" />}
            className="w-7 p-0"
            title="编辑"
            onClick={() => openEdit(server)}
          />
          <Button
            size="small"
            type="text"
            icon={<Wrench className="size-3.5" />}
            className="w-7 p-0"
            title="拉取该服务的工具"
            loading={fetchingToolsId === server.id}
            onClick={() => void handleFetchTools(server)}
          />
          <Popconfirm
            title="删除 MCP 服务"
            description={`确定删除 MCP 服务「${server.name}」吗？`}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(server)}
          >
            <Button
              size="small"
              type="text"
              className="w-7 p-0"
              icon={<Trash2 className="size-3.5" />}
              title="删除"
            />
          </Popconfirm>
        </div>
      ))}

      {toolsModal !== null && (
        <Modal
          title={`「${toolsModal.name}」的工具`}
          open={toolsModal !== null}
          onCancel={() => setToolsModal(null)}
          footer={null}
          width={480}
          destroyOnHidden
          centered
        >
          {toolsModal.error ? (
            <p className="text-xs text-destructive">{toolsModal.error}</p>
          ) : toolsModal.tools.length === 0 ? (
            <p className="text-xs text-muted-foreground">该服务未提供任何工具</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-auto">
              {toolsModal.tools.map((t) => (
                <div key={t.name} className="rounded-md border border-border px-3 py-2">
                  <div className="font-mono text-xs font-medium">{t.name}</div>
                  {t.description && (
                    <div className="mt-0.5 text-xs leading-4 text-muted-foreground">
                      {t.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      <Modal
        title={editing?.id ? '编辑 MCP 服务' : '新建 MCP 服务'}
        open={editing !== null}
        onCancel={closeModal}
        onOk={() => void handleSave()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={520}
        centered
        destroyOnHidden
      >
        {editing && (
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">服务名称</span>
                <Input
                  placeholder="如：filesystem"
                  value={editing.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </div>
              <div className="flex items-center gap-2 pt-5">
                <Switch
                  checked={editing.enabled}
                  onChange={(v) => patch({ enabled: v })}
                  id="mcp-enabled"
                />
                <label htmlFor="mcp-enabled" className="text-xs font-medium text-foreground">
                  启用
                </label>
              </div>
            </div>
            {/* 传输方式：决定下面填什么。默认 stdio（老配置的形态），
                远端两种只是换了个「怎么连」 —— 连上之后行为完全一样 */}
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">传输方式</span>
              <Segmented
                size="small"
                block
                value={editing.transport}
                onChange={(v) => patch({ transport: v as McpTransport })}
                options={(['stdio', 'http', 'sse'] as McpTransport[]).map((t) => ({
                  label: MCP_TRANSPORT_LABELS[t],
                  value: t
                }))}
              />
              <p className="text-xs leading-4 text-muted-foreground">
                {MCP_TRANSPORT_HINTS[editing.transport]}
              </p>
            </div>
            {editing.transport === 'stdio' ? (
              <>
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">启动命令</span>
                  <Input
                    placeholder="如：npx 或 node 或 D:\tools\server.exe"
                    value={editing.command}
                    onChange={(e) => patch({ command: e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">参数（空格分隔）</span>
                  <Input
                    placeholder="如：-y @modelcontextprotocol/server-filesystem D:\data"
                    value={editing.args}
                    onChange={(e) => patch({ args: e.target.value })}
                  />
                </div>
                {renderKvEditor('env', {
                  addBase: 'NEW_VAR',
                  emptyHint: (
                    <>
                      环境变量
                      <span className="ml-1 font-normal text-muted-foreground">
                        （GUI 进程不继承 shell 变量，需在此注入 API Key 等）
                      </span>
                    </>
                  ),
                  keyPlaceholder: 'KEY'
                })}
              </>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">服务地址</span>
                  <Input
                    placeholder={
                      editing.transport === 'http'
                        ? '如：https://example.com/mcp'
                        : '如：https://example.com/sse'
                    }
                    value={editing.url}
                    onChange={(e) => patch({ url: e.target.value })}
                  />
                </div>
                {renderKvEditor('headers', {
                  addBase: 'X-Custom-Header',
                  emptyHint: (
                    <>
                      请求头
                      <span className="ml-1 font-normal text-muted-foreground">
                        （鉴权用，如 Authorization = Bearer xxx）
                      </span>
                    </>
                  ),
                  keyPlaceholder: 'Header'
                })}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
