/**
 * 确认卡的操作按钮（工作区 Agent 与终端 AI 助手**共用**，对齐 fishwork 的四档裁决）。
 *
 * ⚠️ 按钮**从 `confirm.options` 生成**，不要在这里写死四颗：
 * 主进程按来源给出可用档位 —— 内置工具恒为四档，ACP 按 agent 在 `session/request_permission`
 * 里广告的 `option.kind` 收窄。写死的话，agent 只给两档时多出来的按钮点了也没用
 * （它不认那个 option，请求会被静默丢弃）。
 */
import { Ban, Check, CheckCheck, XCircle } from 'lucide-react'
import { Button } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type { ReactNode } from 'react'
import type { AgentConfirmRequest, ConfirmDecision } from '@shared/types'

/** 档位 → 图标 / 按钮形态（「总是」档用双钩 / 带叉圆来与「一次」档区分） */
const META: Record<
  ConfirmDecision,
  { icon: ReactNode; type: 'primary' | 'default' | 'text'; danger?: boolean }
> = {
  allow_once: { icon: <Check className="size-3.5" />, type: 'primary' },
  allow_always: { icon: <CheckCheck className="size-3.5" />, type: 'default' },
  reject_once: { icon: <Ban className="size-3.5" />, type: 'text', danger: true },
  reject_always: { icon: <XCircle className="size-3.5" />, type: 'text', danger: true }
}

export function ConfirmActions({
  confirm,
  size = 'small',
  className
}: {
  confirm: AgentConfirmRequest
  size?: 'small' | 'middle'
  className?: string
}) {
  // 两条线共用同一个动作（实现一致，见 app-store 的 resolveAgentConfirm / resolveAiConfirm）
  const resolve = useAppStore((s) => s.resolveAgentConfirm)
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {confirm.options.map((opt) => {
        const meta = META[opt.value]
        return (
          <Button
            key={opt.value}
            type={meta.type}
            size={size}
            danger={meta.danger}
            icon={meta.icon}
            onClick={() => void resolve(confirm.id, opt.value)}
          >
            {opt.label}
          </Button>
        )
      })}
    </div>
  )
}
