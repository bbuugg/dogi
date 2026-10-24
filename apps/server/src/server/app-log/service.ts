/**
 * 应用日志的**读取与订阅**：把 `@fizz/workspace` 的 logger 单例包成契约要求的形状。
 *
 * 应用日志的真源**就在本进程内存**（`appLog` 单例，同时落盘），
 * 所以订阅不需要轮询读盘，直接听 logger 的 `entry` 事件即可 —— 没有 500ms 的延迟，
 * 也没有 N 个订阅者 N 次 `stat` 的开销。
 */
import { appLog, appLogNamespaces, appLogUnregisteredScopes, clearTerminalLogs } from '@fizz/workspace'
import type { AppLogFrame, AppLogResult } from '@fizz/contracts/agent-api'

/** 当前全量快照（`GET /api/app-log` 的应答） */
export function appLogSnapshot(): AppLogResult {
  const entries = appLog.list()
  return {
    entries,
    maxSeq: entries.length > 0 ? entries[entries.length - 1]!.seq : 0,
    namespaces: appLogNamespaces().map((ns) => ({ id: ns.id, label: ns.label })),
    unregistered: appLogUnregisteredScopes(),
    directory: appLog.directory()
  }
}

/**
 * 清空（内存 + 落盘），返回清空后的快照（前端一次请求就能拿到新状态）。
 *
 * **终端会话文件（`logs/terminal/`）一并清掉** —— 它只是同一条终端日志链路的另一种落盘形态，
 * 只清 `app.log` 会留下「日志面板空了、磁盘上却还有一堆会话文件」的矛盾状态（dogi 的
 * `logs:clear` 也是连 `logs/sessions/` 一起删）。仍在写入的会话文件可能删不掉（Windows），
 * `clearTerminalLogs` 内部尽力而为。
 */
export async function clearAppLog(): Promise<AppLogResult> {
  appLog.clear()
  await clearTerminalLogs()
  return appLogSnapshot()
}

export interface AppLogSink {
  send(frame: AppLogFrame): void | Promise<void>
  close(): void
}

/**
 * 订阅 `since` 之后的新日志。返回**退订函数**（客户端断开时必须调，否则监听器会越积越多）。
 *
 * `since` 是客户端已经拿到的最大 seq —— 只推它之后的新条目，避免重连时整段回放。
 * 同 seq 的条目会被再次推送（logger 的 `update()` 语义 = 该条被就地更新），
 * 前端按 seq 覆盖即可。
 */
export function subscribeAppLog(since: number, sink: AppLogSink): () => void {
  // 待推送但尚未写出的条目：把「一次 tick 里的多条」合并成一帧，别一条一帧刷爆链路
  let buffer: AppLogResult['entries'] = []
  /**
   * 串行化的写出链路：`flush` 只能有一个在跑（`sink.send` 是 await 的）。
   *
   * 不能只用一个 `flushing` 布尔 + 递归：`await` 期间新来的条目会 push 进 buffer，
   * 而递归那一次读的是**已经换新的** buffer，两条链会同时 `send` 同一批 —— 帧顺序
   * 就乱了（前端按 seq 覆盖，乱序会让旧条目盖掉新条目）。
   */
  let chain: Promise<void> = Promise.resolve()
  let closed = false

  const flush = (): void => {
    if (closed) return
    chain = chain.then(async () => {
      if (closed || buffer.length === 0) return
      const entries = buffer
      buffer = []
      try {
        await sink.send({ type: 'append', entries })
      } catch {
        // 写不出去（连接没了）：交给 cancel 路径收场
      }
    })
  }

  /**
   * 订阅起点：**只推 `seq > since` 的条目**。
   *
   * ⚠️ 必须是严格大于、且判断只做一次（不随后续条目推进）：`appLog.update()` 会用
   * **同一个 seq** 再次广播（增量回填语义），那次推送**必须放行** —— 若拿「已推过的最大
   * seq」当下界，回填就会被静默吞掉，前端永远看不到长任务的输出。
   */
  const since0 = Number.isFinite(since) ? Math.trunc(since) : 0

  const onEntry = (entry: AppLogResult['entries'][number]): void => {
    if (closed || entry.seq <= since0) return
    buffer.push(entry)
    flush()
  }

  appLog.on('entry', onEntry)

  return (): void => {
    closed = true
    appLog.off('entry', onEntry)
    buffer = []
  }
}
