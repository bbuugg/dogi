import { useMemo } from 'react'
import { Drawer, Empty, Tooltip } from 'antd'
import { MessageSquare, Terminal, TrendingUp } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { buildUsageReport, formatTokens } from '@shared/agent-usage'
import { cn } from 'cn'

/**
 * **AI 用量统计**（跨会话）。
 *
 * ## 为什么放在 Agent 面板里、而不是新开一个功能区
 *
 * 统计的数据源就是会话本身（消息里的 `usage`），离开会话列表它没有独立的「对象」——
 * 新开一个活动栏条目要么让它空着（没有自己的列表），要么把会话列表再抄一份。
 * 从会话列表头上打开一个抽屉，上下文是连贯的：「我看了一眼总量 → 想看看是哪条会话烧的 →
 * 点一下就跳过去」。
 *
 * ## 口径必须写清楚（否则用户会以为统计坏了）
 *
 * - **总计 = 全部历史**；**按天图 = 最近 N 天**。两者不是一回事，界面上分别标注。
 * - **ACP 会话没有用量**：它的消息归外部 agent 管，本地一个字节都没有。这不是漏算。
 * - 只统计**助手消息上带 `usage` 的轮次**：模型没上报用量的轮次（部分 provider）
 *   根本不存在这个数字，不能拿 0 充数当成「这轮没花钱」。
 */
export function AgentUsageDrawer({
  open,
  onClose,
  onOpenConversation,
  days = 14
}: {
  open: boolean
  onClose: () => void
  /** 点某条会话 → 选中并跳到它（抽屉由调用方关） */
  onOpenConversation: (conversationId: string, workspaceId?: string) => void
  /** 按天统计的窗口（含今天） */
  days?: number
}) {
  const agentConversations = useAppStore((s) => s.agentConversations)
  const terminalConversations = useAppStore((s) => s.terminalConversations)
  const agentWorkspaces = useAppStore((s) => s.agentWorkspaces)
  const aiConfigs = useAppStore((s) => s.aiConfigs)

  const report = useMemo(
    // 草稿（还没发过消息）没有用量，一起传进去也无妨（会被「没有 usage 的会话」过滤掉）
    () => buildUsageReport([...agentConversations, ...terminalConversations], { days }),
    [agentConversations, terminalConversations, days]
  )

  /** 工作区名（会话行上标一下，跨工作区时才知道是哪儿的） */
  const workspaceName = (id?: string) =>
    id ? (agentWorkspaces.find((w) => w.id === id)?.name ?? '已删除的工作区') : undefined

  /** 模型归组键 → 可读名（配置里找不到就原样显示 id，别显示「未知」把信息抹掉） */
  const modelLabel = (key: string): string => {
    if (!key) return '跟随配置默认模型'
    for (const cfg of aiConfigs) {
      if (cfg.id === key) return cfg.name || cfg.id
      // `models` 是模型 id 的字符串数组（不是对象数组），命中就直接用这个 id 显示
      if (cfg.model === key || cfg.models?.includes(key)) return key
    }
    return key
  }

  const peak = Math.max(1, ...report.byDay.map((d) => d.totalTokens))
  const maxConvTokens = Math.max(1, ...report.topConversations.map((c) => c.usage.totalTokens))

  const statCards: Array<{ label: string; value: string; hint?: string }> = [
    { label: '总 token', value: formatTokens(report.totals.totalTokens), hint: '全部历史' },
    { label: '输入', value: formatTokens(report.totals.inputTokens) },
    { label: '输出', value: formatTokens(report.totals.outputTokens) },
    {
      label: '缓存命中',
      value: formatTokens(report.totals.cachedInputTokens),
      hint: '部分 provider 才上报'
    },
    {
      label: '思考 token',
      value: formatTokens(report.totals.reasoningTokens),
      hint: '推理模型才有'
    },
    { label: '轮次', value: String(report.turns), hint: `${report.conversationCount} 条会话` }
  ]

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="AI 用量统计"
      width={560}
      // 数据是只读的统计，不需要「确定 / 取消」，点外面就该能关
      maskClosable
      destroyOnHidden
    >
      {report.turns === 0 ? (
        <Empty
          description={
            <span className="text-xs text-muted-foreground">
              还没有用量记录。
              <br />
              跑几轮对话后，模型上报的 token 会汇总在这里。
            </span>
          }
        />
      ) : (
        <div className="space-y-5">
          {/* 总计：六格小卡片 */}
          <div className="grid grid-cols-3 gap-2">
            {statCards.map((c) => (
              <div key={c.label} className="rounded-md border border-border px-3 py-2">
                <div className="text-xs text-muted-foreground">{c.label}</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums">{c.value}</div>
                {c.hint && (
                  <div className="text-[10px] leading-3 text-muted-foreground/70">{c.hint}</div>
                )}
              </div>
            ))}
          </div>

          {/* 按天：纯 div 柱状图（不引图表库 —— 十几根柱子不值得多一个依赖） */}
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-xs font-semibold text-foreground/90">最近 {days} 天</h3>
              <span className="text-[10px] text-muted-foreground">
                柱高 = 当天总 token（峰值 {formatTokens(peak)}）
              </span>
            </div>
            <div className="flex h-28 items-end gap-1">
              {report.byDay.map((d) => {
                const ratio = d.totalTokens / peak
                const isToday = d === report.byDay[report.byDay.length - 1]
                return (
                  <Tooltip
                    key={d.date}
                    title={`${d.date} · ${d.totalTokens.toLocaleString()} token · ${d.turns} 轮`}
                  >
                    <div className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1">
                      <div
                        className={cn(
                          'w-full rounded-sm transition-colors',
                          d.totalTokens > 0
                            ? isToday
                              ? 'bg-primary'
                              : 'bg-primary/50'
                            : 'bg-muted'
                        )}
                        // 有量但极小（不到 1px）时保底 2px，否则「那天其实跑了」看着像空的
                        style={{ height: d.totalTokens > 0 ? `${Math.max(2, ratio * 100)}%` : '2px' }}
                      />
                    </div>
                  </Tooltip>
                )
              })}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>{report.byDay[0]?.date.slice(5)}</span>
              <span>今天</span>
            </div>
          </section>

          {/* 按模型 */}
          {report.byModel.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-foreground/90">按模型</h3>
              <div className="space-y-1.5">
                {report.byModel.map((m) => (
                  <div key={m.key || '__default__'} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate" title={modelLabel(m.key)}>
                      {modelLabel(m.key)}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{m.turns} 轮</span>
                    <span className="w-16 shrink-0 text-right font-medium tabular-nums">
                      {formatTokens(m.usage.totalTokens)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 最费 token 的会话：点一条直接跳过去 */}
          <section>
            <h3 className="mb-2 text-xs font-semibold text-foreground/90">最费 token 的会话</h3>
            <div className="space-y-1">
              {report.topConversations.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onOpenConversation(c.id, c.workspaceId)}
                  className="block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/5"
                >
                  <div className="flex items-center gap-1.5">
                    {c.scope === 'terminal' ? (
                      <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{c.title}</span>
                    <span className="shrink-0 text-xs font-medium tabular-nums">
                      {formatTokens(c.usage.totalTokens)}
                    </span>
                  </div>
                  {/* 占比条：一眼看出「大头在哪条」 */}
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/60"
                      style={{ width: `${(c.usage.totalTokens / maxConvTokens) * 100}%` }}
                    />
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    {c.scope === 'terminal' ? (
                      <span>终端助手</span>
                    ) : (
                      <span>{workspaceName(c.workspaceId) ?? '—'}</span>
                    )}
                    <span>·</span>
                    <span>{c.turns} 轮</span>
                    <span>·</span>
                    <span>入 {formatTokens(c.usage.inputTokens)}</span>
                    <span>出 {formatTokens(c.usage.outputTokens)}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <p className="flex items-start gap-1.5 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
            <TrendingUp className="mt-0.5 size-3.5 shrink-0" />
            <span>
              统计口径：只算**模型上报了 usage** 的轮次（部分 provider 不上报，那些轮次不计入，
              也不按 0 处理）。外部 ACP agent 的会话消息不在本地，因此不在统计范围内。
            </span>
          </p>
        </div>
      )}
    </Drawer>
  )
}
