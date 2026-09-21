import { useState } from 'react'
import { Pencil, Plus, ScanSearch, Star, Trash2 } from 'lucide-react'
import type { AcpAgentConfig, DetectedAcpAgent } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { Button, Input, Modal } from 'antd'

interface FormState {
  id: string
  name: string
  command: string
  args: string
}

const EMPTY: FormState = { id: '', name: '', command: '', args: '' }

function toForm(config: AcpAgentConfig | null): FormState {
  if (!config) return { ...EMPTY }
  return { id: config.id, name: config.name, command: config.command, args: config.args.join(' ') }
}

/** 设置页：预定义 ACP agent 配置（列表 / 新建 / 编辑 / 删除 / 检测本地已安装） */
export function AcpAgentSettings() {
  const aiSettings = useAppStore((s) => s.aiSettings)
  const saveAiSettings = useAppStore((s) => s.saveAiSettings)
  const acpAgents = aiSettings.acpAgents ?? []
  const activeAcpId = aiSettings.activeAcpId

  const [editing, setEditing] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detected, setDetected] = useState<DetectedAcpAgent[] | null>(null)

  const patch = (partial: Partial<FormState>) =>
    setEditing((f) => (f ? { ...f, ...partial } : f))

  const openCreate = () => {
    setError(null)
    setEditing({ ...EMPTY })
  }
  const openEdit = (config: AcpAgentConfig) => {
    setError(null)
    setEditing(toForm(config))
  }
  const closeModal = () => {
    if (saving) return
    setEditing(null)
    setError(null)
  }

  /** 保存预设列表，必要时修正 activeAcpId 悬空 */
  const commit = async (next: AcpAgentConfig[], preferId?: string) => {
    const activeValid =
      preferId && next.some((a) => a.id === preferId)
        ? preferId
        : next.some((a) => a.id === activeAcpId)
          ? activeAcpId
          : next[0]?.id
    await saveAiSettings({ acpAgents: next, activeAcpId: activeValid })
  }

  const handleSave = async () => {
    if (!editing) return
    if (!editing.name.trim() || !editing.command.trim()) {
      setError('请填写配置名称与启动命令')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const config: AcpAgentConfig = {
        id: editing.id || crypto.randomUUID(),
        name: editing.name.trim(),
        command: editing.command.trim(),
        args: editing.args.trim() ? editing.args.trim().split(/\s+/) : []
      }
      const exists = acpAgents.some((a) => a.id === config.id)
      const next = exists
        ? acpAgents.map((a) => (a.id === config.id ? config : a))
        : [...acpAgents, config]
      await commit(next, config.id)
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (config: AcpAgentConfig) => {
    if (!window.confirm(`确定删除 ACP agent 配置「${config.name}」吗？`)) return
    await commit(acpAgents.filter((a) => a.id !== config.id))
  }

  const addDetected = async (item: DetectedAcpAgent) => {
    const config: AcpAgentConfig = {
      id: crypto.randomUUID(),
      name: item.name,
      command: item.command,
      args: item.args
    }
    await commit([...acpAgents, config], config.id)
  }

  const runDetect = async () => {
    setDetecting(true)
    try {
      setDetected(await window.api.ai.detectAcpAgents())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDetected([])
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          预定义外部 ACP agent 启动配置；工作区在 AI Agent 输入框的模型下拉处按会话选择使用。
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="text"
            icon={<ScanSearch className="size-4" />}
            size="small"
            variant="filled"
            loading={detecting}
            onClick={() => void runDetect()}
          >
            检测已安装
          </Button>
          <Button
            type="text"
            icon={<Plus className="size-4" />}
            size="small"
            variant="filled"
            onClick={openCreate}
          >
            新建配置
          </Button>
        </div>
      </div>

      {detected && (
        <div className="rounded-md border border-border/70 bg-secondary/40 px-3 py-2">
          <p className="mb-1.5 text-[11px] font-medium text-foreground">
            {detected.length > 0 ? '检测到以下 ACP agent（点击添加为预置配置）' : '未在 PATH 中检测到已知 ACP agent'}
          </p>
          {detected.map((item) => (
            <div key={item.command} className="flex items-center gap-2 py-1">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{item.name}</span>
                  <code className="shrink-0 rounded bg-muted px-1 font-mono text-[10px]">
                    {item.command}
                    {item.args.length ? ` ${item.args.join(' ')}` : ''}
                  </code>
                </div>
                <div className="truncate font-mono text-[10px] text-muted-foreground" title={item.path}>
                  {item.path}
                </div>
              </div>
              <Button
                size="small"
                type="text"
                className="w-14 p-0"
                disabled={acpAgents.some((a) => a.command === item.command)}
                onClick={() => void addDetected(item)}
              >
                {acpAgents.some((a) => a.command === item.command) ? '已添加' : '添加'}
              </Button>
            </div>
          ))}
        </div>
      )}

      {acpAgents.length === 0 && (
        <p className="rounded-md py-6 text-center text-xs text-muted-foreground">
          还没有 ACP agent 配置，点「检测已安装」自动发现，或「新建配置」手动添加
        </p>
      )}
      {acpAgents.map((config) => (
        <div
          key={config.id}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium">{config.name}</span>
              {config.id === activeAcpId && (
                <span className="shrink-0 rounded bg-secondary px-1.5 text-[9px] leading-4 text-muted-foreground">
                  使用中
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {config.command}
              {config.args.length ? ` ${config.args.join(' ')}` : ''}
            </div>
          </div>
          {config.id !== activeAcpId && (
            <Button
              icon={<Star className="size-3.5" />}
              size="small"
              type="text"
              className="w-7 p-0"
              title="设为当前使用"
              onClick={() => void saveAiSettings({ activeAcpId: config.id })}
            />
          )}
          <Button
            icon={<Pencil className="size-3.5" />}
            size="small"
            type="text"
            className="w-7 p-0"
            title="编辑"
            onClick={() => openEdit(config)}
          />
          <Button
            icon={<Trash2 className="size-3.5" />}
            size="small"
            type="text"
            className="w-7 p-0"
            title="删除"
            onClick={() => void handleDelete(config)}
          />
        </div>
      ))}

      <Modal
        title={editing?.id ? '编辑 ACP agent' : '新建 ACP agent'}
        open={editing !== null}
        onCancel={closeModal}
        onOk={() => void handleSave()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={520}
        destroyOnHidden
        centered
      >
        {editing && (
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">配置名称</span>
                <Input
                  placeholder="如：Codex CLI"
                  value={editing.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">启动命令</span>
                <Input
                  placeholder="如 codex-acp（Windows 下 npm 脚本写 codex-acp.cmd）"
                  value={editing.command}
                  onChange={(e) => patch({ command: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">启动参数（空格分隔）</span>
              <Input
                placeholder="如 --acp"
                value={editing.args}
                onChange={(e) => patch({ args: e.target.value })}
              />
            </div>
            <p className="text-[10px] leading-4 text-muted-foreground">
              agent 通过 stdio 与本应用通信，需已安装且可在 PATH 中调用；多轮对话上下文由 agent
              会话自行保留。
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}
      </Modal>
    </div>
  )
}
