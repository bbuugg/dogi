/**
 * 应用日志面板的状态：全量拉取一次 + SSE 订阅增量。
 *
 * ## 为什么是一份模块级单例（而不是 React state / zustand slice）
 *
 * 面板是**主区域的一条全局单例标签**（`logs:list`），关掉再打开要立刻看到之前的日志、
 * 不能从头再拉一遍；而它又完全不参与 `app` 的全局刷新清单（`refresh()` 拉的是工作区 /
 * 会话 / 模型这些）。放进全局 store 会让「日志到达」触发整个应用重渲染
 * （`AppProvider` 订阅的是整个 store，不带选择器）—— 每来一条日志重渲染一次全树。
 *
 * 所以：模块级 `useSyncExternalStore` 单例，只有挂载中的面板订阅它。
 *
 * ## 订阅的生命周期
 *
 * `acquire()` / `release()` 引用计数：面板挂载时 acquire（0 → 1 时拉全量 + 开 SSE），
 * 卸载时 release（1 → 0 时 abort SSE）。这样「面板被切到后台标签」时连接会断，
 * 切回来立刻重连并从 `maxSeq` 续读，不会丢日志也不会常驻一条没用的连接。
 *
 * ⚠️ 与其他 `useSyncExternalStore` 单例（`activity-state` / `mobile-sidebar`）不同，这里
 * **不落盘**：日志是服务端的事实，本地缓存一份到 localStorage 只会在跨端时显示陈旧数据。
 */
import type { AppLogEntry, AppLogFrame, AppLogNamespace } from '@fizz/contracts/agent-api'
import type { AgentApi } from '@fizz/agent-client/api'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'

/** 客户端本地最多留多少条（与服务端环形缓冲同值）—— 只用来防「面板开着很久」时无限增长 */
const MAX_ENTRIES = 1000

export interface LogsState {
  /** 已加载的日志（按 seq 升序） */
  entries: AppLogEntry[]
  /** 服务端注册的命名空间（Tab 列表） */
  namespaces: AppLogNamespace[]
  /** 出现过但没注册的命名空间（兜底 Tab） */
  unregistered: string[]
  /** 落盘日志文件所在目录（server 那台机器上的绝对路径；未落盘为空串） */
  directory: string
  /** 首次拉取是否完成（未完成时显示骨架，而不是「没有日志」） */
  loaded: boolean
  /** 连接状态：拉取中 / 已连上 / 断开 */
  status: 'idle' | 'loading' | 'live' | 'error'
  /** 断开时的原因（状态条显示） */
  error: string | null
}

const EMPTY: LogsState = {
  entries: [],
  namespaces: [],
  unregistered: [],
  directory: '',
  loaded: false,
  status: 'idle',
  error: null
}

let state: LogsState = EMPTY
const listeners = new Set<() => void>()

function setState(patch: Partial<LogsState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLogsState(): LogsState {
  return state
}

/** 服务端快照的最大 seq —— SSE 订阅起点（只推它之后的，重连不整段回放） */
function maxSeqOf(entries: AppLogEntry[]): number {
  return entries.length > 0 ? entries[entries.length - 1]!.seq : 0
}

/**
 * 取全局 API 客户端（带 token 与宿主桥）。
 *
 * ⚠️ **不要**在这里自己 `createApi()`：那个客户端的传输层是宿主注入的（web 是
 * `globalThis.fetch`，desktop 是 preload 的 IPC 桥），而鉴权头要靠 store 里当前连接的
 * token —— 自建的那个既拿不到 token 也拿不到宿主桥（`fetchImpl` 的默认值 `hostFetch`
 * 虽然认宿主，但 token 只能从 `connection` 拿）。未连接时返回 null，由调用方显示错误。
 */
function getApi(): AgentApi | null {
  return useAgentStore.getState().getApi()
}

let refCount = 0
let abort: AbortController | null = null
let starting = false

/** 拉全量 + 开订阅（引用计数为 0→1 时调用） */
async function start(): Promise<void> {
  if (starting) return
  const api = getApi()
  if (!api) {
    // 还没连上服务端：不是错误，等连接建立后用户再打开面板即可
    setState({ loaded: true, status: 'error', error: '尚未连接到服务端' })
    return
  }
  starting = true
  setState({ status: state.loaded ? state.status : 'loading', error: null })
  try {
    const snapshot = await api.listAppLog()
    setState({
      entries: snapshot.entries,
      namespaces: snapshot.namespaces,
      unregistered: snapshot.unregistered,
      directory: snapshot.directory,
      loaded: true,
      status: 'live'
    })
    starting = false
    void subscribe(snapshot.maxSeq)
  } catch (err) {
    starting = false
    setState({
      loaded: true,
      status: 'error',
      error: err instanceof Error ? err.message : '日志加载失败'
    })
  }
}

/**
 * 订阅增量。
 *
 * ⚠️ `signal` 必须传到 `streamAppLog`：这是**永续流**（没有 `end` 帧），
 * 不收就永远挂着 —— 桌面端是长驻进程，反复开关面板会累积连接。
 */
async function subscribe(since: number): Promise<void> {
  const api = getApi()
  if (!api) return
  abort?.abort()
  const controller = new AbortController()
  abort = controller
  try {
    await api.streamAppLog(since, applyFrame, controller.signal)
    // 正常返回 = 连接被服务端关掉：标成断开，等下一次 acquire 或手动重连
    if (!controller.signal.aborted) {
      setState({ status: 'error', error: '连接已断开' })
    }
  } catch (err) {
    if (controller.signal.aborted) return
    setState({
      status: 'error',
      error: err instanceof Error ? err.message : '日志订阅中断'
    })
  }
}

/** 把一帧增量并进缓冲：**按 seq 覆盖**（同 seq 重复 = 该条被就地更新，见 logger.update） */
function applyFrame(frame: AppLogFrame): void {
  if (frame.type === 'clear') {
    setState({ entries: [] })
    return
  }
  if (frame.entries.length === 0) return
  const bySeq = new Map(state.entries.map((e) => [e.seq, e]))
  for (const entry of frame.entries) bySeq.set(entry.seq, entry)
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  setState({ entries: entries.slice(-MAX_ENTRIES) })
}

/** 面板挂载：0 → 1 时启动（已有数据则只重连订阅，不重拉全量） */
export function acquireLogs(): void {
  refCount += 1
  if (refCount > 1) return
  if (state.loaded && state.status !== 'error') {
    // 之前加载过：直接续订阅（since = 本地最大 seq），省掉一次全量拉取
    setState({ status: 'live', error: null })
    void subscribe(maxSeqOf(state.entries))
    return
  }
  void start()
}

/** 面板卸载：1 → 0 时断开订阅 */
export function releaseLogs(): void {
  refCount = Math.max(0, refCount - 1)
  if (refCount > 0) return
  abort?.abort()
  abort = null
}

/** 手动重连（状态条上的「重试」） */
export function retryLogs(): void {
  if (refCount === 0) return
  if (!state.loaded) {
    void start()
    return
  }
  setState({ status: 'live', error: null })
  void subscribe(maxSeqOf(state.entries))
}

/** 清空（服务端 + 本地）。清空后服务端的 seq 继续递增，本地缓冲清零不影响后续订阅 */
export async function clearLogs(): Promise<void> {
  const api = getApi()
  if (!api) return
  const snapshot = await api.clearAppLog()
  setState({
    entries: snapshot.entries,
    namespaces: snapshot.namespaces,
    unregistered: snapshot.unregistered,
    directory: snapshot.directory
  })
}
