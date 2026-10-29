'use client'

/**
 * 会话内的**后台任务面板**：挂在输入框上方，只显示**当前会话**名下的后台命令。
 *
 * ## 为什么这件事不能只靠状态栏那颗徽标
 *
 * 徽标是全局的：它回答「这台机器上还有活在跑吗」。但用户真正在问的是「**我这段对话**
 * 起的那个 dev server 还活着吗、它刚才报了什么错」。切到别的会话再看徽标，那一行就混在
 * 别人的任务里了 —— 归属丢了，解释力也就没了。
 *
 * 所以后台任务带 `sessionId`（登记那一刻固定死），面板按当前会话过滤。同一个进程既出现
 * 在状态栏（全局视角）也出现在这里（会话视角），这不是两份状态，是同一份清单的两种切法。
 *
 * ## 数据怎么来
 *
 * - **事件**（`backgroundTasks:changed`）管「立刻反应」：任务起跑 / 收场时登记表自己广播，
 *   收到就重拉清单 —— 起一条命令后不该等下一个轮询周期才看到那一行；
 * - **轮询**管兜底：有任务在跑 2s 一轮（要跟手：用户点了停止，2s 内要看到反应），
 *   全空闲 8s 一轮（只为发现别处起的任务）。WS 断了也只是变慢，不会瞎。
 *
 * 两条路共用一个 in-flight 闸（`inFlight` / `queued`）：事件触发的刷新和轮询撞在一起时，
 * 后来的那次只是排队重跑，不会并行发两个请求、也不会把定时器叠成两份。
 *
 * ## 哪些行该显示
 *
 * - 跑着的：一直显示；
 * - 刚结束的：**10 秒优雅窗口**内还留着（让退出码 / 最后一行报错看得见），过了就走。
 *   起点用任务自己的 `finishedAt`，所以「轮询间隔里起完又结束」的短命令也能露一眼；
 * - 展开着输出预览的：**钉住**，正在读的日志不能自己消失；
 * - 早就结束的历史任务（打开面板前就结束的）：不显示 —— 登记表里留着的已结束任务是给
 *   状态栏那张全局清单看的，不是给这里补一堆陈年旧账。
 *
 * ## 一个任务都没有时
 *
 * 返回 `null`（与状态栏徽标同一个原则）：这块面板是「有事才出现」的东西，常驻一个空壳
 * 只会把输入框往下推、还占着审批卡的位置。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Square,
  SquareTerminal,
  X,
  XCircle
} from 'lucide-react'
import type {
  BackgroundTaskDetail,
  BackgroundTaskStatus,
  BackgroundTaskView
} from '@fizz/contracts/agent-api'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { initStateClient, subscribeServerEvent } from '@fizz/agent-kit/shared/lib/state-ws'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** 有任务在跑时的轮询间隔：要跟手（点了停止 2s 内看到反应） */
const POLL_ACTIVE_MS = 2_000
/** 全空闲时的轮询间隔：只为发现别处起的任务 */
const POLL_IDLE_MS = 8_000
/** 展开日志且任务还在跑时的详情轮询间隔（比列表快一点，输出才像在动） */
const LOG_POLL_MS = 1_200
/**
 * 结束后的优雅窗口：任务收场后再留 10 秒。
 *
 * 为什么要留：`npm run dev` 挂掉时，最有用的信息就是最后那几行报错和退出码；一结束就
 * 抹掉等于让用户永远看不到「它为什么死了」。10 秒够读完一段栈，又不至于把输入框顶住。
 */
const ENDED_VISIBLE_MS = 10_000

/** 行尾状态话术：跑着的说「已运行多久」，结束的说「用了多久」 */
function describeStatus(task: BackgroundTaskView, now: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const end = task.finishedAt ?? now
  switch (task.status) {
    case 'running':
      return t('已运行 {time}', { time: formatDuration(now - task.startedAt) })
    case 'done':
      return t('用时 {time}', { time: formatDuration(end - task.startedAt) })
    case 'canceled':
      return t('已取消')
    case 'failed':
      return t('失败')
  }
}

/** 毫秒 → 人话时长（`45s` / `3m 07s` / `1h 12m`） */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function StatusIcon({ status }: { status: BackgroundTaskStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
    case 'done':
      return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
    case 'failed':
      return <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
    case 'canceled':
      return <XCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  }
}

/**
 * 输出预览：等宽、可滚、**贴着底才自动滚**。
 *
 * 「贴底」判断不能省：用户往上翻看前面的输出时，新来一行就把他弹回底部会直接毁掉
 * 「翻历史」这件事。滚轮往上拖一下关掉跟随，拖回底部又自动开回来。
 */
function LogPane({ lines, loading }: { lines: BackgroundTaskDetail['logs']; loading: boolean }) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const t = useT()

  useEffect(() => {
    const el = boxRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div
      ref={boxRef}
      onScroll={(event) => {
        const el = event.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      className="mt-1 max-h-40 overflow-y-auto overscroll-contain rounded-md bg-muted/40 px-2 py-1 font-mono text-[0.6875rem] leading-[1.5]"
    >
      {lines.length === 0 ? (
        <div className="py-0.5 text-muted-foreground">
          {loading ? t('加载日志…') : t('还没有输出')}
        </div>
      ) : (
        lines.map((line, index) => (
          // 同一毫秒可能有多行（`at` 不唯一），索引当 key 的一部分才稳
          <div
            key={`${line.at}-${index}`}
            className={cn(
              'whitespace-pre-wrap break-all',
              line.level === 'error'
                ? 'text-destructive'
                : line.level === 'warn'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-foreground'
            )}
          >
            {line.text}
          </div>
        ))
      )}
    </div>
  )
}

export function BackgroundTaskDock({
  app,
  conversationId
}: {
  app: AgentApp
  /** 当前会话 id：只显示它的任务（没有会话时由调用方不渲染本组件） */
  conversationId: string
}) {
  const t = useT()
  const api = app.api
  const [all, setAll] = useState<BackgroundTaskView[]>([])
  /**
   * 「刚结束」的任务 → 窗口起点（id → 时间戳），见 `apply` 里的补起点规则。
   *
   * 只用来算「还能显示多久」：任务本身的状态永远以服务端清单为准，这里不复制状态。
   */
  const [endedAt, setEndedAt] = useState<Record<string, number>>({})
  /** 每秒走一格的「现在」：跑着的行要显示实时时长，结束的行要靠它算窗口到期 */
  const [now, setNow] = useState(() => Date.now())
  const [collapsed, setCollapsed] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<BackgroundTaskDetail | null>(null)
  /** 上一轮还在跑的 id：只用来决定下一轮轮询该多快（有活在跑就 2s） */
  const runningRef = useRef<Set<string>>(new Set())

  /**
   * 拿回一份清单：整体替换 + 给「刚结束」的行打上优雅窗口的起点。
   *
   * 起点用任务自己的 `finishedAt` 而不是 `Date.now()`：轮询间隔（2s）里完全可能
   * 「起完又结束」（一条 1 秒的 build），那种任务我们一次都没见它跑过 —— 用 `finishedAt`
   * 补起点，它才不至于连一眼都露不出来。
   *
   * 但**只补刚结束的**（窗口内）：登记表里躺着几小时前的已结束任务是给状态栏那张
   * 全局清单看的，捞到这里等于每次打开会话都闪一堆陈年旧账。
   */
  const apply = useCallback((next: BackgroundTaskView[]) => {
    runningRef.current = new Set(next.filter((task) => task.status === 'running').map((task) => task.id))
    setAll(next)
    const stamp = Date.now()
    setEndedAt((prev) => {
      let out: Record<string, number> | null = null
      for (const task of next) {
        if (task.status === 'running') continue
        const at = task.finishedAt
        if (at === undefined || stamp - at >= ENDED_VISIBLE_MS) continue
        if (prev[task.id] !== undefined) continue
        out ??= { ...prev }
        out[task.id] = at
      }
      return out ?? prev
    })
  }, [])

  // 清单：事件驱动 + 轮询兜底（两条路共用一个 in-flight 闸）
  useEffect(() => {
    if (!api) return
    let stopped = false
    let inFlight = false
    let queued = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const refresh = async (): Promise<void> => {
      if (inFlight) {
        queued = true
        return
      }
      inFlight = true
      clearTimeout(timer)
      try {
        const result = await api.listBackgroundTasks()
        if (stopped) return
        apply(result.tasks ?? [])
      } catch {
        // 拉不到就按空闲节奏重试：这是个附加面板，不该为它弹错误
      } finally {
        inFlight = false
        if (stopped) return
        if (queued) {
          queued = false
          void refresh()
          return
        }
        timer = setTimeout(
          () => void refresh(),
          runningRef.current.size > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS
        )
      }
    }

    void refresh()
    // 幂等：整应用只开一条状态 WS（app-shell 已经调过也没关系），这里补一次是为了
    // 让本组件在别的壳（面板 / 手机布局）里挂载时也能收到事件
    initStateClient()
    const off = subscribeServerEvent((event) => {
      if (event.type === 'backgroundTasks:changed') void refresh()
    })
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      off()
    }
  }, [api, apply])

  /**
   * 只留这个会话的行，再按可见性筛一遍。
   *
   * 排序：跑着的在前，同组按开始时间倒序（新起的在上面）—— 与状态栏那张清单同一套顺序，
   * 用户在两个地方看到的相对位置不会变。
   */
  const rows = useMemo(() => {
    const mine = all.filter((task) => task.sessionId === conversationId)
    const visible: BackgroundTaskView[] = []
    for (const task of mine) {
      if (task.status === 'running' || task.id === expandedId) {
        visible.push(task)
        continue
      }
      const ended = endedAt[task.id]
      if (ended !== undefined && now - ended < ENDED_VISIBLE_MS) visible.push(task)
    }
    return visible.sort((a, b) => {
      const running = Number(b.status === 'running') - Number(a.status === 'running')
      return running !== 0 ? running : b.startedAt - a.startedAt
    })
  }, [all, conversationId, endedAt, now, expandedId])

  // 有行才需要秒针（跑着的要时长、结束的要算到期）；没有行就停掉，别每秒白重渲染
  const ticking = rows.length > 0
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [ticking])

  /** 展开那条任务的状态：一从 running 变成结束，下面的详情 effect 会重跑一次拿终局输出 */
  const expandedStatus = all.find((task) => task.id === expandedId)?.status

  // 详情（含日志）：只有展开的那一条才拉，跑着就 1.2s 续拉
  useEffect(() => {
    if (!api || !expandedId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // 换行时先清掉上一条的日志，否则会短暂看到「上一行的输出挂在这一行下面」
    setDetail((prev) => (prev?.task.id === expandedId ? prev : null))

    const load = async (): Promise<void> => {
      try {
        const next = await api.getBackgroundTask(expandedId)
        if (stopped) return
        setDetail(next)
        if (next.task.status === 'running') timer = setTimeout(() => void load(), LOG_POLL_MS)
      } catch {
        // 任务刚被关掉 / 服务重启：静默收场，清单那边会把这一行清掉
      }
    }

    void load()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [api, expandedId, expandedStatus])

  // 那一行没了（被关掉 / 被清空）：展开态跟着收起来，别留一个没有主的日志面板
  useEffect(() => {
    if (expandedId && !all.some((task) => task.id === expandedId)) {
      setExpandedId(null)
      setDetail(null)
    }
  }, [all, expandedId])

  if (!api || rows.length === 0) return null

  const running = rows.filter((task) => task.status === 'running').length
  /** 每条操作接口都回全量清单，拿回来直接整体替换（不用自己算增删） */
  const applyResult = (result: { tasks: BackgroundTaskView[] }): void => apply(result.tasks ?? [])
  const stop = (id: string): void => {
    void api.cancelBackgroundTask(id).then(applyResult).catch(() => undefined)
  }
  const dismiss = (id: string): void => {
    void api.dismissBackgroundTask(id).then(applyResult).catch(() => undefined)
  }

  const headerText =
    running > 0
      ? t('后台任务 · {count} 项运行中', { count: running })
      : t('后台任务 · {count} 项已结束', { count: rows.length })

  return (
    <div className="rounded-lg border border-border bg-card/60">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('展开后台任务') : t('收起后台任务')}
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-secondary/40"
      >
        {running > 0 ? (
          /*
           * 刻意**不转**：这一行只是「有 N 项在跑」的状态说明，动感由下面每一行的
           * `StatusIcon`（那个 spinner）负责。两处一起转会让人分不清「到底是哪一条还在跑」，
           * 而且顶部图标一转身，整块面板看起来永远在忙。
           */
          <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{headerText}</span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            collapsed && '-rotate-90'
          )}
        />
      </button>

      {collapsed ? null : (
        // 面板自己在 min(200px, 24vh) 内滚：多几行也不该把审批卡和输入框顶出屏幕
        <div className="max-h-[min(200px,24vh)] overflow-y-auto overscroll-contain border-t border-border">
          {rows.map((task) => {
            const expanded = expandedId === task.id
            const isRunning = task.status === 'running'
            // 详情可能还是上一条的（切换那一瞬），对不上就当「加载中」
            const lines = detail?.task.id === task.id ? detail.logs : []
            return (
              <div
                key={task.id}
                className="border-b border-border/60 px-2.5 py-1.5 last:border-b-0"
                data-state={task.status}
              >
                <div className="flex items-start gap-1.5">
                  <StatusIcon status={task.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      {/* 命令原文：等宽 + 单行截断，长命令不折行把行高撑乱 */}
                      <code
                        className="min-w-0 shrink truncate font-mono text-[0.6875rem] text-foreground"
                        title={task.title}
                      >
                        {task.title}
                      </code>
                      <span className="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">
                        {describeStatus(task, now, t)}
                      </span>
                    </div>
                    {task.status === 'failed' && task.error && (
                      <div className="break-words text-[0.6875rem] text-destructive">
                        {task.error}
                      </div>
                    )}
                    {/* 有输出才给展开入口：后台命令的日志就是它唯一的过程证据 */}
                    {task.logCount > 0 && (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : task.id)}
                        className="mt-0.5 inline-flex items-center gap-0.5 text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronRight
                          className={cn('size-3 transition-transform', expanded && 'rotate-90')}
                        />
                        <span className="tabular-nums">
                          {t('日志 {count}', { count: task.logCount })}
                        </span>
                      </button>
                    )}
                    {expanded && (
                      <LogPane lines={lines} loading={detail?.task.id !== task.id} />
                    )}
                  </div>

                  {isRunning ? (
                    <button
                      type="button"
                      aria-label={t('停止后台命令')}
                      onClick={() => stop(task.id)}
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      <Square className="size-3" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={t('关闭这条后台任务')}
                      onClick={() => dismiss(task.id)}
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
