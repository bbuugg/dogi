import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { Input } from 'antd'
import { ModelSettings } from './ModelSettings'
import { McpSettings } from './McpSettings'
import { AcpAgentSettings } from './AcpAgentSettings'
import { SkillsSettings } from './SkillsSettings'

/** 系统提示词区块（从原「偏好」迁移而来） */
function SystemPromptSection() {
  const aiSettings = useAppStore((s) => s.aiSettings)
  const saveAiSettings = useAppStore((s) => s.saveAiSettings)
  const [systemPrompt, setSystemPrompt] = useState(aiSettings.systemPrompt ?? '')

  useEffect(() => {
    setSystemPrompt(aiSettings.systemPrompt ?? '')
  }, [aiSettings.systemPrompt])

  return (
    <section className="space-y-2">
      <div>
        <label htmlFor="system-prompt" className="text-xs font-medium text-foreground">
          系统提示词（留空使用默认）
        </label>
        <p className="mt-1 text-xs leading-4 text-muted-foreground">
          自定义 AI 助手的角色与约束，例如运维安全操作规范。
        </p>
      </div>
      <Input.TextArea
        id="system-prompt"
        rows={7}
        className="text-xs"
        placeholder="默认：运维助手角色设定，包含安全操作约束等。"
        value={systemPrompt}
        onChange={(e) => setSystemPrompt(e.target.value)}
        onBlur={() => void saveAiSettings({ systemPrompt: systemPrompt.trim() || undefined })}
      />
    </section>
  )
}

/**
 * AI 配置总入口：整合「模型配置」「ACP agent」「MCP 服务」「系统提示词」，
 * 在设置对话框中作为一个标签页呈现。
 * 工作区使用内置 AI SDK 还是外部 ACP agent，在 AI Agent 输入框的模型下拉处按会话切换。
 */
export function AiConfigSettings() {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <span className="text-sm font-medium text-foreground">模型配置</span>
          <p className="mt-1 text-xs leading-4 text-muted-foreground">
            可添加多套模型配置，在 AI 面板顶部切换当前使用。
          </p>
        </div>
        <ModelSettings />
      </section>

      <div className="h-px w-full bg-border" />

      <section className="space-y-3">
        <div>
          <span className="text-sm font-medium text-foreground">ACP agent</span>
          <p className="mt-1 text-xs leading-4 text-muted-foreground">
            预定义外部 ACP agent（如 Codex / Gemini CLI）的启动配置，工作区在 AI Agent
            输入框的模型下拉处按会话选择使用。
          </p>
        </div>
        <AcpAgentSettings />
      </section>

      <div className="h-px w-full bg-border" />

      <section className="space-y-3">
        <div>
          <span className="text-sm font-medium text-foreground">MCP 服务</span>
          <p className="mt-1 text-xs leading-4 text-muted-foreground">
            接入外部工具（stdio 类型），自动提供给 AI 使用。
          </p>
        </div>
        <McpSettings />
      </section>

      <div className="h-px w-full bg-border" />

      <SkillsSettings />

      <div className="h-px w-full bg-border" />

      <SystemPromptSection />
    </div>
  )
}
