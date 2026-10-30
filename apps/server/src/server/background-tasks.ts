/**
 * 后台任务登记表：服务端进程内的一份「正在跑 / 刚跑完」清单。
 *
 * ## 为什么需要它
 *
 * 有些活儿天然耗时长（`git clone` 几秒到十几分钟、以后的批量导入 / 备份同理），让用户的
 * HTTP 请求一直挂着等是最差的选择：切个页面就看不见了、关掉弹窗就等于放弃、网络一抖
 * 还以为挂了。所以这类活**统一登记成任务**：
 *
 * - 任务体在服务端跑，跟「谁在等」彻底解耦；
 * - 等待方（HTTP 路由）只是可选的一方 —— 它可以一直等（`wait()`），也可以
 *   `detach()` 后立刻收包（人不等了，活继续干）；
 * - 进度 / 结果落在 `listBackgroundTasks()` 里，状态栏那一小块 UI 直接渲染。
 *
 * ## 生命周期与边界
 *
 * - **进程内存储**，不落盘：跑在进程里的活本来就活不过进程，重启服务后列表清零是诚实的。
 * - 已结束的任务保留最近 `MAX_FINISHED` 条（状态栏要能显示「刚才那件事成了没」），
 *   更老的自动丢；运行中的永不自动丢。
 * - `cancel()` 会 **await 任务收场**再返回：克隆的取消要等「杀进程 + 删半成品目录」做完，
 *   否则用户点完取消立刻重试同一个目录会撞「目标目录已存在」。
 * - **日志随任务走**：任务体通过 `run(signal, log)` 写行（进度 / 外部命令原文 / 失败原因），
 *   每条最多留 `MAX_LOG_LINES` 行、单行截断到 2k 字符；含 `%` 的进度行**原地覆盖**
 *   上一行（git 的进度条几秒就能刷掉几百行额度）。完整日志走 `getBackgroundTaskDetail`，
 *   列表里只带最新一行（`lastLog`）。
 *
 * ⚠️ 别把「取消」写成「删掉这条任务」：任务要留在列表里显示「已取消」，用户才知道
 * 自己那一下点成功了。
 */
import { randomUUID } from 'node:crypto'
import type {
  BackgroundTaskDetail,
  BackgroundTaskLogLevel,
  BackgroundTaskLogLine,
  BackgroundTaskStatus,
  BackgroundTaskView
} from '@fizz/contracts/agent-api'
import { cleanLogLine } from '@fizz/tools'
import { emitServerEvent } from './state'

/** 已结束的任务最多留这么多条（运行中的不占名额、也不会被挤掉） */
const MAX_FINISHED = 20

/**
 * 每条任务最多留这么多行日志。
 *
 * `git clone` 的进度条能刷上千行（`Receiving objects: 1%…100%`），而人真正要看的是
 * 「现在到哪了 / 最后为什么失败」。留 400 行足够回溯，又不至于把进程内存吃出问题。
 */
const MAX_LOG_LINES = 400

/** 单行上限：git 有时会把整段 help / 脏输出塞进一行，截断比留一坨更难读 */
const MAX_LOG_LINE_CHARS = 2_000

/**
 * 写一行日志。**同步**且不抛 —— 任务体在进程里跑，日志不该成为新的失败点。
 *
 * `level` 缺省 `info`；`warn` / `error` 只是给界面上色用的。
 */
export type BackgroundTaskLogger = (text: string, level?: BackgroundTaskLogLevel) => void

/** 任务体的返回值：`value` 给等待方，`summary` 给任务列表 */
export interface BackgroundTaskOutcome {
  /** 等待方（HTTP 路由）要拿到的原始值 */
  value?: unknown
  /** 列表里展示的结果摘要 */
  summary?: { workspaceId?: string; path?: string }
}

export interface StartBackgroundTaskInput {
  /**
   * 指定 id（调用方已有自己的句柄时必须传，否则它取消不到这条任务）；
   * 缺省随机生成。
   */
  id?: string
  /**
   * 发起它的会话 id。有值 = 这条任务属于那个会话（会话里那块面板只看自己的、
   * 删会话连带停掉）；缺省 = 全局任务（项目页的克隆这类，只出现在状态栏清单里）。
   *
   * ⚠️ 登记后**不可改**：切换 / 改名 / 归档会话都不重新归属，否则任务会在会话之间跳来跳去。
   */
  sessionId?: string
  /** 任务种类，如 `git-clone` */
  kind: string
  /** 一行标题 */
  title: string
  /** 副标题：目标路径这类定位信息 */
  detail?: string
  /**
   * 任务体。`signal` 被 abort 时应当**尽快收场并清理半成品**，然后抛错或返回。
   *
   * `log` 是这条任务专属的日志入口（写进状态栏那张清单，可展开查看）：
   * 慢慢跑的活儿应该把关键节点和外部输出（git 的进度 / 报错原文）写进去 ——
   * 用户看不到「为什么还没好」时，日志就是唯一的解释。
   */
  run: (signal: AbortSignal, log: BackgroundTaskLogger) => Promise<BackgroundTaskOutcome | void>
}

/** 等待结果：任务结束，或等待方主动撤（`detached`） */
export type BackgroundTaskWaitResult =
  | { detached: true }
  | {
      detached: false
      status: BackgroundTaskStatus
      value?: unknown
      error?: string
      /** 失败时的原始异常：路由要按 `ProjectServiceError.status` 回 4xx / 5xx */
      errorObject?: unknown
    }

/** 任务句柄：登记后只通过它读 / 等 / 停，别直接摸内部结构 */
export interface BackgroundTaskHandle {
  id: string
  view: () => BackgroundTaskView
  /**
   * 等结局。`detached: true` 表示**只是等待方撤了**（任务还在跑），
   * 其余情况任务一定已经结束（`status` 为 done / failed / canceled）。
   */
  wait: () => Promise<BackgroundTaskWaitResult>
  /** 取消并**等它收场**（含清理）；已结束的任务不会被打断，直接返回当前视图 */
  cancel: () => Promise<BackgroundTaskView | null>
  /** 转到后台：等待方立刻收包，任务继续 */
  detach: () => void
}

interface Entry {
  id: string
  sessionId?: string
  kind: string
  title: string
  detail?: string
  status: BackgroundTaskStatus
  startedAt: number
  finishedAt?: number
  error?: string
  errorObject?: unknown
  workspaceId?: string
  path?: string
  /** 等待方拿走的原始返回值 */
  value?: unknown
  /** 日志行（上限 MAX_LOG_LINES，超了从最老的丢） */
  logs: BackgroundTaskLogLine[]
  controller: AbortController
  /** 「转到后台」：只让等待方撤，任务继续 */
  detachCtrl: AbortController
  done: Promise<void>
}

const tasks = new Map<string, Entry>()

/**
 * 广播「清单变了」（`backgroundTasks:changed`）。
 *
 * 只是**失效信号**：不带任务本体，各端收到就重拉一次清单 —— 任务输出是高频的，
 * 把内容塞进事件等于把全局状态 WS 变成日志通道。
 *
 * 包一层 try/catch：这里是任务起跑前最后一道，广播失败不该让任务起不来
 * （单测 / 启动早期没有事件总线时同理）。
 */
function notifyChanged(): void {
  try {
    emitServerEvent({ type: 'backgroundTasks:changed' })
  } catch {
    // 事件总线不可用：清单轮询会兜住
  }
}

/** 到点就 resolve 的 promise：`signal` 不 abort 则永不 settle */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/**
 * 「进度行」的归并键：`Receiving objects: 45% (45/100)` 与 `… 90% (90/100)`
 * 抹掉数字、压掉空白后是同一个串 —— 它们说的是同一件事，只保留最新一条。
 *
 * 空白也要归一：git 的进度是**右对齐**的（`  9%` / ` 99%` / `100%`），只抹数字的话
 * 位数一变就成了三个不同的键，进度条又会刷出好几行。
 *
 * 只对含 `%` 的行生效：普通日志（比如连续两条「重试第 N 次」）不该被吃掉。
 */
function progressKey(text: string): string | null {
  if (!text.includes('%')) return null
  return text.replace(/[\d.]+/g, '#').replace(/\s+/g, ' ')
}

function toView(entry: Entry): BackgroundTaskView {
  const last = entry.logs[entry.logs.length - 1]
  return {
    id: entry.id,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    kind: entry.kind,
    title: entry.title,
    ...(entry.detail ? { detail: entry.detail } : {}),
    status: entry.status,
    startedAt: entry.startedAt,
    ...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
    ...(entry.path ? { path: entry.path } : {}),
    cancelable: entry.status === 'running' && !entry.controller.signal.aborted,
    ...(last ? { lastLog: last.text } : {}),
    logCount: entry.logs.length
  }
}

/** 只留最近 MAX_FINISHED 条已结束的（按结束时间倒序丢最老的） */
function prune(): void {
  const finished = [...tasks.values()]
    .filter((e) => e.status !== 'running')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  for (const stale of finished.slice(MAX_FINISHED)) tasks.delete(stale.id)
}

/** 把内部结构包成句柄（登记与查询共用同一份，别写两遍） */
function handleOf(entry: Entry): BackgroundTaskHandle {
  return {
    id: entry.id,
    view: () => toView(entry),
    wait: async () => {
      // 已经 detach 过（或就在这一刻 detach）：别等，直接告诉等待方撤
      const detached = await Promise.race([
        entry.done.then(() => false),
        aborted(entry.detachCtrl.signal).then(() => true)
      ])
      if (detached) return { detached: true }
      return {
        detached: false,
        status: entry.status,
        ...(entry.value !== undefined ? { value: entry.value } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.errorObject ? { errorObject: entry.errorObject } : {})
      }
    },
    cancel: async () => {
      if (entry.status !== 'running') return toView(entry)
      entry.controller.abort()
      await entry.done
      return toView(entry)
    },
    detach: () => {
      if (!entry.detachCtrl.signal.aborted) entry.detachCtrl.abort()
    }
  }
}

/** 登记并**立刻开跑**一条后台任务；返回句柄 */
export function startBackgroundTask(input: StartBackgroundTaskInput): BackgroundTaskHandle {
  const id = input.id?.trim() || randomUUID()
  const entry: Entry = {
    id,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    kind: input.kind,
    title: input.title,
    ...(input.detail ? { detail: input.detail } : {}),
    status: 'running',
    startedAt: Date.now(),
    logs: [],
    controller: new AbortController(),
    detachCtrl: new AbortController(),
    done: Promise.resolve()
  }
  /*
   * 同一个 id 重复登记（旧任务还没收场就又发了一次）：以新任务为准。
   *
   * ⚠️ **覆盖前必须先把旧任务停掉**。`tasks` 是「谁还在跑」的**唯一**登记处，一旦被
   * 新 entry 顶掉，旧 entry 的 controller 就没有任何引用者了 —— 它的进程还活着，但
   * 列表里查不到、界面上点不到、`stopAllRunning()` 也遍历不到，等于凭空多一个
   * 谁也杀不掉的孤儿。随机 UUID 的调用方打不到这条，但 git-clone 这类由渲染端指定
   * id 的路径重复提交一次就会撞上。
   *
   * 只 abort 不 await：这里是同步登记函数，旧任务体的收场（杀进程树 + 清半成品）
   * 由它自己的 `done` 链走，新任务不该被它拖住。
   */
  const previous = tasks.get(id)
  if (previous && previous.status === 'running' && !previous.controller.signal.aborted) {
    previous.controller.abort()
  }
  tasks.set(id, entry)
  // 先广播再起跑：会话里的面板要能立刻看到这一行（不必等它产出第一行日志）
  notifyChanged()

  /**
   * 写一行日志：剥 ANSI → 裁剪单行长度 → 进度行原地替换 → 追加 → 裁掉超量的老行。
   *
   * 剥 ANSI 放在最前面：外部命令哪怕走的是管道也会带颜色（`npm run` 注入 `FORCE_COLOR`，
   * dev server 的启动横幅就是 `\u001b[32m➜\u001b[39m…`），而日志面板是**纯文本渲染**，
   * 不剥就会原样显示 `[32m➜[39m`。只有转义的行剥完是空的，正好一起丢掉 —— 那是清行 /
   * 光标移动，纯文本里等于空行。规则见 `@fizz/tools` 的 `ansi.ts`。
   *
   * 进度行替换这一步是必需的：`git clone --progress` 在 `\r` 上反复刷同一行，
   * 不归并的话 400 行的额度几秒就被一个进度条吃光，真正的报错反而被挤掉。
   */
  const log: BackgroundTaskLogger = (text, level = 'info') => {
    const trimmed = cleanLogLine(String(text ?? ''))
    if (!trimmed) return
    const clipped =
      trimmed.length > MAX_LOG_LINE_CHARS ? `${trimmed.slice(0, MAX_LOG_LINE_CHARS)}…` : trimmed
    const last = entry.logs[entry.logs.length - 1]
    if (last) {
      const nextKey = progressKey(clipped)
      if (nextKey !== null && progressKey(last.text) === nextKey) {
        last.text = clipped
        last.at = Date.now()
        last.level = level
        return
      }
    }
    entry.logs.push({ at: Date.now(), level, text: clipped })
    if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES)
  }

  entry.done = (async () => {
    try {
      const outcome = (await input.run(entry.controller.signal, log)) ?? {}
      // 取消与「恰好跑完」撞一起时按取消算：被要求 abort 之后的结果不能当成功
      entry.status = entry.controller.signal.aborted ? 'canceled' : 'done'
      entry.value = outcome.value
      entry.workspaceId = outcome.summary?.workspaceId
      entry.path = outcome.summary?.path
      // 先落状态再写终局行，顺序看着才对（日志面板里「完成」永远是最后一行）
      log(
        outcome.summary?.path ? `完成 → ${outcome.summary.path}` : '完成',
        'info'
      )
    } catch (err) {
      // 被 abort 的任务体抛什么都归「已取消」：那是用户按的，不是故障
      if (entry.controller.signal.aborted) {
        entry.status = 'canceled'
      } else {
        entry.status = 'failed'
        entry.error = err instanceof Error ? err.message : String(err)
        entry.errorObject = err
        log(`失败：${entry.error}`, 'error')
      }
    } finally {
      // 取消的收尾话术保持通用（这张表不只服务克隆，别替任务体承诺它做过什么清理）
      if (entry.status === 'canceled') log('已取消', 'warn')
      entry.finishedAt = Date.now()
      prune()
      // 收场（成功 / 失败 / 取消）都要广播：会话里那一行要变成终态、并开始算优雅窗口
      notifyChanged()
    }
  })()

  return handleOf(entry)
}

/** 列表：**运行中的排在前面**，同组按开始时间倒序（新活的在最上面） */
export function listBackgroundTasks(): BackgroundTaskView[] {
  return [...tasks.values()]
    .sort((a, b) => {
      const running = Number(b.status === 'running') - Number(a.status === 'running')
      return running !== 0 ? running : b.startedAt - a.startedAt
    })
    .map(toView)
}

/** 取句柄（不存在返回 null） */
export function getBackgroundTask(id: string): BackgroundTaskHandle | null {
  const entry = tasks.get(id)
  return entry ? handleOf(entry) : null
}

/**
 * 单条任务的详情：任务本体 + **保留的**日志行（时间升序，最新在最后）。
 *
 * 单独一条接口而不是塞进列表：列表每 2s 轮询一次，日志只有用户点开某一行时才有人看，
 * 塞进列表等于每次轮询都白传几十 KB。
 */
export function getBackgroundTaskDetail(id: string): BackgroundTaskDetail | null {
  const entry = tasks.get(id)
  if (!entry) return null
  // 复制一份再回：日志数组是活的，序列化过程中还可能被任务体追加
  return { task: toView(entry), logs: entry.logs.map((line) => ({ ...line })) }
}

/** 取消一条任务并等它收场；任务不存在返回 null */
export async function cancelBackgroundTask(id: string): Promise<BackgroundTaskView | null> {
  const handle = getBackgroundTask(id)
  if (!handle) return null
  return await handle.cancel()
}

/**
 * 停掉某个会话名下**所有**还在跑的任务，返回停了几条（删会话时调）。
 *
 * **只发信号、不等收场**：删除路径不能因为某条任务杀不掉而失败，也不能等它慢慢收尾
 * （那条会话马上就要从侧栏消失，用户不该盯着一个转圈等）。任务体自己负责尽快收场。
 *
 * ⚠️ **归档不调这个**：归档是可逆标记，杀进程是不可逆的副作用。只有真删除才停。
 */
export function stopSessionRunning(sessionId: string): number {
  let stopped = 0
  for (const entry of tasks.values()) {
    if (entry.sessionId !== sessionId) continue
    if (entry.status !== 'running') continue
    if (entry.controller.signal.aborted) continue
    entry.controller.abort()
    stopped += 1
  }
  return stopped
}

/**
 * 停掉**所有**还在跑的后台任务（进程退出前调），返回停了几条。
 *
 * 为什么必须有这一步：后台命令是 `detached` 起的（自成进程组，`kill(-pid)` 才能一次
 * 带走 `npm run` 派生出来的整棵树），代价是**父进程退出它们不会跟着退**。不停的话，
 * 用户下次开机就会看到一堆占着端口的孤儿 dev server —— 而且再也关不掉了：登记表已经
 * 随进程消失，没有任何界面能停它们。
 *
 * 与 `stopSessionRunning` 同一口径：只发信号、不等收场（退出流程不该被一条杀不掉的
 * 进程拖住，宽限由 `shutdown` 的超时兜底）。
 */
export function stopAllRunning(): number {
  let stopped = 0
  for (const entry of tasks.values()) {
    if (entry.status !== 'running') continue
    if (entry.controller.signal.aborted) continue
    entry.controller.abort()
    stopped += 1
  }
  return stopped
}

/** 转到后台；任务不存在返回 null */
export function detachBackgroundTask(id: string): BackgroundTaskView | null {
  const handle = getBackgroundTask(id)
  if (!handle) return null
  handle.detach()
  return handle.view()
}

/** 关掉一条**已结束**的任务；还在跑的关不掉（返回 false，调用方回 409） */
export function dismissBackgroundTask(id: string): boolean {
  const entry = tasks.get(id)
  if (!entry || entry.status === 'running') return false
  tasks.delete(id)
  return true
}

/** 清掉全部已结束的任务 */
export function clearFinishedBackgroundTasks(): void {
  for (const entry of [...tasks.values()]) {
    if (entry.status !== 'running') tasks.delete(entry.id)
  }
}
