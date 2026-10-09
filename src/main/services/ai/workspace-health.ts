/**
 * 工作区目录巡检：登记表里的 `path` 被删 / 被移走时，把 `dirMissing` 标上。
 *
 * ## 为什么需要它
 *
 * 工作区登记表（`storage` 的 `agentWorkspaces`）只在「添加工作区」那一刻 stat 过磁盘，
 * 之后**再也不复查** —— 目录被删了，记录照旧在、侧栏照旧像没事一样，直到用户发一条消息
 * 才撞错（而且错得很难懂：十几个工具各报一句 `ENOENT`，看起来像工具坏了）。
 * 目录被删是**外部事件**（用户在文件管理器里删的、移动硬盘拔了、盘符变了），
 * 应用没有任何回调能感知，只能自己定期问一遍磁盘。
 *
 * ## 为什么不放在渲染端
 *
 * 渲染端查不了磁盘（没有 fs），而且它已经有一份工作区快照 —— 让主进程判定、
 * 判定结果随广播推下去，前端只是「照着画」，一处判据、一处写入。
 *
 * ## 判定
 *
 * `path` 逐个 `stat().isDirectory()`。`path` 为空的登记项跳过（dogi 目前不会出现，
 * 但留着这层判断，免得将来加虚拟工作区时被误判成「目录没了」）。
 *
 * ## 为什么把宿主（list/mark）注入进来，而不是直接 import storage
 *
 * 本模块**不 import 任何 Electron / electron-store 代码**，只依赖注入的两个方法 ——
 * 于是它能被 `scripts/verify-workspace-health.mjs` 直接跑真源码验证（纯 Node，不起 Electron）。
 * 这也是 `tool-output-throttle.ts` 那一类纯模块的老做法。
 *
 * ## 与 fishwork 的差异
 *
 * fishwork 是「服务端巡检 + state ws 推快照」，巡检 mutate 一下所有端自动收到。
 * dogi 是单进程 Electron，没有那层快照推送，所以这里多一个 `onChange` 回调，
 * 由 IPC 层接上 `ctx.broadcast`（见 `ipc/agent.ts`）。其余判据、周期、
 * 「只在翻转时写」的语义与 fishwork 一致。
 */
import { stat } from 'node:fs/promises'
import type { AgentWorkspace } from '@shared/types'

/** 巡检周期。目录被删不是急事，30s 足够「自动」；代价是一轮遍历 + N 次 stat */
const INTERVAL_MS = 30_000

/**
 * 巡检要用的宿主（由 `ipc/agent.ts` 用 `storage` 装配）。
 *
 * 只声明它真正需要的那两件事 —— 接口窄，假实现才好写，也免得将来顺手拿它去改别的东西。
 */
export interface WorkspaceHealthHost {
  /** 当前全部工作区（巡检每一轮都重新取，不能缓存：用户随时可能加 / 删工作区） */
  list(): AgentWorkspace[]
  /** 写标记，返回**是否真的翻转**（没翻转就别广播，见 `applyDirMissing`） */
  mark(id: string, missing: boolean): boolean
}

/**
 * 目录还在不在（`path` 非空时才问；`stat` 失败 / 不是目录都算不在）。
 *
 * **巡检与「发消息」那道校验共用这一份** —— 两处各写一遍 stat，判据迟早会漂
 * （比如一处加了 `isDirectory` 一处忘了，于是「路径存在但是个文件」两边结论相反）。
 */
export async function isWorkspaceDirAvailable(path: string): Promise<boolean> {
  if (!path) return false
  const info = await stat(path).catch(() => null)
  return !!info?.isDirectory()
}

/**
 * 把「目录不在了」这个标记应用到工作区清单上（**纯函数**，不碰磁盘也不碰存储）。
 *
 * 返回**新数组**；**没变化时返回传进来的原数组**（引用不变）—— 调用方据此判断
 * 「要不要落盘 / 要不要广播」，所以这个「引用不变」是接口的一部分，不是实现细节。
 *
 * 三条语义（都由本函数一处保证，别再在调用方各写一遍）：
 * - **幂等**：已经是 missing 再置 true、本来是正常再置 false，都返回原数组。
 * - **不动 `updatedAt`**：这不是用户的改动。侧栏若按它排序，巡检一次列表就会跳一下。
 * - **恢复时删字段**，而不是写 `dirMissing: false`：与 `AgentWorkspace.dirMissing?`
 *   的「只在异常时写入」约定一致，存档里不会攒出一堆无意义的 false。
 */
export function applyDirMissing(
  workspaces: AgentWorkspace[],
  id: string,
  missing: boolean
): AgentWorkspace[] {
  const prev = workspaces.find((w) => w.id === id)
  if (!prev) return workspaces
  if (!!prev.dirMissing === missing) return workspaces
  return workspaces.map((w) => {
    if (w.id !== id) return w
    const { dirMissing: _stale, ...rest } = w
    return missing ? { ...rest, dirMissing: true } : rest
  })
}

/**
 * 跑一轮：只把**变化**写回（`host.mark` 内部就是「没变不写」的语义，见 `applyDirMissing`）。
 * 返回**是否有任何工作区的标记翻转了** —— 调用方据此决定要不要广播。
 */
export async function sweepWorkspaces(host: WorkspaceHealthHost): Promise<boolean> {
  let changed = false
  for (const workspace of host.list()) {
    if (!workspace.path) continue
    const ok = await isWorkspaceDirAvailable(workspace.path)
    // 只在标记真的翻转时才写：每次写都要全量落盘，还会让渲染端重收一份快照
    if (host.mark(workspace.id, !ok)) {
      changed = true
      console.warn(
        `[workspace-health] ${ok ? '目录已恢复' : '目录不存在'}：${workspace.path}（${workspace.name}）`
      )
    }
  }
  return changed
}

let timer: NodeJS.Timeout | null = null
/** 防重入：一轮还没跑完（stat 慢 / 工作区多）时别把下一轮叠上来 */
let sweeping = false

/**
 * 启动巡检（幂等）。先**立刻**扫一遍：否则重启后要等一个周期才发现目录已被删，
 * 而「刚启动」恰恰是最容易发现问题的时刻（关机期间目录被删是常见情形）。
 *
 * `onChange` 只在**标记真的翻转**时调用（一轮里翻转了多个也只调一次）——
 * 目录没变化的那 30s 一轮不该产生任何 IPC 流量。
 */
export function startWorkspaceHealthWatch(
  host: WorkspaceHealthHost,
  onChange?: () => void
): void {
  if (timer) return
  const run = async (): Promise<void> => {
    if (sweeping) return
    sweeping = true
    try {
      if (await sweepWorkspaces(host)) onChange?.()
    } finally {
      sweeping = false
    }
  }
  void run().catch((err: unknown) => console.error('[workspace-health] 首次巡检失败：', err))
  timer = setInterval(() => {
    void run().catch((err: unknown) => console.error('[workspace-health] 巡检失败：', err))
  }, INTERVAL_MS)
  // 别让这个定时器把进程钉住（与 terminal/monitor 的采样器同款）：
  // 巡检只是维护性工作，不该成为「窗口关了进程还不退」的理由
  timer.unref?.()
}

export function stopWorkspaceHealthWatch(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
