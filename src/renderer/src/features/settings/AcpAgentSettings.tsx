import { useAppStore } from '@/stores/app-store'
import type { AcpAgentConfig, DetectedAcpAgent } from '@shared/types'
import { Button, Input, Modal, Popconfirm, Select, Tag, message } from 'antd'
import { CloudDownload, Pencil, Plus, ScanSearch, Trash2, X } from 'lucide-react'
import { useState } from 'react'

interface FormState {
  id: string
  name: string
  command: string
  args: string
  env: Record<string, string>
  models: string[]
}

const EMPTY: FormState = { id: '', name: '', command: '', args: '', env: {}, models: [] }

function toForm(config: AcpAgentConfig | null): FormState {
  if (!config) return { ...EMPTY }
  return {
    id: config.id,
    name: config.name,
    command: config.command,
    args: config.args.join(' '),
    env: config.env ? { ...config.env } : {},
    models: config.models ? [...config.models] : []
  }
}

/**
 * 设置页：ACP agent 配置（列表 / 新建 / 编辑 / 删除 / 检测本地已安装 / 拉取并勾选模型）。
 *
 * 这里是 **ACP agent 的模型来源**：会话页的模型下拉只列各 agent 在这里勾选的模型
 * （见 4.18）。检测与「导入会话」在 AI Agent 侧边栏的导入弹窗里也有一份入口，
 * 两边写的是同一张 `aiSettings.acpAgents`。
 */
export function AcpAgentSettings() {
  const aiSettings = useAppStore((s) => s.aiSettings)
  const saveAiSettings = useAppStore((s) => s.saveAiSettings)
  const acpAgents = aiSettings.acpAgents ?? []

  const [editing, setEditing] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detected, setDetected] = useState<DetectedAcpAgent[] | null>(null)
  const [detectOpen, setDetectOpen] = useState(false)
  /** 正在向哪个 agent 拉取模型（id） */
  const [fetchingModels, setFetchingModels] = useState<string | null>(null)
  /** 拉取结果弹窗：agent 配置 + agent 上报的模型列表 + 当前勾选 */
  const [modelPickup, setModelPickup] = useState<{
    config: AcpAgentConfig
    models: Array<{ value: string; name: string }>
    /** 传入时（编辑弹窗内）勾选结果回写表单，否则直接落库 */
    onPicked?: (picked: string[]) => void
  } | null>(null)
  const [pickedModels, setPickedModels] = useState<string[]>([])

  /** 向 agent 询问可用模型（主进程临时建连 initialize + session/new 读取）
   *  onPicked：传入时（编辑弹窗内）勾选结果回写表单而非直接落库 */
  const handleFetchModels = async (
    config: AcpAgentConfig,
    onPicked?: (picked: string[]) => void
  ) => {
    setFetchingModels(config.id)
    try {
      const result = await window.api.agent.acp.listModels(config.id)
      if (!result || result.models.length === 0) {
        message.info('该 agent 未上报可用模型（需支持 ACP configOptions 协议）')
        return
      }
      // 仍在上报列表里的已保存项预勾选；agent 未上报的「自定义模型」在确认时保留
      const valid = config.models?.filter((m) => result.models.some((x) => x.value === m)) ?? []
      setPickedModels(valid)
      setModelPickup({ config, models: result.models, onPicked })
    } catch (err) {
      message.error('拉取失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setFetchingModels(null)
    }
  }

  /** 确认勾选：合并「自定义模型（agent 未上报的）」与本次勾选项 */
  const confirmPickModels = async () => {
    const pickup = modelPickup
    if (!pickup) return
    const agentValues = new Set(pickup.models.map((m) => m.value))
    const custom = (pickup.config.models ?? []).filter((m) => !agentValues.has(m))
    const merged = Array.from(new Set([...custom, ...pickedModels]))
    if (pickup.onPicked) {
      pickup.onPicked(merged)
    } else {
      const next = acpAgents.map((a) =>
        a.id === pickup.config.id ? { ...a, models: merged } : a
      )
      await commit(next)
    }
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

  /** 环境变量键值对编辑（允许同名键后改名，避免丢失） */
  const setEnvKey = (oldKey: string, newKey: string) =>
    setEditing((f) => {
      if (!f) return f
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(f.env)) next[k === oldKey ? newKey : k] = v
      return { ...f, env: next }
    })
  const setEnvValue = (key: string, value: string) =>
    setEditing((f) => (f ? { ...f, env: { ...f.env, [key]: value } } : f))
  const removeEnv = (key: string) =>
    setEditing((f) => {
      if (!f) return f
      const next = { ...f.env }
      delete next[key]
      return { ...f, env: next }
    })
  const addEnv = () =>
    setEditing((f) => {
      if (!f) return f
      let key = 'NEW_VAR'
      let i = 1
      while (key in f.env) key = `NEW_VAR_${i++}`
      return { ...f, env: { ...f.env, [key]: '' } }
    })

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

  /**
   * 保存配置列表。
   *
   * 注意**没有**「默认 ACP agent」这回事（旧字段 activeAcpId 已移除）：ACP 会话在创建 /
   * 导入时就把 agent 绑死了，之后不可切换，所以这里只管登记表本身。
   */
  const commit = async (next: AcpAgentConfig[]) => {
    await saveAiSettings({ acpAgents: next })
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
        args: editing.args.trim() ? editing.args.trim().split(/\s+/) : [],
        // 丢弃空 key 的行，避免把 `=value` 这种脏数据写进配置
        env:
          Object.keys(editing.env).length > 0
            ? Object.fromEntries(
              Object.entries(editing.env).filter(([k]) => k.trim().length > 0)
            )
            : undefined,
        // 自定义模型 + 从 agent 拉取的模型都在这里；留空则使用 agent 自己的当前模型
        models: editing.models.map((m) => m.trim()).filter(Boolean)
      }
      const exists = acpAgents.some((a) => a.id === config.id)
      const next = exists
        ? acpAgents.map((a) => (a.id === config.id ? config : a))
        : [...acpAgents, config]
      await commit(next)
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
    await commit([...acpAgents, config])
  }

  const runDetect = async () => {
    setDetecting(true)
    try {
      setDetected(await window.api.agent.acp.detect())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDetected([])
    } finally {
      setDetecting(false)
      setDetectOpen(true)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          外部 ACP agent 启动配置；勾选的模型会出现在 AI Agent 的模型下拉里
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
            </div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {config.command}
              {config.args.length ? ` ${config.args.join(' ')}` : ''}
            </div>
            {(config.models?.length ?? 0) > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {config.models!.map((m) => (
                  <Popconfirm
                    key={m}
                    title="移除模型"
                    description={`确定从「${config.name}」移除模型「${m}」吗？`}
                    okText="移除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void removeModel(config, m)}
                  >
                    <Tag className="m-0 cursor-pointer font-mono text-[10px]">
                      {m}
                      <X className="ml-0.5 inline-block size-2.5 align-middle" />
                    </Tag>
                  </Popconfirm>
                ))}
              </div>
            )}
            {config.env && Object.keys(config.env).length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                <span>环境变量：</span>
                {Object.keys(config.env).map((k) => (
                  <code key={k} className="rounded bg-muted px-1 font-mono">
                    {k}
                  </code>
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
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">
                  环境变量
                  <span className="ml-1 font-normal text-muted-foreground">
                    （GUI 进程不继承 shell 变量，Claude Code 等需在此填 ANTHROPIC_API_KEY 等）
                  </span>
                </span>
                <Button
                  size="small"
                  type="text"
                  icon={<Plus className="size-3.5" />}
                  onClick={addEnv}
                >
                  添加
                </Button>
              </div>
              {Object.keys(editing.env).length === 0 ? (
                <p className="text-[10px] leading-4 text-muted-foreground">
                  暂无，点「添加」注入如 <code className="font-mono">ANTHROPIC_API_KEY</code> /
                  <code className="font-mono">ANTHROPIC_MODEL</code>。留空的行保存时会忽略。
                </p>
              ) : (
                <div className="space-y-1.5">
                  {Object.entries(editing.env).map(([key, value], index) => (
                    <div key={index} className="flex items-center gap-1.5">
                      <Input
                        className="min-w-0 flex-1 font-mono"
                        placeholder="KEY"
                        value={key}
                        onChange={(e) => setEnvKey(key, e.target.value)}
                      />
                      <span className="shrink-0 font-mono text-muted-foreground">=</span>
                      <Input
                        className="min-w-0 flex-1 font-mono"
                        placeholder="VALUE"
                        value={value}
                        onChange={(e) => setEnvValue(key, e.target.value)}
                      />
                      <Button
                        size="small"
                        type="text"
                        icon={<Trash2 className="size-3.5" />}
                        className="w-7 shrink-0 p-0"
                        onClick={() => removeEnv(key)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">
                  模型 ID（可自定义）
                  <span className="ml-1 font-normal text-muted-foreground">
                    （也可点「拉取」从 agent 获取后勾选；留空则使用 agent 自己的当前模型）
                  </span>
                </span>
                <Button
                  size="small"
                  type="text"
                  icon={<CloudDownload className="size-3.5" />}
                  loading={fetchingModels === editing.id}
                  disabled={!editing.id}
                  onClick={() =>
                    editing.id &&
                    void handleFetchModels(
                      { id: editing.id, models: editing.models } as AcpAgentConfig,
                      (picked) => patch({ models: picked })
                    )
                  }
                >
                  拉取
                </Button>
              </div>
              <Select
                mode="tags"
                placeholder="如 claude-sonnet-4-5"
                value={editing.models}
                tokenSeparators={[',', ' ']}
                style={{ width: '100%' }}
                onChange={(v: string[]) => patch({ models: v })}
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
          勾选的模型会出现在 AI Agent 的模型下拉里；agent 未上报的自定义模型不会被覆盖。不选任何模型则使用 agent 自己的当前模型。
        </p>
      </Modal>

      {/* 检测已安装：用 modal 弹出结果列表，逐条添加为预置配置 */}
      <Modal
        title="检测到的 ACP agent"
        open={detectOpen}
        onCancel={() => setDetectOpen(false)}
        footer={
          <Button type="primary" onClick={() => setDetectOpen(false)}>
            完成
          </Button>
        }
        width={480}
        destroyOnHidden
        centered
      >
        {detected && detected.length > 0 ? (
          <div className="space-y-1.5">
            {detected.map((item) => (
              <div
                key={item.command}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
              >
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
                  className="w-14 shrink-0 p-0"
                  disabled={acpAgents.some((a) => a.command === item.command)}
                  icon={acpAgents.some((a) => a.command === item.command) || <Plus className='size-4' />}
                  onClick={() => void addDetected(item)}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-muted-foreground">
            未在 PATH 中检测到已知 ACP agent
          </p>
        )}
      </Modal>
    </div>
  )
}
