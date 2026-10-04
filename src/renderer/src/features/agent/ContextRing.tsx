import { Gauge, Loader2 } from 'lucide-react'
import { Button, Popover, message } from 'antd'
import type {
  ContextCompression,
  ConversationContextSummary,
  ConversationUsage,
  TurnUsage
} from '@shared/types'
import { COMPRESS_TRIGGER_RATIO } from '@shared/context-budget'
import { cn } from 'cn'

/** 圆环几何：r=7 在 18×18 视窗里给 2.5 描边刚好留白；弧线从 12 点方向起画 */
const R = 7
const CIRC = 2 * Math.PI * R

function fmt(n: number): string {
  return n.toLocaleString()
}

/** 压缩 / 清除的返回（`fatal` = 真故障；`ok:false` 且非 fatal 只是「这次没做」） */
export interface ContextActionResult {
  ok: boolean
  reason?: string
  fatal?: boolean
}

export interface ContextRingProps {
  /** 上一轮发给模型的**真实**输入 token；还没跑过一轮时为 null */
  used: number | null
  /**
   * 这个会话的**上下文窗口**（token）—— 圆环的分母。
   *
   * 必须与主进程判断要不要压缩时用的是同一个值（`resolveContextWindow`），
   * 否则圆环显示「还剩 20%」而实际早就压过了。
   */
  budget: number | null
  /** 上一轮的完整用量（详情里的分项；上游没报的那项就不显示） */
  lastUsage?: TurnUsage
  /**
   * **会话累计**用量（现算的 `sumUsage`，不是另存的副本）。
   *
   * 曾经粘在消息列顶部，迁移时与这个圆环重复了一份 —— 现在只留这里：
   * 顶部条只放「刚刚压缩了什么」的一次性通知，累计这种随时要看的常驻数据收进圆环。
   */
  totalUsage?: ConversationUsage | null
  /**
   * `used` 是不是**压缩后的估算值**（而不是 provider 上报的真实值）。
   *
   * 手动压缩之后、下一轮跑完之前，真实的 `inputTokens` 还是压缩前那一轮报的 ——
   * 直接拿来画圆环会让用户以为「压了等于没压」。这段时间由调用方用检查点里算好的
   * `afterTokens` 顶一下；这里如实标注它是估算，免得被当成服务端回报的真实值。
   */
  estimated?: boolean
  /** 最近一次压缩通知（自动压缩与手动压缩都会写它） */
  notice?: ContextCompression
  /** 已落库的摘要检查点 —— 有它才需要「清除摘要」 */
  checkpoint?: ConversationContextSummary
  compressing?: boolean
  /** 「压缩上下文」；`source: 'agent'` 时不渲染按钮，所以 ACP 会话可以不传 */
  onCompress?: () => Promise<ContextActionResult>
  onClear?: () => Promise<ContextActionResult>
  /**
   * 水位的**来源**，决定详情里的说明文案与「压缩上下文」按钮：
   * - `'local'`（默认，内置 Mastra 会话）：分母是我们自己的预算，「压缩上下文」有效；
   * - `'agent'`（ACP 会话）：水位是 agent 经 `session/update` 的 `usage_update` 上报的，
   *   上下文也在 agent 侧 —— **没有可压缩的东西**，所以不显示压缩 / 清除摘要按钮。
   */
  source?: 'local' | 'agent'
  className?: string
}

/**
 * 输入框工具行里的**上下文用量圆环**：一眼看出「这轮上下文用了多少」，
 * 悬停展开详情 + 手动压缩入口。移植自 fishwork 的 `ContextRing`。
 *
 * 四个刻意的取舍：
 * - **分子用 provider 上报的真实 `inputTokens`，不是本地估算**。本地 `estimateTokens`
 *   只用来判「够不够触发压缩」（差 20% 不影响是否触发），拿它做展示会骗人。
 *   代价是：流式过程中显示的是**上一完成轮**的值，本轮跑完才跳 —— 详情里写明了这点。
 * - **80% / 100% 只改颜色，不弹告警**。100% 才是真正的压缩触发点（见 `budget`），
 *   80% 是提前给个视觉预警；弹 toast 打断输入体验，收益为负。
 * - **压缩按钮放在详情卡里而不是工具行上**：它是低频操作（自动压缩兜着底），
 *   占一个常驻图标位不值。自动压缩回退成截断的情况另由顶部提示条说明。
 * - **会话累计只在这里**（详情里的「会话累计」段）：消息列顶部那条提示条只放
 *   「刚刚压缩了什么」的一次性通知，累计这种随时要瞄的常驻数据收进圆环 ——
 *   同一个数字不要有第二个副本（迁移时正是从顶部搬过来的）。
 */
export function ContextRing({
  used,
  budget,
  lastUsage,
  totalUsage,
  estimated = false,
  notice,
  checkpoint,
  compressing = false,
  onCompress,
  onClear,
  source = 'local',
  className
}: ContextRingProps) {
  const fromAgent = source === 'agent'
  const ratio = used !== null && budget ? Math.min(1, used / budget) : null
  const percent = ratio !== null ? Math.round(ratio * 100) : null
  // 颜色档：无数据淡灰 → 正常灰 → 80% 琥珀预警 → 100% 红
  const tone =
    percent === null
      ? 'stroke-muted-foreground/30'
      : percent >= 100
        ? 'stroke-destructive'
        : percent >= 80
          ? 'stroke-amber-500'
          : 'stroke-muted-foreground'

  const run = async (action: () => Promise<ContextActionResult>, failPrefix: string) => {
    const res = await action()
    // 成功不弹 toast：顶部那条「上下文已压缩」提示条就是设计好的反馈渠道（见 ConversationUsageBar）
    if (res.ok) return
    // 「没做」与「做失败」分开说：不足两轮是预期内的用户操作，不该报红
    if (res.fatal) message.error(`${failPrefix}：${res.reason ?? '未知错误'}`)
    else message.info(res.reason ?? `${failPrefix}：未执行`)
  }

  const detail = (
    <div className="w-72 space-y-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <Gauge className="size-3.5" />
        上下文用量
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums">
          {used !== null ? fmt(used) : '—'}
        </span>
        <span className="text-muted-foreground">
          / {budget !== null ? fmt(budget) : '—'} tokens
          {percent !== null && ` · ${percent}%`}
        </span>
        {estimated && (
          <span className="text-xs text-muted-foreground">压缩后估算</span>
        )}
      </div>

      {/* 上一轮的账目：输入（= 上面的上下文占用）里有多少命中缓存、输出 / 思考多少、多快。
          上游没报的项整条不渲染 —— 宁可少一行，也不要显示一个编出来的 0 */}
      {lastUsage && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
          <span>
            输入{' '}
            <span className="font-medium tabular-nums text-foreground">
              {fmt(lastUsage.inputTokens)}
            </span>
          </span>
          <span>
            输出{' '}
            <span className="font-medium tabular-nums text-foreground">
              {fmt(lastUsage.outputTokens)}
            </span>
          </span>
          {lastUsage.cachedInputTokens != null && (
            <span>
              其中缓存命中{' '}
              <span className="font-medium tabular-nums text-foreground">
                {fmt(lastUsage.cachedInputTokens)}
              </span>
            </span>
          )}
          {lastUsage.reasoningTokens != null && (
            <span>
              其中思考{' '}
              <span className="font-medium tabular-nums text-foreground">
                {fmt(lastUsage.reasoningTokens)}
              </span>
            </span>
          )}
          {(lastUsage.tps > 0 || lastUsage.durationMs > 0) && (
            <span>
              {lastUsage.tps > 0 && `${lastUsage.tps.toFixed(1)} tok/s`}
              {lastUsage.durationMs > 0 && ` · ${(lastUsage.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
        </div>
      )}
      <p className="text-muted-foreground">
        {fromAgent
          ? '圆环 = 该 Agent 报告的上下文占用与它自己的窗口大小（本应用不压缩它的上下文）。'
          : estimated
            ? '圆环 = 压缩后的估算占用（刚压过、还没发新一轮）；下一轮跑完会换成服务端回报的真实值。'
            : `圆环 = 上一轮发给模型的真实历史量，本轮跑完后更新。到窗口的 ${Math.round(
                COMPRESS_TRIGGER_RATIO * 100
              )}% 就会自动压缩旧的若干轮。`}
      </p>

      {/* 会话累计：整段会话烧掉的 token。它**只在这里**——消息列顶部那条提示条
          只放「刚刚压缩了什么」的一次性通知，不再另挂一份累计（迁移时的重复）。 */}
      {totalUsage && (
        <>
          <div className="border-t pt-2" />
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Gauge className="size-3.5" />
            会话累计
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
            <span>
              输入{' '}
              <span className="font-medium tabular-nums text-foreground">
                {fmt(totalUsage.inputTokens)}
              </span>
            </span>
            <span>
              输出{' '}
              <span className="font-medium tabular-nums text-foreground">
                {fmt(totalUsage.outputTokens)}
              </span>
            </span>
            <span>
              合计{' '}
              <span className="font-medium tabular-nums text-foreground">
                {fmt(totalUsage.totalTokens)}
              </span>
            </span>
            {/* 上游没报的项整条不渲染：显示一个 0 会让人以为「这一整段真的没思考」 */}
            {!!totalUsage.reasoningTokens && (
              <span>
                思考{' '}
                <span className="font-medium tabular-nums text-foreground">
                  {fmt(totalUsage.reasoningTokens)}
                </span>
              </span>
            )}
            {!!totalUsage.cachedInputTokens && (
              <span>
                缓存{' '}
                <span className="font-medium tabular-nums text-foreground">
                  {fmt(totalUsage.cachedInputTokens)}
                </span>
              </span>
            )}
          </div>
        </>
      )}

      <div className="border-t pt-2" />
      {/* 上下文在 agent 侧时，下面这些全是本地机制，一概不显示（免得给个按不动的按钮） */}
      {fromAgent ? null : (
        <>
      {notice ? (
        <p className="text-muted-foreground">
          最近一次压缩：{fmt(notice.beforeTokens)} → {fmt(notice.afterTokens)} token，摘要{' '}
          {notice.summarizedTurns} 轮、保留 {notice.keptTurns} 轮。
          {notice.truncated && (
            <span className="text-destructive"> 摘要失败，旧轮已截断丢弃</span>
          )}
        </p>
      ) : (
        <p className="text-muted-foreground">最近没有发生过上下文压缩。</p>
      )}
      {checkpoint && (
        <p className="text-muted-foreground">
          已开启摘要压缩（{new Date(checkpoint.createdAt).toLocaleString()}）：
          之前的对话以摘要参与上下文，原始消息未动。
        </p>
      )}

      <div className="flex items-center gap-1 pt-1">
        {onCompress && (
          <Button
            size="small"
            className="h-7 px-2.5 text-xs"
            disabled={compressing}
            onClick={() => void run(onCompress, '压缩失败')}
          >
            {compressing ? (
              <span className="flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" />
                压缩中…
              </span>
            ) : (
              '压缩上下文'
            )}
          </Button>
        )}
        {checkpoint && onClear && (
          <Button
            size="small"
            type="text"
            className="h-7 px-2.5 text-xs text-muted-foreground"
            disabled={compressing}
            onClick={() => void run(onClear, '清除摘要失败')}
          >
            清除摘要
          </Button>
        )}
      </div>
        </>
      )}
    </div>
  )

  return (
    <Popover
      content={detail}
      // 悬停即开、不点按钮：这是「瞄一眼」的信息，不该占一次点击
      trigger="hover"
      placement="topRight"
      mouseEnterDelay={0.15}
      mouseLeaveDelay={0.1}
    >
      <Button
        type="text"
        size="small"
        aria-label="上下文用量"
        title={
          fromAgent
            ? '上下文用量（由该 Agent 报告）'
            : '上下文用量（悬停看详情，可手动压缩）'
        }
        className={cn('shrink-0 px-1.5', className)}
      >
        {compressing ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <svg viewBox="0 0 18 18" className="size-4 shrink-0" aria-hidden>
            <circle
              cx="9"
              cy="9"
              r={R}
              fill="none"
              strokeWidth="2.5"
              className="stroke-muted-foreground/25"
            />
            {ratio !== null && ratio > 0 && (
              <circle
                cx="9"
                cy="9"
                r={R}
                fill="none"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={`${(ratio * CIRC).toFixed(2)} ${CIRC.toFixed(2)}`}
                transform="rotate(-90 9 9)"
                className={tone}
              />
            )}
          </svg>
        )}
      </Button>
    </Popover>
  )
}
