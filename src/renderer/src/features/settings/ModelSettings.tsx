import { useState } from 'react'
import { CloudDownload, Pencil, Plus, Star, Trash2 } from 'lucide-react'
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
  model: string
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
  model: '',
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
    model: config.model,
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
  const setActiveAiConfig = useAppStore((s) => s.setActiveAiConfig)

  const [editing, setEditing] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  /** 远程拉取到的模型 id 列表；null = 尚未拉取 */
  const [remoteModels, setRemoteModels] = useState<string[] | null>(null)

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

  /** 拉取 {baseURL}/models 的模型列表（OpenAI 兼容接口） */
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
        apiKey: editing.apiKey || undefined
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
    if (!editing.name.trim() || !editing.model.trim()) {
      setError('请填写配置名称与模型 ID')
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
        model: editing.model.trim(),
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
                    使用中
                  </Tag>
                )}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {KIND_LABELS[config.kind]} · {config.model}
                {hasApiStyleChoice(config.kind)
                  ? ` · ${API_STYLE_LABELS[config.apiStyle ?? API_STYLE_DEFAULT[config.kind] ?? 'responses'].split('（')[0]}`
                  : ''}
                {config.baseURL ? ` · ${config.baseURL}` : ''}
                {config.hasApiKey ? '' : ' · 未配置 Key'}
              </div>
            </div>
            {config.id !== activeConfigId && (
              <Button
                icon={<Star className="size-3.5" />}
                size="small"
                type="text"
                className="w-7 p-0"
                title="设为当前使用"
                onClick={() => void setActiveAiConfig(config.id)}
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
                <span className="text-xs font-medium text-foreground">模型 ID</span>
                {hasApiStyleChoice(editing.kind) && (
                  <Button
                    type="link"
                    size="small"
                    className="h-6 px-1 text-[11px]"
                    icon={<CloudDownload className="size-3.5" />}
                    loading={fetching}
                    onClick={() => void handleFetchRemote()}
                  >
                    拉取远程模型
                  </Button>
                )}
              </div>
              <Input
                placeholder={MODEL_HINTS[editing.kind]}
                value={editing.model}
                onChange={(e) => patch({ model: e.target.value })}
              />
              {remoteModels !== null && (
                <Select
                  size="small"
                  showSearch
                  allowClear
                  placeholder={
                    remoteModels.length
                      ? '从远程模型列表选择（也可在上方手动输入）'
                      : '未获取到模型，请检查 Base URL 与 Key'
                  }
                  disabled={remoteModels.length === 0}
                  options={remoteModels.map((m) => ({ value: m, label: m }))}
                  notFoundContent="无匹配模型"
                  style={{ width: '100%' }}
                  onChange={(v: string) => {
                    const isCreate = !editing?.id
                    const autoName = isCreate && !editing?.name.trim()
                    patch({ model: v, ...(autoName ? { name: v } : {}) })
                  }}
                />
              )}
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
    </>
  )
}
