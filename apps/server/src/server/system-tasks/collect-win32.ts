/**
 * Windows 的进程表：**一次 PowerShell + CIM 查询**，`tasklist` 只当降级兜底。
 *
 * ## 为什么不是 `tasklist`（这是实测踩出来的）
 *
 * 最初这里用的是 `tasklist /FO CSV /NH /V`：`/V` 才给「用户名」与「CPU 时间」，看着
 * 正合适。实测下来——
 *
 * | 命令 | 本机耗时 |
 * |---|---|
 * | `tasklist /FO CSV /NH`（不带 /V） | ~0.5 s |
 * | `tasklist /FO CSV /NH /V` | **~47 s** |
 *
 * `/V` 要为每个进程去摸窗口标题 / 令牌，进程一多就崩了。47 秒的采集配 3 秒的轮询，
 * 等于「永远采不完」。而不带 `/V` 的 `tasklist` 没有 CPU 时间 —— 没有 CPU 时间的任务
 * 管理器没有意义。
 *
 * 换成 PowerShell 之后：**启动 283 ms + CIM 查询 ~340 ms ≈ 0.6 s**，而且一次查询就把
 * 父进程、命令行、常驻内存、累计 CPU 时间（`KernelModeTime + UserModeTime`）全拿到了，
 * 比 `/V` 版本强得多也快得多。所以 `tasklist` 只在 PowerShell 压根起不来（极少数精简
 * 镜像）时降级使用 —— 那时是「有名称 / PID / 内存，没有 CPU」，由 `note` 明说。
 *
 * ## 编码
 *
 * PowerShell 5.1 把结果写进重定向的 stdout 时用**控制台代码页**（中文系统 = GBK），
 * 进程名里带中文就乱码。所以命令开头先 `[Console]::OutputEncoding = UTF8`；
 * `runCapture` 的解码器对两种编码都兜得住（见 `decodeConsole`）。
 *
 * ## 拿不到 / 归一不了的字段
 *
 * - **运行用户**：`Win32_Process` 没有这个属性，要逐进程调 `GetOwner()`（几百次 WMI
 *   来回，比整个采集还慢一个量级）。这条列在 Windows 上恒为 `—`。
 * - **进程状态**：CIM 的 `ExecutionState` 常年是 null，不可信。同样留空（界面显示 `—`），
 *   别编一个「运行中」上去 —— 一个永远显示「运行中」的状态列比没有更糟。
 */
import type { RawProcess, RawSnapshot } from './raw'
import { CollectError, exeNameOf, parseCpuTime, parseCsvLine, parseMemKb, runCapture } from './raw'

/**
 * CIM 查询脚本（单行，作为 `-Command` 的一个参数传进去 —— 不经 shell，不用转义引号）。
 *
 * `KernelModeTime` / `UserModeTime` 的单位是 **100 纳秒**，除 1e7 得秒。
 */
const CIM_SCRIPT = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
  'Get-CimInstance -ClassName Win32_Process |',
  'Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime |',
  'ConvertTo-Json -Compress'
].join(' ')

const PS_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  CIM_SCRIPT
] as const

/** CIM 的时间戳单位是 100ns */
const HUNDRED_NS_PER_SECOND = 1e7

/**
 * 解析 `ConvertTo-Json -Compress` 的输出。
 *
 * 导出的原因同 `parsePsOutput`：字段名拼错、单位换算漏一位这类错误**不会抛**，只会让
 * 界面上每个进程的 CPU 时间差 1000 万倍。
 */
export function parseCimProcesses(stdout: string): RawProcess[] {
  const text = stdout.trim()
  if (!text) return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  // 只有一个进程时 ConvertTo-Json 给的是对象而不是数组
  const rows = Array.isArray(data) ? data : [data]
  const out: RawProcess[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const pid = Number(record.ProcessId)
    if (!Number.isFinite(pid)) continue
    /*
     * 丢掉 pid 0（System Idle Process）。
     *
     * 它不是进程，而是「CPU 空闲的那部分时间」的记账者：累计时间等于开机以来的全部空闲
     * 时长，算出来的瞬时占用永远是「核数 × 100%」，会**每一帧都霸占表头第一行**，把真正
     * 吃 CPU 的进程挤下去。Windows 自己的任务管理器也不列它。
     */
    if (pid <= 0) continue
    const name = typeof record.Name === 'string' ? record.Name : ''
    const cmdline = typeof record.CommandLine === 'string' ? record.CommandLine.trim() : ''
    const ticks = Number(record.KernelModeTime ?? 0) + Number(record.UserModeTime ?? 0)
    const workingSet = Number(record.WorkingSetSize ?? 0)
    out.push({
      pid,
      ppid: Number(record.ParentProcessId) || 0,
      name: name || exeNameOf(cmdline, pid),
      cmdline,
      // Win32_Process 没有用户名（见文件头）
      user: '',
      rssKb: Number.isFinite(workingSet) ? Math.max(0, Math.round(workingSet / 1024)) : 0,
      // 状态读不到（见文件头）
      rawState: '',
      cpuSeconds: Number.isFinite(ticks) ? Math.max(0, ticks / HUNDRED_NS_PER_SECOND) : 0
    })
  }
  return out
}

/**
 * 降级通路：`tasklist /FO CSV /NH`（**不加 `/V`**，见文件头）。
 *
 * 只有名称 / PID / 内存，没有 CPU、没有父进程、没有命令行。留着它是因为「一个读不到
 * CPU 的进程表」仍然能回答「那个进程还在不在、PID 是多少」，比整页报错有用。
 */
export function parseTasklistCsv(stdout: string): RawProcess[] {
  const out: RawProcess[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields = parseCsvLine(line)
    if (fields.length < 5) continue
    const pid = Number((fields[1] ?? '').trim())
    if (!Number.isFinite(pid) || pid < 0) continue
    const user = (fields[6] ?? '').trim()
    out.push({
      pid,
      ppid: 0,
      name: (fields[0] ?? '').trim(),
      cmdline: '',
      // 只有带 /V 才有用户名列（而 /V 慢到不能用），这里恒为空
      user: user && user !== 'N/A' ? user : '',
      rssKb: parseMemKb(fields[4] ?? ''),
      rawState: (fields[5] ?? '').trim(),
      // 同上：不带 /V 没有 CPU 时间列
      cpuSeconds: parseCpuTime(fields[7] ?? '')
    })
  }
  return out
}

/** 一次 PowerShell + CIM 采集；PowerShell 起不来就返回 null（交给降级通路） */
async function collectViaCim(): Promise<RawSnapshot | null> {
  const result = await runCapture('powershell', PS_ARGS, 15_000)
  const procs = parseCimProcesses(result.stdout)
  if (procs.length > 0) {
    return { at: Date.now(), source: 'cim', procs, net: null }
  }
  // 有输出但解析不出东西 = 查询确实跑挂了；没有输出 = PowerShell 根本起不来。两种都降级
  if (result.stderr.trim()) {
    console.warn('[system-tasks] PowerShell 采集失败，降级到 tasklist：', result.stderr.slice(0, 400))
  }
  return null
}

/** 采一帧 Windows 的进程表（网卡速率在 Windows 上读不到，恒为 null） */
export async function collectWindows(): Promise<RawSnapshot> {
  const viaCim = await collectViaCim()
  if (viaCim) return viaCim

  const result = await runCapture('tasklist', ['/FO', 'CSV', '/NH'])
  if (result.code !== 0 && !result.stdout.trim()) {
    throw new CollectError(
      `读取进程表失败：PowerShell 与 tasklist 都不可用${
        result.stderr.trim() ? `（${result.stderr.trim().split(/\r?\n/)[0]}）` : ''
      }`
    )
  }
  const procs = parseTasklistCsv(result.stdout)
  if (procs.length === 0) {
    throw new CollectError('读取进程表失败：tasklist 有输出但一条进程都没解析出来')
  }
  return { at: Date.now(), source: 'tasklist', procs, net: null }
}
