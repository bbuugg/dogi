import { useState } from 'react'
import { CloudDownload, Pencil, Plus, ScanSearch, Star, Trash2 } from 'lucide-react'
import type { AcpAgentConfig, DetectedAcpAgent } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { Button, Input, Modal, Popconfirm, Select, Tag, message } from 'antd'

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
  /** 正在向哪个 agent 拉取模型（id） */
  const [fetchingModels, setFetchingModels] = useState<string | null>(null)
  /** 拉取结果弹窗：agent 配置 + agent 上报的模型列表 + 当前勾选 */
  const [modelPickup, setModelPickup] = useState<{
    config: AcpAgentConfig
    models: Array<{ value: string; name: string }>
  } | null>(null)
  const [pickedModels, setPickedModels] = useState<string[]>([])

  /** 向 agent 询问可用模型（主进程临时建连 initialize + session/new 读取） */
  const handleFetchModels = async (config: AcpAgentConfig) => {
    setFetchingModels(config.id)
    try {
      const result = await window.api.ai.acpListModels(config.id)
      if (!result || result.models.length === 0) {
        message.info('该 agent 未上报可用模型（需支持 ACP configOptions 协议）')
        return
      }
      // 已保存的模型若仍在上报列表里则预勾选，已被 agent 移除的自动剔除
      const valid = config.models?.filter((m) => result.models.some((x) => x.value === m)) ?? []
      setPickedModels(valid)
      setModelPickup({ config, models: result.models })
    } catch (err) {
      message.error('拉取失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setFetchingModels(null)
    }
  }

  /** 确认勾选：写回该 agent 的 models 列表 */
  const confirmPickModels = async () => {
    const pickup = modelPickup
    if (!pickup) return
    const next = acpAgents.map((a) =>
      a.id === pickup.config.id ? { ...a, models: pickedModels } : a
    )
    await commit(next)
    setModelPickup(null)
  }

  /** 删除某个已选模型（tag 上的关闭按钮） */
  const removeModel = async (config: AcpAgentConfig, model: string) => {
    const next = acpAgents.map((a) =>
      a.id === config.id ? { ...a, models: (a.models ?? []).filter((m) => m !== model) } : a
    )
    await commit(next)
  }

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
          <p className="mb-1.5 text-xs font-medium text-foreground">
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
            {(config.models?.length ?? 0) > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {config.models!.map((m) => (
                  <Tag
                    key={m}
                    className="m-0 font-mono text-[10px]"
                    closable
                    onClose={(e) => {
                      e.preventDefault()
                      void removeModel(config, m)
                    }}
                  >
                    {m}
                  </Tag>
                ))}
              </div>
            )}
          </div>
          <Button
            icon={<CloudDownload className="size-3.5" />}
            size="small"
            type="text"
            loading={fetchingModels === config.id}
            className="w-7 p-0"
            title="向该 agent 询问可用模型"
            onClick={() => void handleFetchModels(config)}
          />
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
          <Popconfirm
            title="删除 ACP agent 配置"
            description={`确定删除 ACP agent 配置「${config.name}」吗？`}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(config)}
          >
            <Button
              icon={<Trash2 className="size-3.5" />}
              size="small"
              type="text"
              className="w-7 p-0"
              title="删除"
            />
          </Popconfirm>
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

      {/* 拉取到的模型列表：多选勾选（=添加），取消勾选（=删除），确定后写回配置 */}
      <Modal
        title={`「${modelPickup?.config.name ?? ''}」的可用模型`}
        open={modelPickup !== null}
        onCancel={() => setModelPickup(null)}
        onOk={() => void confirmPickModels()}
        okText="保存"
        cancelText="取消"
        width={480}
        destroyOnHidden
        centered
      >
        <Select
          mode="multiple"
          showSearch
          placeholder="选择要添加的模型（取消勾选即删除）"
          value={pickedModels}
          onChange={setPickedModels}
          options={(modelPickup?.models ?? []).map((m) => ({
            value: m.value,
            label: `${m.name}${m.name !== m.value ? `（${m.value}）` : ''}`
          }))}
          style={{ width: '100%' }}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          这些模型会出现在 AI Agent 的模型下拉里；不选任何模型则使用 agent 自己的当前模型。
        </p>
      </Modal>
    </div>
  )
}
