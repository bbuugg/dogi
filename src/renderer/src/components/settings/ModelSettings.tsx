import { useState } from 'react'
import { Pencil, Plus, Star, Trash2 } from 'lucide-react'
import type { AiApiStyle, AiModelConfig, AiProviderKind } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

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

/** 是否提供接口风格选择（OpenAI 系服务商） */
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
  /** 'default' = 跟随 kind 默认（Radix Select 不支持空 value） */
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
  const setActiveAiConfig = useAppStore((s) => s.setActiveAiConfig)

  const [editing, setEditing] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patch = (partial: Partial<FormState>) =>
    setEditing((f) => (f ? { ...f, ...partial } : f))

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
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (config: AiModelConfig) => {
    if (!window.confirm(`确定删除模型配置「${config.name}」吗？`)) return
    await window.api.ai.deleteConfig(config.id)
    await refreshAiConfigs()
  }

  // ---------- 编辑表单 ----------
  if (editing) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label>配置名称</Label>
            <Input
              placeholder="如：DeepSeek 生产 Key"
              value={editing.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>服务商</Label>
            <Select
              value={editing.kind}
              onValueChange={(v) => patch({ kind: v as AiProviderKind })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABELS) as AiProviderKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label>API Key</Label>
            <Input
              type="password"
              placeholder={editing.id ? '已保存（留空保持不变）' : 'sk-...'}
              value={editing.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Base URL（可选）</Label>
            <Input
              placeholder="https://api.example.com/v1"
              value={editing.baseURL}
              onChange={(e) => patch({ baseURL: e.target.value })}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label>模型 ID</Label>
          <Input
            placeholder={MODEL_HINTS[editing.kind]}
            value={editing.model}
            onChange={(e) => patch({ model: e.target.value })}
          />
        </div>
        {hasApiStyleChoice(editing.kind) && (
          <div className="grid gap-1.5">
            <Label>接口风格</Label>
            <Select
              value={editing.apiStyle}
              onValueChange={(v) => patch({ apiStyle: v as AiApiStyle | 'default' })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  默认（{API_STYLE_LABELS[API_STYLE_DEFAULT[editing.kind] ?? 'responses']}）
                </SelectItem>
                <SelectItem value="chat-completions">
                  {API_STYLE_LABELS['chat-completions']}
                </SelectItem>
                <SelectItem value="responses">{API_STYLE_LABELS['responses']}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              第三方兼容接口（Ollama / vLLM / 中转网关）若调用 /responses 报 404，请选 Chat Completions。
            </p>
          </div>
        )}
        <div className="grid grid-cols-3 gap-3">
          <div className="grid gap-1.5">
            <Label>Temperature</Label>
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
            <Label>最大输出 Tokens</Label>
            <Input
              type="number"
              placeholder="默认"
              value={editing.maxTokens}
              onChange={(e) => patch({ maxTokens: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>历史消息条数</Label>
            <Input
              type="number"
              value={editing.contextMessages}
              onChange={(e) => patch({ contextMessages: e.target.value })}
            />
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditing(null)}>
            取消
          </Button>
          <Button disabled={saving} onClick={() => void handleSave()}>
            保存
          </Button>
        </div>
      </div>
    )
  }

  // ---------- 列表 ----------
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          可添加多套模型配置，随时在 AI 面板顶部切换。
        </p>
        <Button size="sm" variant="secondary" onClick={() => setEditing({ ...EMPTY })}>
          <Plus className="size-4" /> 新建配置
        </Button>
      </div>
      {aiConfigs.length === 0 && (
        <p className="rounded-md border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
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
                <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">
                  使用中
                </Badge>
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
              size="icon"
              variant="ghost"
              className="size-7"
              title="设为当前使用"
              onClick={() => void setActiveAiConfig(config.id)}
            >
              <Star className="size-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="编辑"
            onClick={() => setEditing(toForm(config))}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="删除"
            onClick={() => void handleDelete(config)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  )
}
