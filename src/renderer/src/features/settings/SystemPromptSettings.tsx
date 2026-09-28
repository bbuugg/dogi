import { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { Input } from 'antd'

/**
 * 系统提示词：从原「偏好」迁移而来，作为设置里独立的一项。
 * 自定义 AI 助手的角色与约束（例如运维安全操作规范），留空使用默认。
 */
export function SystemPromptSettings() {
  const aiSettings = useAppStore((s) => s.aiSettings)
  const saveAiSettings = useAppStore((s) => s.saveAiSettings)
  const [systemPrompt, setSystemPrompt] = useState(aiSettings.systemPrompt ?? '')

  useEffect(() => {
    setSystemPrompt(aiSettings.systemPrompt ?? '')
  }, [aiSettings.systemPrompt])

  return (
    <section className="space-y-2">
      <div>
        <label htmlFor="system-prompt" className="text-sm font-medium text-foreground">
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
