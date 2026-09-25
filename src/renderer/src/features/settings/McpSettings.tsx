import type { McpServerConfig } from '@shared/types'
import { Button, Input, Modal, Popconfirm, Switch, Tag } from 'antd'
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

interface McpStatus extends McpServerConfig {
  error?: string
}

interface FormState {
  id: string
  name: string
  command: string
  args: string
  env: string
  enabled: boolean
}

const EMPTY: FormState = { id: '', name: '', command: '', args: '', env: '', enabled: true }

function toForm(server: McpServerConfig | null): FormState {
  if (!server) return { ...EMPTY }
  return {
    id: server.id,
    name: server.name,
    command: server.command,
    args: (server.args ?? []).join(' '),
    env: Object.entries(server.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    enabled: server.enabled
  }
}

export function McpSettings() {
  const [servers, setServers] = useState<McpStatus[]>([])
  const [editing, setEditing] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [toolInfo, setToolInfo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => setServers(await window.api.mcp.list())
  useEffect(() => {
    void load()
  }, [])

  const patch = (partial: Partial<FormState>) =>
    setEditing((f) => (f ? { ...f, ...partial } : f))

  const openCreate = () => {
    setError(null)
    setEditing({ ...EMPTY })
  }
  const openEdit = (server: McpStatus) => {
    setError(null)
    setEditing(toForm(server))
  }
  const closeModal = () => {
    if (saving) return
    setEditing(null)
    setError(null)
  }

  const handleSave = async () => {
    if (!editing) return
    if (!editing.name.trim() || !editing.command.trim()) {
      setError('请填写名称与启动命令')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const env: Record<string, string> = {}
      for (const line of editing.env.split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
      await window.api.mcp.save({
        id: editing.id,
        name: editing.name.trim(),
        command: editing.command.trim(),
        args: editing.args.split(/\s+/).filter(Boolean),
        env,
        enabled: editing.enabled
      })
      setEditing(null)
      setError(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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

  const handleListTools = async () => {
    setToolInfo('正在连接 MCP 服务...')
    try {
      const { tools, errors } = await window.api.mcp.listTools()
      setToolInfo(
        errors.length
          ? `连接异常：\n${errors.join('\n')}`
          : tools.length
            ? `共 ${tools.length} 个工具：\n${tools.map((t) => `· ${t.name}（${t.serverName}）`).join('\n')}`
            : '已连接的 MCP 服务未提供工具'
      )
    } catch (err) {
      setToolInfo(`获取失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          MCP 工具将自动提供给 AI 使用（stdio 类型）
        </p>
        <div className="flex gap-2">
          <Button
            icon={<RefreshCw className="size-4" />}
            size="small" type="text" onClick={() => void handleListTools()}>
            检查工具
          </Button>
          <Button type="text" icon={<Plus className="size-4" />} size="small" variant="filled" onClick={openCreate}>
            新建
          </Button>
        </div>
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
              <span className="truncate text-xs font-medium">{server.name}</span>
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
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {server.command} {(server.args ?? []).join(' ')}
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
          >
            编辑
          </Button>
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
            >
              删除
            </Button>
          </Popconfirm>
        </div>
      ))}

      {toolInfo && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 p-2 font-mono text-[10px] text-muted-foreground">
          {toolInfo}
        </pre>
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
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">环境变量（每行 KEY=VALUE）</span>
              <Input.TextArea
                rows={3}
                className="font-mono text-xs"
                placeholder={'API_TOKEN=xxx\nDEBUG=1'}
                value={editing.env}
                onChange={(e) => patch({ env: e.target.value })}
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}
      </Modal>
    </div>
  )
}
