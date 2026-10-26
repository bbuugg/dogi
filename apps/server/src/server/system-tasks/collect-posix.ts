/**
 * POSIX（Linux / macOS）的进程表：一次 `ps`，外加一次 `/proc/net/dev`（仅 Linux）。
 *
 * ## 参数为什么长这样
 *
 * ```
 * ps -ww -e -o pid,ppid,user,rss,stat,time,args
 * ```
 *
 * - `-ww`：**不按终端宽度截断**命令行。不加的话 `args` 会被切到 80 列，几个 node 进程
 *   看起来一模一样（都是 `node /app/ind…`），而「哪个 node 是我要杀的那个」全靠这截。
 * - `pid,ppid,user,rss,stat,time,args` 顺序固定：前 6 列都是**不含空格**的字段，
 *   `args` 放最后 —— 这样一条正则就能切完，不必猜「命令行里有没有空格」。
 * - 刻意**不要 `comm`**：macOS 的 `comm` 是 exec 时的名字，可能带空格
 *   （`Google Chrome Helper (Renderer)`），放中间会把后面所有列挤歪。进程名改由
 *   `args` 首段的 basename 得到（见 `exeNameOf`），和 htop 的「命令」列一个口径。
 * - 不加 `=` 抑制表头：BSD 系 ps 对 `pid=` 这种写法支持不一致，而表头那一行的第一列是
 *   `PID`（不是数字），解析时天然会被跳过。
 *
 * ## 拿不到的字段
 *
 * - **瞬时 CPU**：`ps` 只给累计时间（`time` 列），差值在 `index.ts` 里算。
 * - **网速**：`ps` 完全没有，Linux 另读 `/proc/net/dev`（纯文件读，零成本）；macOS 需要
 *   再起一个 `netstat`，为一张小卡片多开一个进程不划算 —— 那边 `net` 就是 null。
 *
 * ## Linux 上还要再读一遍 `/proc/<pid>/stat`（精度问题，别删）
 *
 * `ps -o time` 在 **Linux 上只精确到整秒**（输出 `HH:MM:SS`）。而瞬时占用 = 累计时间差 ÷
 * 采样间隔，间隔通常才 3 秒 —— 量化到 1 秒，误差就是 ±33%：一个真占 50% 的进程会显示成
 * 33% 或 66%，而且每帧乱跳。macOS 的 `time` 带百分秒（`MM:SS.cc`），没有这个问题。
 *
 * 所以 Linux 读完 `ps` 之后，再逐个从 `/proc/<pid>/stat` 取 `utime + stime`（单位是
 * USER_HZ 滴答，10ms 一粒）覆盖掉那个整秒值：3 秒窗口下误差降到 ±0.3%。读不到的
 * （进程刚好退出 / 无权限）就保留 `ps` 的值 —— 有总比没有好。
 */
import { readFile } from 'node:fs/promises'
import type { RawProcess, RawSnapshot } from './raw'
import { CollectError, exeNameOf, parseCpuTime, runCapture } from './raw'

const PS_ARGS = ['-ww', '-e', '-o', 'pid,ppid,user,rss,stat,time,args'] as const

/**
 * Linux 的时钟滴答频率（USER_HZ）。
 *
 * 自 2.6 起内核在常见架构上把它**固定为 100**（`include/asm-generic/param.h` 的
 * `USER_HZ`），不再随 `CONFIG_HZ` 变。所以不必去 sysconf 查 —— Node 也没有这个接口。
 */
const USER_HZ = 100

/**
 * 一条 `ps` 输出行。
 *
 * 分组：pid / ppid / user / rss(KB) / stat / time / args（可为空 —— 内核线程）。
 * 表头行（`  PID  PPID USER ...`）与任何解析不了的行都会被丢掉，不会污染结果。
 */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/

/**
 * 解析 `ps` 的 stdout。**导出是为了能单测** —— 这里的错法都是静默的（少一列就整表
 * 偏移，`ppid` 变成 `user`，界面上看起来只是「数据有点怪」）。
 */
export function parsePsOutput(stdout: string): RawProcess[] {
  const out: RawProcess[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const match = PS_LINE.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const args = (match[7] ?? '').trim()
    out.push({
      pid,
      ppid: Number(match[2]),
      user: match[3] ?? '',
      rssKb: Number(match[4]),
      rawState: match[5] ?? '',
      cpuSeconds: parseCpuTime(match[6] ?? ''),
      name: exeNameOf(args, pid),
      cmdline: args
    })
  }
  return out
}

/**
 * 读网卡累计字节（`/proc/net/dev`，仅 Linux）。
 *
 * 汇总**除 `lo` 之外**的所有接口：回环流量是「自己跟自己在本地说话」，算进去会让一张
 * 空闲的机器显示几十 MB/s（本机开发时前端热更新全走回环），非常误导。
 *
 * 读不到就返回 null：容器里可能没有这张虚拟文件，而网速只是附加信息，不该让整张进程表
 * 跟着失败。
 */
async function readProcNet(): Promise<{ rx: number; tx: number } | null> {
  if (process.platform !== 'linux') return null
  try {
    const text = await readFile('/proc/net/dev', 'utf8')
    let rx = 0
    let tx = 0
    for (const line of text.split('\n')) {
      const sep = line.indexOf(':')
      if (sep < 0) continue
      const iface = line.slice(0, sep).trim()
      if (!iface || iface === 'lo') continue
      // 冒号后是 16 个计数：rx bytes/packets/errs/drop/fifo/frame/compressed/multicast
      // 然后是 tx 的同序 8 个。只要第 1 个（rx bytes）与第 9 个（tx bytes）。
      const cols = line.slice(sep + 1).trim().split(/\s+/)
      rx += Number(cols[0]) || 0
      tx += Number(cols[8]) || 0
    }
    return { rx, tx }
  } catch {
    return null
  }
}

/**
 * 从 `/proc/<pid>/stat` 读精确的累计 CPU 秒数（**仅 Linux**）。
 *
 * `/proc/<pid>/stat` 的第 2 个字段 `comm` 被一对括号包着，而它**可以包含空格和括号**
 * （进程名里带空格很常见）—— 所以不能按空格切，必须从**最后一个** `)` 之后开始切。
 * 切完后的下标（0 基）：
 *
 * | idx | 字段号 | 含义 |
 * |---|---|---|
 * | 0 | 3 | state |
 * | 1 | 4 | **ppid** |
 * | 11 | 14 | **utime**（滴答） |
 * | 12 | 15 | **stime**（滴答） |
 * | 21 | 24 | rss（页） |
 *
 * 读不到（进程刚好退出 / 容器里 hidepid 限制）返回 null，调用方保留 `ps` 的值。
 */
async function readProcCpuSeconds(pid: number): Promise<number | null> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8')
    const close = text.lastIndexOf(')')
    if (close < 0) return null
    const fields = text.slice(close + 1).trim().split(' ')
    const utime = Number(fields[11])
    const stime = Number(fields[12])
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
    return (utime + stime) / USER_HZ
  } catch {
    return null
  }
}

/**
 * 用 `/proc` 的滴答值覆盖 `ps` 的整秒值（见文件头的「精度问题」）。
 *
 * 就低不就高：`ps` 的值是**向下截断**的整秒，正常情况下 `/proc` 的值必然 ≥ 它；反过来
 * 说明读到了另一个进程（pid 复用），那就别用。
 */
async function refineCpuFromProc(procs: RawProcess[]): Promise<void> {
  if (process.platform !== 'linux') return
  await Promise.all(
    procs.map(async (proc) => {
      const seconds = await readProcCpuSeconds(proc.pid)
      if (seconds != null && seconds >= proc.cpuSeconds) proc.cpuSeconds = seconds
    })
  )
}

/** 采一帧 POSIX 的进程表（读不到就抛 `CollectError`，别让界面把空表当成「机器上没有进程」） */
export async function collectPosix(): Promise<RawSnapshot> {
  const [ps, net] = await Promise.all([runCapture('ps', PS_ARGS), readProcNet()])
  if (ps.code !== 0 && !ps.stdout.trim()) {
    throw new CollectError(
      `读取进程表失败（ps 退出码 ${ps.code}）${ps.stderr.trim() ? `：${ps.stderr.trim()}` : ''}`
    )
  }
  const procs = parsePsOutput(ps.stdout)
  if (procs.length === 0) {
    throw new CollectError('读取进程表失败：ps 有输出但一条进程都没解析出来')
  }
  await refineCpuFromProc(procs)
  return { at: Date.now(), source: 'ps', procs, net }
}
