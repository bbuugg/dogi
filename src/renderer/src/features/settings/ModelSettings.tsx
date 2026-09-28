import { useState } from 'react'
import { CloudDownload, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { AiApiStyle, AiModelConfig, AiProviderKind } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { Button, Input, Modal, Popconfirm, Select, Tag } from 'antd'

const KIND_LABELS: Record<AiProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  google: 'Google',
  'openai-compatible': 'OpenAI 兼容接口'
}

const MODEL_HINTS: Record<AiProviderKind, string> = {
  openai: '如 gpt-5.1',
  anthropic: '如 claude-sonnet-4-5',
  deepseek: '如 deepseek-chat / deepseek-reasoner',
  google: '如 gemini-2.5-pro',
  'openai-compatible': '填写服务端模型 ID，如 qwen3-coder'
}

/** 各 kind 的接口风格默认值 */
const API_STYLE_DEFAULT: Partial<Record<AiProviderKind, AiApiStyle>> = {
  openai: 'responses',
  'openai-compatible': 'chat-completions'
}

const API_STYLE_LABELS: Record<AiApiStyle, string> = {
  'chat-completions': 'Chat Completions（/chat/completions）',
  responses: 'Responses（/responses，OpenAI 新接口）'
}

/** 是否提供接口风格选择 / 远程模型拉取（OpenAI 系服务商） */
function hasApiStyleChoice(kind: AiProviderKind): boolean {
  return kind === 'openai' || kind === 'openai-compatible'
}

interface FormState {
  id: string
  name: string
  kind: AiProviderKind
  apiKey: string
  baseURL: string
  /** 模型 id 列表（≥1 个）：手动输入与远程拉取都在这一个选择器里增删 */
  models: string[]
  /** 'default' = 跟随 kind 默认 */
  apiStyle: AiApiStyle | 'default'
  temperature: string
  maxTokens: string
  contextMessages: string
}

const EMPTY: FormState = {
  id: '',
  name: '',
  kind: 'openai',
  apiKey: '',
  baseURL: '',
  models: [],
  apiStyle: 'default',
  temperature: '',
  maxTokens: '',
  contextMessages: '20'
}

function toForm(config: AiModelConfig | null): FormState {
  if (!config) return { ...EMPTY }
  return {
    id: config.id,
    name: config.name,
    kind: config.kind,
    apiKey: '',
    baseURL: config.baseURL ?? '',
    models: config.models?.length ? config.models : config.model ? [config.model] : [],
    apiStyle: config.apiStyle ?? 'default',
    temperature: config.temperature !== undefined ? String(config.temperature) : '',
    maxTokens: config.maxTokens !== undefined ? String(config.maxTokens) : '',
    contextMessages: String(config.contextMessages ?? 20)
  }
}

export function ModelSettings() {
  const aiConfigs = useAppStore((s) => s.aiConfigs)
  const activeConfigId = useAppStore((s) => s.aiSettings.activeConfigId)
  const refreshAiConfigs = useAppStore((s) => s.refreshAiConfigs)
  const refreshAiSettings = useAppStore((s) => s.refreshAiSettings)

  const [editing, setEditing] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  /** 远程拉取到的模型 id 列表；null = 尚未拉取 */
  const [remoteModels, setRemoteModels] = useState<string[] | null>(null)
  /** 列表行「拉取模型」弹窗状态 */
  const [picker, setPicker] = useState<{
    config: AiModelConfig
    remote: string[] | null
    selected: string[]
    loading: boolean
    error: string | null
  } | null>(null)

  const patch = (partial: Partial<FormState>) =>
    setEditing((f) => (f ? { ...f, ...partial } : f))

  const openCreate = () => {
    setError(null)
    setRemoteModels(null)
    setEditing({ ...EMPTY })
  }
  const openEdit = (config: AiModelConfig) => {
    setError(null)
    setRemoteModels(null)
    setEditing(toForm(config))
  }
  const closeModal = () => {
    if (saving) return
    setEditing(null)
    setError(null)
    setRemoteModels(null)
  }

  /** 拉取 {baseURL}/models 的模型列表（OpenAI 兼容接口）。编辑已有配置时带 configId：
   *  表单里的 apiKey 出于脱敏不回显（是空串），主进程按 configId 取存储的解密 key。 */
  const handleFetchRemote = async () => {
    if (!editing) return
    const baseURL =
      editing.baseURL.trim() || (editing.kind === 'openai' ? 'https://api.openai.com/v1' : '')
    if (!baseURL) {
      setError('请先填写 Base URL（需包含 /v1，如 https://api.xxx.com/v1），再拉取远程模型')
      return
    }
    setFetching(true)
    setError(null)
    try {
      const models = await window.api.ai.listRemoteModels({
        baseURL,
        apiKey: editing.apiKey || undefined,
        configId: editing.id || undefined
      })
      setRemoteModels(models)
      if (!models.length) setError('该接口未返回任何模型')
    } catch (err) {
      setError(`拉取失败：${err instanceof Error ? err.message : String(err)}`)
      setRemoteModels([])
    } finally {
      setFetching(false)
    }
  }

  const handleSave = async () => {
    if (!editing) return
    const models = editing.models.map((m) => m.trim()).filter(Boolean)
    if (!editing.name.trim()) {
      setError('请填写配置名称')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await window.api.ai.saveConfig({
        id: editing.id,
        name: editing.name.trim(),
        kind: editing.kind,
        apiKey: editing.apiKey === '' ? undefined : editing.apiKey,
        baseURL: editing.baseURL.trim() || undefined,
        model: models[0],
        models,
        apiStyle: editing.apiStyle === 'default' ? undefined : editing.apiStyle,
        temperature: editing.temperature ? Number(editing.temperature) : undefined,
        maxTokens: editing.maxTokens ? Number(editing.maxTokens) : undefined,
        contextMessages: Number(editing.contextMessages) || 20,
        createdAt: 0,
        updatedAt: 0
      })
      await refreshAiConfigs()
      // 首次保存会自动激活新配置，同步回渲染端
      await refreshAiSettings()
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (config: AiModelConfig) => {
    await window.api.ai.deleteConfig(config.id)
    await refreshAiConfigs()
    // 主进程已重选激活项（或删除最后一项后置空），同步回渲染端，
    // 否则 activeConfigId 悬空会让 AI 面板无法切换模型
    await refreshAiSettings()
  }

  /** 从列表直接移除某配置里的单个模型（二次确认在 UI 的 Popconfirm 里） */
  const removeModel = async (config: AiModelConfig, model: string) => {
    const source = config.models?.length ? config.models : config.model ? [config.model] : []
    const rest = source.filter((m) => m !== model)
    await window.api.ai.saveConfig({
      ...config,
      apiKey: undefined,
      models: rest,
      // 删空后把遗留的 model 字段一并清空，否则它会被列表当作仍有模型而重新显示
      model: rest[0] ?? undefined
    })
    await refreshAiConfigs()
  }

  /** 列表行「拉取模型」：打开弹窗并按该配置拉取远程模型 */
  const openPicker = async (config: AiModelConfig) => {
    const baseURL =
      config.baseURL?.trim() || (config.kind === 'openai' ? 'https://api.openai.com/v1' : '')
    const initial = config.models?.length ? config.models : config.model ? [config.model] : []
    setPicker({ config, remote: null, selected: [...initial], loading: false, error: null })
    if (!baseURL) {
      setPicker((p) => (p ? { ...p, error: '该配置未填写 Base URL，无法拉取远程模型' } : p))
      return
    }
    if (!hasApiStyleChoice(config.kind)) {
      setPicker((p) =>
        p
          ? {
              ...p,
              error: '远程拉取仅支持 OpenAI 兼容接口（OpenAI / OpenAI 兼容），其余服务商请手动输入模型 ID。'
            }
          : p
      )
      return
    }
    setPicker((p) => (p ? { ...p, loading: true, error: null } : p))
    try {
      const models = await window.api.ai.listRemoteModels({ baseURL, configId: config.id })
      setPicker((p) => (p ? { ...p, remote: models, loading: false } : p))
    } catch (err) {
      setPicker((p) =>
        p
          ? {
              ...p,
              remote: [],
              loading: false,
              error: `拉取失败：${err instanceof Error ? err.message : String(err)}`
            }
          : p
      )
    }
  }

  const togglePickerModel = (m: string, checked: boolean) =>
    setPicker((p) => {
      if (!p) return p
      const selected = checked ? [...p.selected, m] : p.selected.filter((x) => x !== m)
      return { ...p, selected }
    })

  const confirmPicker = async () => {
    if (!picker) return
    const merged = Array.from(new Set([...(picker.config.models ?? []), ...picker.selected]))
    await window.api.ai.saveConfig({
      ...picker.config,
      apiKey: undefined,
      models: merged,
      model: merged[0] ?? picker.config.model
    })
    await refreshAiConfigs()
    setPicker(null)
  }

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            可添加多套模型配置，随时在 AI 面板顶部切换。
          </p>
          <Button type="text" icon={<Plus className="size-4" />} size="small" variant="filled" onClick={openCreate}>
            新建配置
          </Button>
        </div>
        {aiConfigs.length === 0 && (
          <p className="rounded-md py-8 text-center text-xs text-muted-foreground">
            还没有模型配置，点击「新建配置」添加
          </p>
        )}
        {aiConfigs.map((config) => (
          <div
            key={config.id}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium">{config.name}</span>
                {config.id === activeConfigId && (
                  <Tag color="default" className="m-0 h-4 border-0 bg-secondary px-1.5 text-[9px] leading-4">
                    默认
                  </Tag>
                )}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {KIND_LABELS[config.kind]}
                {hasApiStyleChoice(config.kind)
                  ? ` · ${API_STYLE_LABELS[config.apiStyle ?? API_STYLE_DEFAULT[config.kind] ?? 'responses'].split('（')[0]}`
                  : ''}
                {config.baseURL ? ` · ${config.baseURL}` : ''}
                {config.hasApiKey ? '' : ' · 未配置 Key'}
              </div>
              {(config.models?.length ? config.models! : config.model ? [config.model] : [])
                .filter(Boolean)
                .length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {(config.models?.length ? config.models! : [config.model!])
                    .filter(Boolean)
                    .map((m) => (
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
            </div>
            <Button
              icon={<Pencil className="size-3.5" />}
              size="small"
              type="text"
              className="w-7 p-0"
              title="编辑"
              onClick={() => openEdit(config)}
            />
            <Button
              icon={<CloudDownload className="size-3.5" />}
              size="small"
              type="text"
              className="w-7 p-0"
              title="拉取模型"
              onClick={() => void openPicker(config)}
            />
            <Popconfirm
              title="删除模型配置"
              description={`确定删除模型配置「${config.name}」吗？`}
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
      </div>

      <Modal
        title={editing?.id ? '编辑模型配置' : '新建模型配置'}
        open={editing !== null}
        onCancel={closeModal}
        onOk={() => void handleSave()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={560}
        destroyOnHidden
        centered
      >
        {editing && (
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">配置名称</span>
                <Input
                  placeholder="如：DeepSeek 生产 Key"
                  value={editing.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">服务商</span>
                <Select
                  value={editing.kind}
                  onChange={(v) => patch({ kind: v as AiProviderKind })}
                  style={{ width: '100%' }}
                  options={(Object.keys(KIND_LABELS) as AiProviderKind[]).map((k) => ({
                    value: k,
                    label: KIND_LABELS[k]
                  }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">API Key</span>
                <Input
                  type="password"
                  placeholder={editing.id ? '已保存（留空保持不变）' : 'sk-...'}
                  value={editing.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Base URL（可选）</span>
                <Input
                  placeholder="https://api.example.com/v1"
                  value={editing.baseURL}
                  onChange={(e) => patch({ baseURL: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">模型 ID（可多个）</span>
                {hasApiStyleChoice(editing.kind) && (
                  <Button
                    type="link"
                    size="small"
                    className="h-6 px-1 text-xs"
                    icon={<CloudDownload className="size-3.5" />}
                    loading={fetching}
                    onClick={() => void handleFetchRemote()}
                  >
                    拉取远程模型
                  </Button>
                )}
              </div>
              {/* tags 模式：手动输入、从拉取结果多选添加、tag 上删除都在这一个组件里完成 */}
              <Select
                mode="tags"
                placeholder={MODEL_HINTS[editing.kind]}
                value={editing.models}
                tokenSeparators={[',', ' ']}
                options={(remoteModels ?? []).map((m) => ({ value: m, label: m }))}
                notFoundContent={remoteModels === null ? null : '无匹配模型'}
                style={{ width: '100%' }}
                onChange={(v: string[]) => {
                  const isCreate = !editing?.id
                  const autoName = isCreate && !editing?.name.trim() && v.length > 0
                  patch({ models: v, ...(autoName ? { name: v[0] } : {}) })
                }}
              />
              <p className="text-[10px] text-muted-foreground">
                可添加多个模型：输入后回车，或拉取后从列表勾选；第一个为该配置的默认模型。
              </p>
              {!hasApiStyleChoice(editing.kind) && (
                <p className="text-[10px] text-muted-foreground">
                  从远程拉取仅支持 OpenAI 兼容接口（/v1/models），其余服务商请手动输入模型 ID。
                </p>
              )}
            </div>
            {hasApiStyleChoice(editing.kind) && (
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">接口风格</span>
                <Select
                  value={editing.apiStyle}
                  onChange={(v) => patch({ apiStyle: v as AiApiStyle | 'default' })}
                  style={{ width: '100%' }}
                  options={[
                    {
                      value: 'default',
                      label: `默认（${API_STYLE_LABELS[API_STYLE_DEFAULT[editing.kind] ?? 'responses']}）`
                    },
                    { value: 'chat-completions', label: API_STYLE_LABELS['chat-completions'] },
                    { value: 'responses', label: API_STYLE_LABELS['responses'] }
                  ]}
                />
                <p className="text-[10px] text-muted-foreground">
                  第三方兼容接口（Ollama / vLLM / 中转网关）若调用 /responses 报 404，请选 Chat Completions。
                </p>
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Temperature</span>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  placeholder="默认"
                  value={editing.temperature}
                  onChange={(e) => patch({ temperature: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">最大输出 Tokens</span>
                <Input
                  type="number"
                  placeholder="默认"
                  value={editing.maxTokens}
                  onChange={(e) => patch({ maxTokens: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">历史消息条数</span>
                <Input
                  type="number"
                  value={editing.contextMessages}
                  onChange={(e) => patch({ contextMessages: e.target.value })}
                />
              </div>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}
      </Modal>

      <Modal
        title={picker ? `拉取模型 · ${picker.config.name}` : '拉取模型'}
        open={picker !== null}
        onCancel={() => setPicker(null)}
        onOk={() => void confirmPicker()}
        okText="添加到配置"
        cancelText="取消"
        okButtonProps={{
          disabled: !!picker?.loading || !picker?.remote || (picker?.remote.length ?? 0) === 0
        }}
        width={480}
        destroyOnHidden
        centered
      >
        {picker && (
          <div className="space-y-3 pt-1">
            {picker.loading && <p className="text-xs text-muted-foreground">正在拉取模型列表…</p>}
            {picker.error && <p className="text-xs text-destructive">{picker.error}</p>}
            {picker.remote && picker.remote.length === 0 && !picker.loading && !picker.error && (
              <p className="text-xs text-muted-foreground">该接口未返回任何模型</p>
            )}
            {picker.remote && picker.remote.length > 0 && (
              <div className="max-h-80 space-y-1.5 overflow-auto">
                {picker.remote.map((m) => {
                  const checked = picker.selected.includes(m)
                  return (
                    <label
                      key={m}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => togglePickerModel(m, e.target.checked)}
                      />
                      <span className="font-mono">{m}</span>
                    </label>
                  )
                })}
              </div>
            )}
            {picker.selected.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                已选 {picker.selected.length} 个，确认后将追加到「{picker.config.name}」（已存在的不会重复）。
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
