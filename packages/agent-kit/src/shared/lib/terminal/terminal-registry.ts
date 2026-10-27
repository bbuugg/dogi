/**
 * 渲染端**终端登记表**：把「用户正在看的终端」暴露给 AI 工具层。
 *
 * ## 为什么需要它（而不是服务端直接操作终端）
 *
 * 终端进程在**服务端**（SSH 会话 / 本机 PTY），但服务端**没有活会话注册表** ——
 * 会话 id 是每次连接现生成的，只绑在自己那条 WebSocket 上，服务端拿不到「用户现在
 * 看着的是哪台终端」。而渲染端两样都有：xterm 实例（滚动缓冲）+ `TerminalProcess`
 * （写入口）。所以「AI 操作终端」这件事由**渲染端**执行，登记表就是那个入口。
 *
 * ## 只活在内存里
 *
 * 与 `tool-tabs.ts` 同一口径：这是「这一次打开的样子」，刷新即空。`TerminalPanel`
 * 在挂载时登记、卸载时摘掉（见那里的 effect）。
 */
import type { TerminalProcess } from '@fizz/agent-client/host'

export interface TerminalHandle {
  /** 主区域标签 key（`host:<id>#<seq>` / `local:<n>`），也是工具里的 `sessionId` */
  tabKey: string
  /** 展示名（标签名 / 主机名） */
  title: string
  /** ssh = 远端主机终端；local = 本机终端；container = 容器工作台 */
  kind: 'ssh' | 'local' | 'container'
  /** 读最近输出（含滚动缓冲），返回已剥掉 ANSI 控制序列的纯文本 */
  read(maxChars?: number): string
  /** 把原始输入写进 PTY（等同于用户在键盘上敲） */
  write(data: string): void
  /**
   * 把键盘焦点落到这条终端上（光标进 xterm，用户可以接着敲）。
   *
   * 给「命令面板就地跑完脚本」这类**替用户发起了动作**的入口用：动作结束后焦点该回到
   * 用户刚才待着的地方，而不是留在已经关掉的弹窗 / body 上。时机（要不要等弹窗退场）
   * 由调用方决定，见 `features/scripts/run-script-command.ts`。
   */
  focus(): void
  /** 底层进程是否还活着（false = 已退出，工具该拒绝而不是静默丢弃） */
  isAlive(): boolean
  /**
   * 输出活动计数：每收到一段 PTY 数据 +1（含命令回显）。
   *
   * 给 `run_in_terminal` 判「这条命令还在往外吐东西吗」用 —— 轮询只读这个数，
   * 不去 `read()` 整段缓冲（那个是 O(缓冲长度)，大缓冲上每 100ms 读一遍并不便宜）。
   */
  outputSeq(): number
  /**
   * 最后一次收到输出的时间（`Date.now()` 毫秒；这条终端还没输出过 = 0）。
   *
   * 与 {@link outputSeq} 一起构成「安静了多久」这个信号：输出停下来就是命令大概率跑完了，
   * 比固定 sleep 一个猜的时长准得多。
   */
  lastOutputAt(): number
  /**
   * 累计输出偏移：这条终端**建立以来收到的全部输出**的字符数（含已经滚出屏幕 / 缓冲的部分）。
   *
   * 与 {@link outputSeq} 分工：seq 只回答「还在不在动」，offset 用来取「从那之后的新输出」。
   *
   * ⚠️ 取增量**必须**用它，不能拿 xterm 缓冲的长度做差：滚动缓冲只有 1000 行，长任务
   * 几秒就顶满，之后长度不再增长（旧行被顶掉），按长度做差得到的是无意义的碎片 ——
   * 工具回一句「没捕获到新输出」，模型就会连读（用户看到的「快速不停地读取」）。
   */
  outputOffset(): number
  /**
   * 取 `since`（一次 {@link outputOffset} 的返回值）之后收到的输出，已剥掉 ANSI、
   * `\r` 统一成换行。
   *
   * `truncated: true` = 起点已经滚出环形缓冲，返回的是**还能拿到的那部分**（调用方
   * 据此告诉模型「前面丢了」）；`offset` 是取完之后的累计偏移，可以直接作为下一次的 `since`。
   */
  readSince(since: number): { text: string; offset: number; truncated: boolean }
}

const terminals = new Map<string, TerminalHandle>()
/** 最近一次「被看着」的终端（`visible` 的 TerminalPanel 自报）—— 全局助手的目标缺省 */
let activeTabKey: string | null = null

export function registerTerminal(handle: TerminalHandle): void {
  terminals.set(handle.tabKey, handle)
}

export function unregisterTerminal(tabKey: string): void {
  terminals.delete(tabKey)
  if (activeTabKey === tabKey) activeTabKey = null
}

export function getTerminal(tabKey: string): TerminalHandle | undefined {
  return terminals.get(tabKey)
}

/** 列出所有登记在册的终端（工具 `list_terminal_sessions` 用） */
export function listTerminals(): TerminalHandle[] {
  return [...terminals.values()]
}

/**
 * 按标签 key 取一条**可以往里写**的终端：登记在册 + 不是容器 + 进程还活着。
 *
 * 给「命令面板就地运行脚本」用（见 `features/scripts/run-script-command.ts`）：那个入口
 * 的语义是「**当前视图就是终端，脚本直接在这条终端里跑**」，所以它要的不是「某台主机
 * 有没有终端」，而是「顶在这一格的那条终端还能不能写」。
 *
 * 三条拒绝的理由：
 * - 没登记 = 那条标签还没有 `TerminalPanel` 实例（或在别的设备上开着），写进去会静默丢；
 * - `container` = 容器工作台那条纯文本通道，脚本是「主机侧」的东西，写错地方比不写更糟；
 * - `isAlive()` 为假 = 进程已退出 / 正在重连，写进去没人接。
 *
 * ⚠️ 这里**不判断「终端忙不忙」**：xterm 侧看不出远端前台进程，靠输出活跃度猜会误判
 * （`tail -f`、构建日志都在刷）。活着就写 —— 用户看得见那条终端正在显示什么。
 */
export function liveTerminal(tabKey: string | null | undefined): TerminalHandle | null {
  if (!tabKey) return null
  const handle = terminals.get(tabKey)
  if (!handle || handle.kind === 'container' || !handle.isAlive()) return null
  return handle
}

/**
 * 把键盘焦点落到某条终端上（那条终端没登记 = 什么都不做）。
 *
 * 只负责「调一下句柄」这一件事：**什么时候**落焦点是调用方的判断 —— 命令面板那种
 * Radix 对话框会在退场结束后把焦点还给「打开前的元素」，太早落会被它拿走，
 * 所以那里还得补一拍（见 `features/scripts/run-script-command.ts`）。
 */
export function focusTerminal(tabKey: string): void {
  terminals.get(tabKey)?.focus()
}

/** 某条终端自报「我现在被看着」（可见性变化时调用） */
export function setActiveTerminal(tabKey: string | null): void {
  activeTabKey = tabKey
}

export function getActiveTerminalTabKey(): string | null {
  return activeTabKey
}

/**
 * 解析一次工具调用的目标终端：**显式指定 > 本轮绑定 > 当前被看着的那条**。
 *
 * 与 dogi 的 `resolveTarget` 同一条优先级；差别是这里没有服务端的「活跃会话」，
 * 只有渲染端的「被看着的那条」。
 */
export function resolveTerminal(
  boundTabKey: string | null | undefined,
  explicitSessionId?: string
): TerminalHandle | null {
  const key = explicitSessionId || boundTabKey || activeTabKey
  if (!key) return null
  return terminals.get(key) ?? null
}

/** 终端进程类型（工具里回给模型看，用于判断命令语法） */
export function kindLabel(kind: TerminalHandle['kind']): string {
  if (kind === 'ssh') return 'SSH 远端主机'
  if (kind === 'container') return '容器工作台'
  return '本机'
}

/** 供 TerminalPanel 复用：把一个 `TerminalProcess` 包成写入口 */
export function writeVia(process: TerminalProcess | null): (data: string) => void {
  return (data: string) => process?.write(data)
}
