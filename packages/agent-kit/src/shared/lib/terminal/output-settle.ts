/**
 * 「等命令输出安静下来」的判定（`run_in_terminal` / `read_terminal_output` 用）。
 *
 * ## 为什么不再固定 sleep
 *
 * 一条 `ls` 几十毫秒就完了，固定等 3 秒纯属白等；一条 `npm test` 跑 40 秒，固定等 3 秒
 * 也只能拿到半截，还得靠模型再补一次 `read_terminal_output`。真正想要的信号是
 * **输出停下来了**：一停就返回，停不下来就到上限。
 *
 * ## 为什么不按「看到 shell 提示符」判
 *
 * 提示符是用户自己配的（`$` / `%` / `#` / `❯` / 自定义 PS1 / SSH 远端 / PowerShell），
 * 按模式猜必然误判；「安静了 idleMs」是所有终端都成立的弱信号。代价是**安静 ≠ 跑完**：
 * 命令中途停顿超过 idleMs 就会提前返回，所以工具说明里让模型看末尾有没有提示符。
 *
 * ## 为什么 idleMs 可以随时间放大
 *
 * 固定的 600ms 对 `ls` 刚好，对**长任务**（构建 / 安装 / 编译）太短 —— 它们本来就
 * 一顿一顿地打日志，一两秒的间隙是常态，600ms 一判就「提前收工」，模型于是以为跑完了，
 * 转头去 `read_terminal_output` 反复读（用户看到的「快速不停地读取」）。所以 idleMs
 * 允许传一个**随已等待时长变化**的函数：前几秒用短窗口保快命令的灵敏度，跑久了换成
 * 长窗口，让停顿不再被误判成结束。
 *
 * ## 只读计数，不读缓冲
 *
 * 判活只看 `outputSeq` / `lastOutputAt` 两个数 —— `read()` 是 O(缓冲长度)（要把整个
 * scrollback 逐行 `translateToString`），每次轮询都读一遍在大缓冲上并不便宜。
 */
export interface OutputProbe {
  /** 单调递增的输出计数（每收到一段 PTY 数据 +1） */
  outputSeq(): number
  /** 最后一次收到输出的时间戳（`Date.now()` 毫秒）；从没输出过 = 0 */
  lastOutputAt(): number
}

export interface SettleOptions {
  /**
   * 输出安静多久算「停了」。
   *
   * 传函数 = 按**已等待时长**现算（长任务用放大后的窗口，见文件头）。
   */
  idleMs: number | ((elapsedMs: number) => number)
  /** 总等待上限（原来的 `waitMs` 语义，现在是**上限**而不是固定等待） */
  maxMs: number
  /** 轮询间隔：只读两个数，可以很小 */
  pollMs?: number
  /** 时钟（测试注入用） */
  now?: () => number
}

/** `idle` = 输出安静下来了；`timeout` = 到上限还在输出 / 一直没输出 */
export type SettleReason = 'idle' | 'timeout'

const DEFAULT_POLL_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 等到「基线之后有过输出，且之后安静了 `idleMs`」或「总共等了 `maxMs`」。
 *
 * `baselineSeq` 必须在**写命令之前**取：写进去之后 shell 会先回显命令，那次回显本身
 * 就是一段输出 —— 所以「有输出」几乎立刻成立，真正在等的是它之后的安静期。
 */
export async function waitForOutputToSettle(
  probe: OutputProbe,
  baselineSeq: number,
  { idleMs, maxMs, pollMs = DEFAULT_POLL_MS, now = Date.now }: SettleOptions
): Promise<SettleReason> {
  const startedAt = now()
  // `maxMs <= 0`（调用方显式要 0）就别等了：直接按超时收场，行为与从前的 `sleep(0)` 一致
  while (true) {
    const at = now()
    const elapsed = at - startedAt
    const idle = typeof idleMs === 'function' ? idleMs(elapsed) : idleMs
    if (probe.outputSeq() > baselineSeq && at - probe.lastOutputAt() >= idle) return 'idle'
    if (elapsed >= maxMs) return 'timeout'
    // 最后一跳不要睡过头：剩余时间比 pollMs 短就按剩余时间睡
    await sleep(Math.min(pollMs, maxMs - elapsed))
  }
}

export interface NewOutputOptions {
  /** 等多久还没新输出就放弃 */
  maxMs: number
  pollMs?: number
  now?: () => number
}

/**
 * 只等「基线之后**出现过新输出**」，不要求它安静下来。
 *
 * 给 `read_terminal_output` 的第一阶段用：终端本来就一动不动时（命令早跑完了 / 模型
 * 只是想看一眼屏幕），不该陪着干等满 `waitMs` —— 等一小会儿没动静就按「没有新输出」返回。
 */
export async function waitForNewOutput(
  probe: OutputProbe,
  baselineSeq: number,
  { maxMs, pollMs = DEFAULT_POLL_MS, now = Date.now }: NewOutputOptions
): Promise<boolean> {
  const startedAt = now()
  while (true) {
    if (probe.outputSeq() > baselineSeq) return true
    const elapsed = now() - startedAt
    if (elapsed >= maxMs) return false
    await sleep(Math.min(pollMs, maxMs - elapsed))
  }
}
