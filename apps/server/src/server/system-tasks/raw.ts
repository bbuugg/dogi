/**
 * 任务管理器的**原始采集层**：两条平台通路共用的类型、子进程调用、以及几个容易写错的
 * 文本解析（CPU 时间 / 内存 KB / CSV 行）。
 *
 * ## 为什么这里允许起子进程，而 `services/system-monitor.ts` 明令禁止
 *
 * 那份文件的头注释写着「零子进程、不用 ps」，那是为**常驻采样器**定的规矩：它每 2s 跑
 * 一次、永远不停，起子进程等于让「监控」比「被监控的程序」还忙。
 *
 * 这里的前提完全不同：进程表只在**用户打开任务管理器标签页**时才读，关掉就彻底没请求。
 * 一次 `ps` / `tasklist` 十几到几十毫秒，代价完全对得起「看到每个进程」这件事 —— 而
 * Node 内置 API 里**根本没有任何**进程枚举能力，不起子进程就做不了。
 *
 * 两条通路各一次调用，都是按需、都不带轮询负担：
 * - POSIX：`ps -ww -e -o pid,ppid,user,rss,stat,time,args`（Linux / macOS 同一套参数）；
 * - Windows：`tasklist /FO CSV /NH /V`（原生小工具，比 PowerShell / WMI 快一个量级）。
 *
 * ## 为什么 CPU 占用要自己算
 *
 * 两个通路都**只给累计 CPU 时间**（`ps` 的 `time` 列 / `tasklist` 的 `CPU Time` 列），
 * 没有瞬时占用。瞬时值只能靠「两次采集的累计量之差 ÷ 墙上时间」算 —— 这也是 `top`
 * 的做法。所以采集层只负责把累计秒数报上来，差值在 `index.ts` 里算（那里才知道上次
 * 采样是什么时候）。
 */

import { execFile } from 'node:child_process'

/** 一次采集里的一条进程（**还没算瞬时 CPU**，只有累计值） */
export interface RawProcess {
  pid: number
  ppid: number
  name: string
  cmdline: string
  user: string
  /** 常驻内存（KB，两个平台的原始单位都是 KB） */
  rssKb: number
  /** 平台原始状态码（`Ssl` / `R` / `Running` / `N/A` …） */
  rawState: string
  /** 累计 CPU 时间（秒） */
  cpuSeconds: number
}

/** 一次采集的完整结果（`net` 只有 Linux 有，其余为 null） */
export interface RawSnapshot {
  /** 采集完成的时刻（Date.now()）—— delta 的右端点 */
  at: number
  /** 采集后端（`ps` / `tasklist`），原样透到应答里做诊断 */
  source: string
  procs: RawProcess[]
  /** 网卡累计字节（只有 Linux 读得到 `/proc/net/dev`） */
  net: { rx: number; tx: number } | null
}

/** 子进程调用的结果（**不抛异常**，退出码原样给调用方判断） */
export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 跑一个外部命令并收全 stdout / stderr。
 *
 * 刻意**永不 reject**：调用方真正关心的是「退出码 + 输出」（比如 `taskkill` 失败时
 * stderr 里那句人能读懂的话），弄成 reject 反而要在 catch 里再拆一遍错误对象。
 *
 * `timeout` 到点由 Node 直接 SIGTERM 掉子进程（`ps` / `tasklist` 卡住基本只可能是系统
 * 出问题了，不值得等）；`maxBuffer` 给到 16MB —— 几千个进程的 `args` 加起来可能上 MB。
 *
 * ## 输出不按 utf8 解，而是自己按 Buffer 解（见 `decodeConsole`）
 *
 * ⚠️ `execFile` 的 `options.encoding` **默认是 `'utf8'`**，不写就等于「已经解完了」——
 * 必须显式写 `encoding: 'buffer'` 才拿得到原始字节。这一点如果漏了，下游那个「先试 utf8、
 * 不行再试 GBK」的解码器根本拿不到字节，中文提示照样是乱码。
 */
export function runCapture(
  command: string,
  args: readonly string[],
  timeout = 8_000
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const raw = err as { code?: unknown } | null
        const code = !err
          ? 0
          : typeof raw?.code === 'number'
            ? raw.code
            : 1 /* ENOENT / 超时被杀：一律当失败，stderr 里会有说明 */
        resolve({ code, stdout: decodeConsole(stdout), stderr: decodeConsole(stderr) })
      }
    )
  })
}

/**
 * 解一段子进程输出。
 *
 * Windows 上 `tasklist` / `taskkill` 这些原生小工具输出的编码是**控制台代码页**
 * （中文系统是 GBK / cp936），按 utf8 解会把「拒绝访问」变成一堆 `����`。而
 * `powershell` 那条路我们在命令里强制了 `[Console]::OutputEncoding = UTF8`（见
 * `collect-win32.ts`），所以同一套解码要同时对两种编码成立：
 *
 * 1. 先按 utf8 解 —— 只要没出现替换字符 `U+FFFD`，就认为是真 UTF-8（纯 ASCII 也走这条）；
 * 2. 出现了才回退到 gbk 解（Node 官方发行版自带完整 ICU，`TextDecoder('gbk')` 可用；
 *    万一不可用就保留 utf8 的乱码，至少不抛）。
 *
 * 顺序不能反：GBK 的字节流几乎总能「解」出一串字符，先试 GBK 会把好好的 UTF-8 解成乱码。
 */
export function decodeConsole(input: Buffer | string | null | undefined): string {
  if (input == null) return ''
  // 兼容万一拿到的是已经解过码的字符串（`encoding` 被别处写死时）
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  if (buf.length === 0) return ''
  const utf8 = buf.toString('utf8')
  // PowerShell 的 UTF-8 输出可能带 BOM —— 留着会让 `JSON.parse` 直接失败
  if (!utf8.includes('\uFFFD')) return utf8.replace(/^\uFEFF/, '')
  try {
    return new TextDecoder('gbk').decode(buf).replace(/^\uFEFF/, '')
  } catch {
    return utf8.replace(/^\uFEFF/, '')
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 采集失败（命令跑不起来 / 输出完全解析不出东西）—— 由路由映射成 500 */
export class CollectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CollectError'
  }
}

/**
 * 解析累计 CPU 时间。
 *
 * 三种真实形态都要认（`ps -o time` 的输出在各平台上不一样）：
 * - `MM:SS` —— 常见于短命进程；
 * - `HH:MM:SS`；
 * - `D-HH:MM:SS` —— 跑了超过一天；
 * - macOS 还会给 `MM:SS.cc`（附百分之一秒）。
 *
 * ⚠️ 别用 `Number(text)` 或只 split 一次：`1:02` 到底是 1 分 2 秒还是 1 时 2 分，
 * 取决于段数（2 段 = 分:秒，3 段 = 时:分:秒）。少了这个判断，「运行 3 分钟的进程」会
 * 被算成 3 小时，瞬时 CPU 直接变成 0。
 */
export function parseCpuTime(raw: string): number {
  const text = raw.trim()
  if (!text) return 0

  let rest = text
  let days = 0
  const dash = rest.indexOf('-')
  if (dash > 0) {
    days = Number(rest.slice(0, dash)) || 0
    rest = rest.slice(dash + 1)
  }

  let fraction = 0
  const dot = rest.indexOf('.')
  if (dot >= 0) {
    // `.45` → 0.45（前缀补 `0`，避免 `Number('.45')` 依赖实现细节）
    fraction = Number(`0${rest.slice(dot)}`) || 0
    rest = rest.slice(0, dot)
  }

  const parts = rest.split(':').map((part) => Number(part) || 0)
  const [hours, minutes, seconds] =
    parts.length >= 3
      ? [parts[parts.length - 3]!, parts[parts.length - 2]!, parts[parts.length - 1]!]
      : [0, parts[0] ?? 0, parts[1] ?? 0]

  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds + fraction
}

/**
 * 解析 `tasklist` 的「内存使用」列（形如 `12,345 K`）。
 *
 * ⚠️ 千分位分隔符**跟着系统区域设置走**（中文 Windows 可能给 `12,345 K`，某些区域
 * 设置会给 `12.345 K`），所以不能按逗号切 —— 直接抠掉所有非数字字符。这一列永远是
 * 整数 KB，没有小数点的语义，抠数字是安全的。
 */
export function parseMemKb(raw: string): number {
  const digits = raw.replace(/[^\d]/g, '')
  return digits ? Number(digits) : 0
}

/**
 * 拆一行 CSV（`tasklist /FO CSV` 的引号规则）。
 *
 * 不用 `split(',')`：进程名里带逗号（`foo, bar.exe`）会被切成两段，整行字段就全错位了。
 * 这里实现的是 RFC 4180 那套最小集：双引号包裹 + `""` 表示一个字面双引号。
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++ // 跳过成对的第二个引号
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(field)
      field = ''
    } else field += ch
  }
  out.push(field)
  return out
}

/**
 * 取命令行首段的可执行文件名（`/usr/bin/node` → `node`）。
 *
 * ⚠️ Windows 的命令行**带引号**（`"C:\Program Files\node.exe" a.js`，路径有空格就必然
 * 加引号）。只按空白切会得到 `"C:\Program`，basename 之后带上一个 `Program` 和半截引号
 * —— 这个字段会直接显示在进程表第一列。所以开头是引号就取到闭合引号为止。
 */
export function exeNameOf(args: string, fallbackPid: number): string {
  const trimmed = args.trim()
  if (!trimmed) return `[${fallbackPid}]`

  let first: string
  if (trimmed.startsWith('"')) {
    const close = trimmed.indexOf('"', 1)
    first = close > 0 ? trimmed.slice(1, close) : trimmed.slice(1)
  } else {
    first = trimmed.split(/\s+/)[0] ?? ''
  }

  const at = Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\'))
  const name = at >= 0 ? first.slice(at + 1) : first
  return name || `[${fallbackPid}]`
}
