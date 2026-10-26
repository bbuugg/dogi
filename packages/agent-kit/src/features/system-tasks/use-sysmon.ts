/**
 * 系统监控 + 任务管理器的状态与动作（面板只负责画）。
 *
 * ## 两个数据源，一次轮询
 *
 * - `GET /api/system`（带 `detail=1`）：CPU 总量 / 每核 / 内存 / 磁盘 / 历史曲线。它读的是
 *   服务端**常驻采样器**的快照 —— 采样节奏稳定，所以折线是连续的；
 * - `GET /api/system/tasks`：进程表。**每次现采**（`ps` / `tasklist`），只在面板挂着时才有
 *   请求，关掉就彻底停。
 *
 * 两者在同一个 `setTimeout` 循环里 `Promise.all` 取，为的是两边的「此刻」尽量是同一刻：
 * 指标卡显示 CPU 60%、进程表里那个进程占 300%，两句话得能对得上。
 *
 * ## 三条必须守住的规矩
 *
 * 1. **`app` 不进依赖数组**（AGENTS.md 写死的一条）：它每次渲染都是新对象，进了 deps
 *    就会让轮询跟着每一次父级重渲染重启 —— 表现是「间隔失效、请求翻倍」。这里一律经
 *    `apiRef` 读，effect 只依赖 `[intervalMs, paused, hasApi]` 三个稳定值。
 * 2. **页面不可见时只排定时器、不发请求**：这个面板每帧要 spawn 一次 `ps` / `tasklist`，
 *    浏览器切到别的标签页后还每 3s 采一次纯属浪费。`document.hidden` 为真就空转一轮。
 * 3. **结束进程后立刻再采一帧**：进程表是 3s 前的数据，等下一轮才知道杀没杀掉，体感就是
 *    「点了没反应」。所以 `kill()` 成功或失败都紧跟一次 `refresh()`。
 *
 * ## 排序 / 筛选放在前端
 *
 * 服务端已经按 CPU 降序排好了（保证「就算原样渲染，最该看的也在最上面」）。换排序方式
 * 只是在这份数组上再排一次 —— 一次几百条，纯内存操作，没必要为一个列头点击回服务端。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type {
  SystemMetrics,
  SystemTaskKillResult,
  SystemTaskList,
  SystemTaskProcess
} from '@fizz/contracts/agent-api'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'

/** 可选轮询间隔（毫秒） */
export const SYSMON_INTERVALS = [1_000, 2_000, 3_000, 5_000, 10_000] as const
const DEFAULT_INTERVAL = 3_000
const INTERVAL_KEY = 'fizz.sysmon.interval'

/** 表头可点的排序列 */
export type TaskSortKey = 'cpu' | 'mem' | 'pid' | 'name' | 'rss'
export type TaskSortDir = 'asc' | 'desc'

/** 结束进程的两种方式（与契约的 `mode` 同义，另加「连子进程」） */
export interface KillRequest {
  process: SystemTaskProcess
  mode: 'term' | 'kill'
  tree: boolean
}

function loadInterval(): number {
  if (typeof window === 'undefined') return DEFAULT_INTERVAL
  const value = Number(window.localStorage.getItem(INTERVAL_KEY))
  return (SYSMON_INTERVALS as readonly number[]).includes(value) ? value : DEFAULT_INTERVAL
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sortValueOf(proc: SystemTaskProcess, key: TaskSortKey): number | string {
  switch (key) {
    case 'cpu':
      return proc.cpuPercent
    case 'mem':
      return proc.memPercent
    case 'rss':
      return proc.rss
    case 'pid':
      return proc.pid
    case 'name':
      return proc.name.toLowerCase()
  }
}

export interface SysmonController {
  // ---- 数据 ----
  metrics: SystemMetrics | null
  tasks: SystemTaskList | null
  /** 轮询失败的最后一条消息（成功一次就清空） */
  error: string | null
  /**
   * **进程表**还没拿到第一帧（此时表格区显示骨架屏）。
   *
   * 只看 `tasks` —— 它的首帧比指标卡慢得多（要现采），两者的加载态必须分开：
   * 用一个「任意一个为空」的联合判断，会出现「指标卡已经在动、表格却还在骨架」和
   * 「骨架没了但表格是空的」这两种都不对的中间态。
   */
  loading: boolean
  /** 手动刷新（按钮转圈）；自动轮询不会点亮它 */
  refreshing: boolean
  /** 本轮请求在飞（含自动轮询）—— 工具栏那颗小转圈用它 */
  pulling: boolean
  /** 本机收到最后一帧的时刻（判「陈旧」用） */
  lastAt: number | null

  // ---- 轮询控制 ----
  paused: boolean
  setPaused: (next: boolean) => void
  intervalMs: number
  setInterval: (next: number) => void
  refresh: () => Promise<void>

  // ---- 筛选 / 排序 ----
  query: string
  setQuery: (next: string) => void
  sortKey: TaskSortKey
  sortDir: TaskSortDir
  /** 点同一个列头 = 反向；换列 = 该列的默认方向 */
  toggleSort: (key: TaskSortKey) => void
  /** 筛选 + 排序后的行（面板直接 map） */
  rows: SystemTaskProcess[]

  // ---- 动作 ----
  /** 正在结束的 pid（那一行的按钮转圈并禁用） */
  killingPid: number | null
  kill: (request: KillRequest) => Promise<SystemTaskKillResult | null>
}

/**
 * `key` 换了默认方向：数值列（CPU / 内存）默认从大到小，标识列（PID / 名称）默认从小到大。
 * 点第一次就得到「最想看的」，而不是再点一次才反过来。
 */
const DEFAULT_DIR: Record<TaskSortKey, TaskSortDir> = {
  cpu: 'desc',
  mem: 'desc',
  rss: 'desc',
  pid: 'asc',
  name: 'asc'
}

export function useSysmon(): SysmonController {
  const { app } = useAppContext()
  const apiRef = useRef(app.api)
  apiRef.current = app.api
  /** 只在「有没有 api」这件事翻转时才重启轮询（见文件头第 1 条） */
  const hasApi = Boolean(app.api)

  const [metrics, setMetrics] = useState<SystemMetrics | null>(null)
  const [tasks, setTasks] = useState<SystemTaskList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [lastAt, setLastAt] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalState] = useState(loadInterval)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<TaskSortKey>('cpu')
  const [sortDir, setSortDir] = useState<TaskSortDir>('desc')
  const [killingPid, setKillingPid] = useState<number | null>(null)

  const setInterval = useCallback((next: number) => {
    setIntervalState(next)
    if (typeof window !== 'undefined') window.localStorage.setItem(INTERVAL_KEY, String(next))
  }, [])

  /**
   * 取一帧（`silent` = 不点亮刷新按钮，轮询用）。
   *
   * ## 两个请求**各回各的**，不 `await Promise.all` 一起 set
   *
   * 两条通路的耗时差着一个数量级：`/api/system` 读常驻采样器的内存快照（几十毫秒），
   * `/api/system/tasks` 要现起一个 `ps` / PowerShell（600ms~2s）。如果等两个都回来再
   * 一起 `setState`，指标卡会陪着进程表一起干等两秒 —— 明明它的数据早就到了。所以每个
   * 请求各自 `then` 里 set 自己的那份，指标卡与主机条先亮，进程表后到；挂掉一个也不影响
   * 另一个显示。
   *
   * 失败**保留上一帧**：把旧数据换成一片空白，比显示「3 秒前的数」更没用。
   */
  const pull = useCallback(async (silent: boolean): Promise<void> => {
    const api = apiRef.current
    if (!api) return
    if (!silent) setRefreshing(true)
    setPulling(true)

    const metricsTask = api.getSystemMetrics(true).then(
      (next) => {
        setMetrics(next)
        return null
      },
      (err: unknown) => messageOf(err)
    )
    const tasksTask = api.listSystemTasks().then(
      (next) => {
        setTasks(next)
        return null
      },
      (err: unknown) => messageOf(err)
    )

    const [metricsError, tasksError] = await Promise.all([metricsTask, tasksTask])
    // 优先报进程表的错：它才是这一页的主角，指标卡拿不到只是少一块
    setError(tasksError ?? metricsError)
    // 只要有一边真的拿到了，就算「这一轮是新的」
    if (!metricsError || !tasksError) setLastAt(Date.now())
    setPulling(false)
    if (!silent) setRefreshing(false)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    await pull(false)
  }, [pull])

  useEffect(() => {
    if (!hasApi || paused) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      // 页面不可见就只排下一轮（见文件头第 2 条）
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      if (!hidden) await pull(true)
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
    }

    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [hasApi, paused, intervalMs, pull])

  const toggleSort = useCallback((key: TaskSortKey) => {
    setSortKey((current) => {
      if (current === key) {
        setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
        return current
      }
      setSortDir(DEFAULT_DIR[key])
      return key
    })
  }, [])

  const rows = useMemo(() => {
    const list = tasks?.processes ?? []
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? list.filter(
          (proc) =>
            proc.name.toLowerCase().includes(needle) ||
            proc.cmdline.toLowerCase().includes(needle) ||
            proc.user.toLowerCase().includes(needle) ||
            String(proc.pid) === needle
        )
      : list

    const sign = sortDir === 'asc' ? 1 : -1
    // 复制一份再排：`tasks.processes` 是上文的引用，原地 sort 会让 React 看到同一个数组
    return [...filtered].sort((a, b) => {
      const left = sortValueOf(a, sortKey)
      const right = sortValueOf(b, sortKey)
      if (typeof left === 'string' || typeof right === 'string') {
        return String(left).localeCompare(String(right)) * sign
      }
      // 同值再按内存、pid 兜底，保证顺序稳定（否则每帧行会互相跳）
      return (left - right) * sign || b.rss - a.rss || a.pid - b.pid
    })
  }, [tasks, query, sortKey, sortDir])

  const kill = useCallback(
    async (request: KillRequest): Promise<SystemTaskKillResult | null> => {
      const api = apiRef.current
      if (!api) return null
      const { process: proc, mode, tree } = request
      setKillingPid(proc.pid)
      try {
        const result = await api.killSystemTask({ pid: proc.pid, mode, tree })
        if (result.ok) {
          toast.success(
            tree && result.killed.length > 1
              ? `已结束 ${proc.name} 及其 ${result.killed.length - 1} 个子进程`
              : `已结束 ${proc.name}（pid ${proc.pid}）`
          )
        } else {
          toast.error(result.error || `结束 ${proc.name} 失败`)
        }
        // 不管成没成都要重采：失败常常是「进程已经自己退了」，表里那一行也该消失
        await pull(true)
        return result
      } catch (err) {
        toast.error('结束进程失败：' + messageOf(err))
        return null
      } finally {
        setKillingPid(null)
      }
    },
    [pull]
  )

  return {
    metrics,
    tasks,
    error,
    loading: tasks === null && error === null,
    refreshing,
    pulling,
    lastAt,
    paused,
    setPaused,
    intervalMs,
    setInterval,
    refresh,
    query,
    setQuery,
    sortKey,
    sortDir,
    toggleSort,
    rows,
    killingPid,
    kill
  }
}
