/**
 * SSH 建连进度卡片：连接期间浮在终端上方，展示当前阶段、步骤进度与已耗时。
 *
 * 从 `TerminalPanel` 拆出来：它只吃 `SshConnectProgress` + 一个 `onCancel`，
 * 不碰 xterm / PTY / 任何会话状态，留在 2000 行的组件里纯属陪跑。
 */
import { useEffect, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import type { SshConnectProgress, SshConnectStage } from '@fizz/contracts/agent-api'

/** 建连阶段文案（进度卡片顶部那句） */
const CONNECT_STAGE_TEXT: Record<SshConnectStage, string> = {
  resolving: '正在解析主机并建立 TCP 连接',
  handshake: '已建立连接，正在握手（密钥交换）',
  authenticating: '握手完成，正在认证身份',
  'opening-shell': '认证通过，正在打开 shell',
  ready: '连接就绪'
}

/** 卡片里逐项展示的步骤（`ready` 不在其中：它是「全都做完了」） */
const CONNECT_STEPS: Array<{ stage: SshConnectStage; label: string }> = [
  { stage: 'resolving', label: 'TCP 连接' },
  { stage: 'handshake', label: '握手 / 密钥交换' },
  { stage: 'authenticating', label: '身份认证' },
  { stage: 'opening-shell', label: '打开 shell' }
]

/** 当前阶段对应的步骤下标（`ready` = 全部完成 → 返回步数） */
function connectStepIndex(stage: SshConnectStage): number {
  if (stage === 'ready') return CONNECT_STEPS.length
  const index = CONNECT_STEPS.findIndex((s) => s.stage === stage)
  return index < 0 ? 0 : index
}

/**
 * SSH 连接进度卡片：连接期间浮在终端上方，展示当前阶段、步骤进度与已耗时。
 *
 * 底部有「取消连接」：调 `onCancel` → 终端 `kill()` 掉这次建连，服务端随之收掉 SSH 连接。
 * `kill()` 不会回 `onExit`（主动关的那条路），所以卡片收起 / 终端里的「已取消连接」提示
 * 都由 `onCancel` 自己收尾（见 `TerminalPanel` 的 `cancelConnect`）。取消的不是标签本身：
 * 标签还在，按 Enter 可重连。
 */
export function SshConnectCard({
  progress,
  onCancel
}: {
  progress: SshConnectProgress
  /** 点「取消连接」：中断正在进行的建连（终端侧 `kill()`） */
  onCancel: () => void
}) {
  // 已耗时：从卡片出现开始计时（连接总耗时由服务端决定，这里只做用户可感知的等待反馈）
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 100)
    return () => window.clearInterval(timer)
  }, [])
  const active = connectStepIndex(progress.stage)
  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full max-w-sm rounded-lg border border-border bg-card p-4 text-foreground shadow-lg"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{CONNECT_STAGE_TEXT[progress.stage]}</div>
          {progress.detail && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{progress.detail}</div>
          )}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {(elapsed / 1000).toFixed(1)}s
        </span>
      </div>

      <div className="mt-3 space-y-1.5">
        {CONNECT_STEPS.map((step, i) => {
          const done = i < active
          const running = i === active
          return (
            <div key={step.stage} className="flex items-center gap-2 text-xs">
              {done ? (
                <Check className="size-3.5 shrink-0 text-emerald-500" />
              ) : running ? (
                <RefreshCw className="size-3.5 shrink-0 animate-spin text-primary" />
              ) : (
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                </span>
              )}
              <span className={done || running ? 'text-foreground' : 'text-muted-foreground'}>
                {step.label}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {done ? '已完成' : running ? '进行中' : '等待'}
              </span>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="mt-3 w-full rounded border border-border py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        取消连接
      </button>
    </div>
  )
}
