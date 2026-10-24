/**
 * 工作区 Agent 工具集：文件读取 / 查找 / 写入 / 编辑 / 删除 / 执行命令。
 *
 * 所有工具都绑定一个工作区根目录（root），文件路径一律相对工作区，
 * 经 resolveInside 越界校验后落盘，防止 Agent 逃出工作区。
 *
 * 权限：**会改动东西的工具**（write_file / edit_file / delete_file / execute_command）
 * 统一走 `guardWrite` 一道闸 ——
 * - `readonly`：直接回绝（不落盘、不执行），并告诉模型让用户去切换模式；
 * - `confirm`：经 requestConfirm 弹卡片等用户点「允许」，被拒绝就当次调用放弃；
 *   没有可用的 requestConfirm 通道时**按拒绝处理**（fail-closed）；
 * - `full`：放行。
 *
 * 只读类工具（list/read/search/find/read_skill）在任何模式下都不拦。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { commandShellPath, gitBashPath } from '@fizz/shells'
import { buildReadSkillTool, type AgentSkill } from '@fizz/skills'
import { createIgnoreChecker, relPathOf, resolveInside } from '@fizz/contracts/workspace'
import { tr } from '@fizz/i18n'
import { applyTolerantEdit } from './edit-match'
import {
  clipToBudget,
  MAX_TOOL_RESULT_CHARS,
  summarizeLongOutput
} from './output-log'

export type AgentPermissionMode = 'full' | 'confirm' | 'readonly'

/**
 * 单个文件整体读入的上限（字节）：超过就不当文本处理。
 *
 * 超限只有「读不动」这一个理由（模型自己也读不动这么大一段），按行分段用
 * read_file 的 offset/limit 即可，不走 output-log（那里只留给 execute_command）。
 */
const MAX_FILE_BYTES = 8_000_000
/** 搜索文件的大小上限（1MB，跳过大文件避免卡死） */
const MAX_SEARCH_FILE_SIZE = 1_048_576
/** 搜索命中的单行截断长度 */
const MAX_LINE_CHARS = 200
/**
 * 单条输出流（stdout / stderr）的缓存上限（字符）：超出后只留最新的一段，
 * 防止一条 `yes` / `find /` 之类把内存吃光。
 *
 * ⚠️ 这**不是**给模型的截断上限：以前这里留着 MAX_CMD_OUT 然后 `slice(-MAX_CMD_OUT)`，
 * 等于在缓冲阶段就把中间内容**丢掉了**，后面再怎么提示都找不回来。现在只留一个防爆内存
 * 的兜底，返回给模型的那一段走 `summarizeLongOutput`（落盘 + 给日志 id）。
 */
const MAX_CMD_CAPTURE = 4_000_000

export interface AgentToolOptions {
  /** 确认模式下 execute_command 执行前需用户批准（整轮固定的静态档） */
  permissionMode: AgentPermissionMode
  /**
   * **运行中实时读取权限档**（优先于上面的静态 `permissionMode`）。
   *
   * 工具集是**一轮建一次**的，静态值会把权限档快照死在整轮里 —— 用户在一轮中途把权限
   * 从「确认」切成「完全访问」（或反过来）时，下一轮才生效。传本 getter，闸门就会
   * **每次工具调用现取**，中途切换立刻生效。不传 = 退回静态快照（行为与从前一致）。
   */
  getPermissionMode?: () => AgentPermissionMode
  requestConfirm?: (req: {
    toolCallId: string
    toolName: string
    command: string
  }) => Promise<boolean>
  /**
   * `execute_command` 每次**启动命令前**调用：`stop` 由调用方持有，调用即杀
   * 这条命令的进程树（工具结果收尾成「（已中止）」）。整轮 abort 仍走
   * `options.abortSignal`（tools 内部把它联动到同一个 per-command controller）。
   * 不传 = 没有单条停止能力（行为与加这些回调之前逐字节一致）。
   */
  onCommandStart?: (toolCallId: string, stop: () => void) => void
  /** 命令收场（exit / 超时 / 中止 / 启动失败）时调用，只来一次 */
  onCommandEnd?: (toolCallId: string) => void
  /** 命令执行期间的 stdout / stderr 实时增量（纯转发，不缓存） */
  onCommandOutput?: (toolCallId: string, stream: 'stdout' | 'stderr', chunk: string) => void
  /** 可用技能（见 skills.ts）；有值时额外暴露 read_skill 工具，空值不暴露 */
  skills?: AgentSkill[]
  /**
   * 只暴露这些工具（按 key 白名单）；缺省 = 全给。
   *
   * 给 subagent 用：它只需要只读子集（explorer / reviewer），写操作留在父 agent。
   * ⚠️ 用**显式白名单**而不是「砍掉写工具」的黑名单 —— tools 每加一个，黑名单
   * 会自动漏放（静默多给能力），白名单则是显式失败（少一个 key 直接抛错）。
   */
  includeTools?: string[]
  /**
   * **子目录规则**的按需加载钩子：`read_file` / `list_files` 每次调用后带上
   * 目标路径（绝对）与是否目录，返回非空文本就追加到工具结果后面。
   *
   * 由 `@fizz/agent` 注入（读 `<目录>/AGENTS.md`，按会话去重）；不传 = 行为与从前一致。
   * 钩子抛错不影响工具结果本身（规则只是补充说明）。
   */
  nestedDocs?: (absPath: string, isDirectory: boolean) => Promise<string | null>
}

/**
 * 按 `includeTools` 过滤工具集。缺省返回原对象。
 *
 * 白名单写错就抛错（调用方拼错 key / 工具改名了要立刻知道），**不静默过滤成空集** ——
 * 空集会让 subagent 感觉自己「没有工具可用」，模型侧表现为反复尝试调用一个不存在的工具。
 */
export function filterToolSet(tools: ToolSet, include?: string[]): ToolSet {
  if (!include) return tools
  const missing = include.filter((k) => !(k in tools))
  if (missing.length > 0) {
    throw new Error(`includeTools 里有不存在的工具：${missing.join(', ')}（现有：${Object.keys(tools).join(', ')}）`)
  }
  const out: ToolSet = {}
  for (const k of include) out[k] = tools[k]
  return out
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback
  return Math.max(min, Math.min(max, Math.trunc(v)))
}

/**
 * 读取文本文件：二进制（含 NUL）与超大文件直接报错。
 *
 * 超大文件报错的理由只剩「读不动」这一个（`MAX_FILE_BYTES`），不再是因为「太大不适合
 * 一次返回」—— 后者由 read_file 的 offset/limit 分段读解决。
 */
async function readTextFile(abs: string): Promise<string> {
  const stat = await fs.stat(abs)
  if (stat.isDirectory()) throw new Error(`不是文件：${basename(abs)}`)
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `文件过大（${stat.size} 字节，超过 ${MAX_FILE_BYTES} 字节上限），无法整体按文本读取。` +
        '请先用 search_files 定位关键内容，再用 read_file 的 offset/limit 分段读取'
    )
  }
  const buf = await fs.readFile(abs)
  if (buf.includes(0)) throw new Error('二进制文件，无法以文本方式读取')
  return buf.toString('utf8')
}

// ---------- 文件系统遍历 ----------

async function listDir(
  dir: string,
  root: string,
  depth: number,
  ignored: (rel: string, isDir: boolean) => boolean,
  lines: string[]
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1
    const bd = b.isDirectory() ? 0 : 1
    return ad === bd ? a.name.localeCompare(b.name) : ad - bd
  })
  for (const ent of entries) {
    const abs = join(dir, ent.name)
    const rel = relPathOf(root, abs)
    if (ignored(rel, ent.isDirectory())) continue
    if (ent.isDirectory()) {
      lines.push(`${rel}/`)
      if (depth > 0) await listDir(abs, root, depth - 1, ignored, lines)
    } else if (ent.isFile()) {
      const size = (await fs.stat(abs)).size
      lines.push(`${rel}\t${size}B`)
    }
  }
}

/** 单个文件的内容命中；需要上下文行时才保留全文（否则大结果集会白占内存） */
interface SearchFileHit {
  rel: string
  hits: Array<{ line: number; text: string }>
  source?: string[]
}

interface SearchAcc {
  files: SearchFileHit[]
  /** 已命中的总行数（跨文件累计，用于 maxResults 封顶） */
  hits: number
  max: number
}

async function searchDir(
  dir: string,
  root: string,
  re: RegExp,
  fileRe: RegExp | null,
  ignored: (rel: string, isDir: boolean) => boolean,
  acc: SearchAcc,
  needSource: boolean
): Promise<void> {
  if (acc.hits >= acc.max) return
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    if (acc.hits >= acc.max) return
    const abs = join(dir, ent.name)
    const rel = relPathOf(root, abs)
    if (ignored(rel, ent.isDirectory())) continue
    if (ent.isDirectory()) {
      await searchDir(abs, root, re, fileRe, ignored, acc, needSource)
      continue
    }
    if (!ent.isFile()) continue
    await scanFile(abs, rel, re, fileRe, acc, needSource)
  }
}

/** 扫单个文件：命中行攒进 acc（超大小 / 二进制跳过；fileRe 对文件名生效） */
async function scanFile(
  abs: string,
  rel: string,
  re: RegExp,
  fileRe: RegExp | null,
  acc: SearchAcc,
  needSource: boolean
): Promise<void> {
  if (acc.hits >= acc.max) return
  if (fileRe && !fileRe.test(rel.split('/').pop() ?? rel)) return
  const stat = await fs.stat(abs)
  if (stat.size > MAX_SEARCH_FILE_SIZE) return
  const buf = await fs.readFile(abs)
  if (buf.includes(0)) return
  const source = buf.toString('utf8').split('\n')
  const hits: Array<{ line: number; text: string }> = []
  for (let i = 0; i < source.length && acc.hits < acc.max; i++) {
    re.lastIndex = 0
    if (re.test(source[i])) {
      hits.push({ line: i + 1, text: source[i].trimEnd().slice(0, MAX_LINE_CHARS) })
      acc.hits++
    }
  }
  if (hits.length) acc.files.push(needSource ? { rel, hits, source } : { rel, hits })
}

/**
 * 把 glob 编译成 RegExp：`**` 跨目录，`*` / `?` 不跨 `/`。
 * 不含 `/` 的 glob（如 `*.ts`）自动补 `**​/` 前缀，让它能匹配任意层级 —— 符合直觉。
 */
export function globToRegExp(glob: string): RegExp {
  const raw = glob.trim()
  const pat = raw.includes('/') ? raw : `**/${raw}`
  let re = ''
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        i++
        if (pat[i + 1] === '/') {
          // `**/` —— 连同分隔符一起可选，避免 `**​/*.ts` 强制要求中间多一层目录
          i++
          re += '(?:.*/)?'
        } else {
          // 结尾的 `**`（如 `foo/**`）—— 退化成「跨目录任意串」，否则会强制要求尾随 /
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += `\\${ch}`
    } else {
      re += ch
    }
  }
  return new RegExp(`^${re}$`)
}

/** 按文件名 glob 递归查找（复用同一套忽略规则，匹配相对路径） */
async function findFiles(
  dir: string,
  root: string,
  re: RegExp,
  ignored: (rel: string, isDir: boolean) => boolean,
  out: string[],
  max: number
): Promise<void> {
  if (out.length >= max) return
  const entries = await fs.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const ent of entries) {
    if (out.length >= max) return
    const abs = join(dir, ent.name)
    const rel = relPathOf(root, abs)
    if (ignored(rel, ent.isDirectory())) continue
    if (ent.isDirectory()) {
      await findFiles(abs, root, re, ignored, out, max)
    } else if (ent.isFile()) {
      if (re.test(rel)) out.push(rel)
    }
  }
}

/** 把内容命中格式化成模型友好的文本 */
function formatSearchHits(acc: SearchAcc, context: number): string {
  if (!acc.files.length) return '（未找到匹配）'
  const out: string[] = []
  if (context <= 0) {
    // 保持 ripgrep 的 `路径:行号: 内容` 风格 —— 模型对这种格式最熟
    for (const f of acc.files) {
      for (const h of f.hits) out.push(`${f.rel}:${h.line}: ${h.text}`)
    }
    return out.join('\n')
  }
  for (const f of acc.files) {
    const src = f.source
    if (!src) continue
    out.push(`${f.rel}:`)
    // 合并重叠的上下文区间，避免同一段被打印多次
    const ranges: Array<[number, number]> = []
    for (const h of f.hits) {
      const s = Math.max(1, h.line - context)
      const e = Math.min(src.length, h.line + context)
      const last = ranges[ranges.length - 1]
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
      else ranges.push([s, e])
    }
    const hitLines = new Set(f.hits.map((h) => h.line))
    ranges.forEach(([s, e], idx) => {
      if (idx > 0) out.push('--')
      for (let n = s; n <= e; n++) {
        const mark = hitLines.has(n) ? ':' : '-'
        out.push(`${n}${mark} ${src[n - 1].trimEnd().slice(0, MAX_LINE_CHARS)}`)
      }
    })
  }
  return out.join('\n')
}

// ---------- 命令执行 ----------

/**
 * 杀掉整棵进程树（超时 / 中止 / 单条停止都走它）。
 *
 * ⚠️ **不再看 `child.killed`**：那个标志只表示「我们向**它自己**发过信号」，与「树还在不在」
 * 无关。以前的 `if (child.exitCode !== null || child.killed) return` 会让第二次调用直接
 * 什么都不做 —— 用户报「AI 跑了 `npx vite`，我点停止停不下来」，多半就是第一刀（某个
 * 只杀 shell 的路径或 SIGINT）已经把 `killed` 置上，后面这道保险丝全被跳过了。
 * 现在无条件再打一记整树 kill：幂等（进程没了 taskkill / kill 都是空转）。
 */
function killChild(child: ReturnType<typeof spawn>, isWin: boolean): void {
  const pid = child.pid
  if (!pid) return
  if (isWin) {
    /**
     * ⚠️ `taskkill` 是**异步**的：`spawn` 自己不抛错，ENOENT / 权限不足 / 「进程已退出」
     * 全都只走 `'error'` 事件或非 0 退出码 —— 以前的 `try { spawn(...) } catch {}` 一个都
     * 接不住，失败了就是**静默空转**（命令继续跑、端口继续占着）。这里两条路都补上：
     * 打整树，同时在任何失败信号上退回直接 kill shell。
     */
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    const fallback = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出
      }
    }
    killer.on('error', fallback)
    // 非 0 = 树已经不在 / 拿不到（权限、pid 已被回收）：退回单杀，能杀多少算多少
    killer.on('exit', (code) => {
      if (code !== 0) fallback()
    })
    return
  }
  // detached 起的（见 runCommand 的 spawn 选项）自成进程组：先杀整组，退不回再单杀
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    // 组已经没了 / 不是组首：退回单杀
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // 已退出
  }
}

/**
 * 在工作区目录下执行 shell 命令：输出 stdout + stderr（超预算时把全文落进工作区的
 * `.fizz/tool-output/`，回行号坐标），超时 / abortSignal 触发时终止整个进程树
 * （POSIX 用进程组，Windows 用 taskkill /T）。
 *
 * `root` 只用于落盘（全文要能被 read_file 读到，就必须在工作区内）。
 */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  root: string,
  signal?: AbortSignal,
  /** 实时输出与生命周期的旁路（execute_command 用；不传 = 行为与从前一致） */
  sink?: {
    onOutput: (stream: 'stdout' | 'stderr', chunk: string) => void
    onEnd?: () => void
  }
): Promise<string> {
  const isWin = process.platform === 'win32'
  /**
   * shell 选择：POSIX 恒为 `/bin/bash -lc`；Windows **优先 Git Bash** —— 模型拿到的是
   * POSIX 工具链（ls / grep / sed / find / cat / 管道…），与主流编码代理一致。Git Bash 的
   * coreutils 在 `<Git>\usr\bin`，登录 profile 之外再显式置前，保证 ls / grep 一定找得到
   * （继承的 Windows PATH 里通常没有它）。没有 Git Bash 时回退 PowerShell 7（`pwsh`，启动
   * 更快、UTF-8 默认行为更少坑），再没装就退到系统自带的 5.1（强制 UTF-8 输出，cmd 的 GBK
   * 会乱码）。判定在 `@fizz/shells` 的 `commandShellPath()` 与 `gitBashPath()`，
   * 与终端选择器共用同一份探测。
   */
  const bashPath = isWin ? gitBashPath() : null
  const useBash = !isWin || Boolean(bashPath)
  const shellCmd = isWin ? (bashPath ?? commandShellPath()) : '/bin/bash'
  const shellArgs = isWin
    ? useBash
      ? ['-lc', command]
      : [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;${command}`
        ]
    : ['-lc', command]
  const child = spawn(shellCmd, shellArgs, {
    cwd,
    // Git Bash 的 coreutils 在 <Git>\usr\bin：登录 profile 之外再显式置前，保证 ls / grep 找得到
    env:
      isWin && useBash
        ? {
            ...process.env,
            PATH: `${join(dirname(bashPath!), '..', 'usr', 'bin')};${process.env.PATH ?? ''}`
          }
        : process.env,
    windowsHide: true,
    ...(isWin ? {} : { detached: true })
  })
  let stdout = ''
  let stderr = ''

  return new Promise<string>((resolve) => {
    let settled = false
    /**
      * 收场：把 stdout + stderr 拼成**完整**输出，超预算时交给 `summarizeLongOutput`
      * 把全文落进工作区并回行号坐标（模型用 read_file 的 offset/limit 接着读）。
     *
     * stderr 以前是**完全不截断**直接拼在后面的（stdout 才截），一条刷满错误输出的
     * 命令能把整个结果顶爆；现在两条流走同一条路，一视同仁。
     */
    const finish = async (reason: 'exit' | 'timeout' | 'aborted', code?: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      sink?.onEnd?.()
      const info =
        reason === 'exit'
          ? `（退出码 ${code}）`
          : reason === 'timeout'
            ? `（超时 ${timeoutMs}ms，已终止进程树）`
            : '（已中止）'
      const err = stderr.trim()
      const full = `$ ${command}\n${info}\n${stdout.trim()}${err ? `\n${err}` : ''}`
      resolve(
        await summarizeLongOutput(full, {
          root,
          tool: 'execute_command',
          detail: command.slice(0, 200)
        })
      )
    }
    /**
     * 收树两次：立刻一记整树 SIGKILL / taskkill（SIGKILL 不可捕获，通常一步到位），
     * 600ms 后再补一记 —— 有些 shell（Git Bash 的 `-lc`、`npm run` 的短命包装进程）
     * 会在第一记打下去之后才 **fork** 出真正的命令（`npx vite` 的 vite 是孙子辈），
     * 只打一记会漏掉最后出生的那一批，用户就看到「停不下来、端口还占着」。
     * 补刀定时器 `unref()`：别把服务端进程吊住。
     */
    const reap = (): void => {
      killChild(child, isWin)
      const straggler = setTimeout(() => killChild(child, isWin), 600)
      straggler.unref?.()
    }
    const onAbort = () => {
      reap()
      void finish('aborted')
    }
    const timer = setTimeout(() => {
      reap()
      void finish('timeout')
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    // 只保留最新的一段，防 `yes` / `find /` 之类把内存吃光；丢的部分只发生在超出
    // MAX_CMD_CAPTURE 的极端情况下，正常命令的输出是完整的
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
      if (stdout.length > MAX_CMD_CAPTURE) stdout = stdout.slice(-MAX_CMD_CAPTURE)
      // 实时增量：纯转发（不在这里缓存），防爆由调用方负责（见 parts.ts 的 MAX_LIVE_OUTPUT）
      sink?.onOutput('stdout', d.toString('utf8'))
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
      if (stderr.length > MAX_CMD_CAPTURE) stderr = stderr.slice(-MAX_CMD_CAPTURE)
      sink?.onOutput('stderr', d.toString('utf8'))
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      sink?.onEnd?.()
      resolve(`$ ${command}\n（命令启动失败：${err.message}）`)
    })
    child.on('exit', (code) => void finish('exit', code))
  })
}

// ---------- 工具集 ----------

/** 构建工作区 Agent 工具集（绑定 root 目录；改动类工具按权限模式拦一道） */
export function buildAgentTools(root: string, opts: AgentToolOptions): ToolSet {
  // 权限档**每次调用现取**：传了 getter 就以它为准（运行中切档立刻生效），否则退回静态快照
  const currentMode = (): AgentPermissionMode => opts.getPermissionMode?.() ?? opts.permissionMode
  // 工具描述必须如实描述执行环境，模型才会放心用对应风格的命令
  const isWin = process.platform === 'win32'
  const bashPath = isWin ? gitBashPath() : null
  const shellNote = isWin
    ? bashPath
      ? '命令运行在 Git Bash（POSIX）环境：可以用 ls / grep / sed / find / cat / 管道等 Unix 工具与语法；Windows 路径建议写成 C:/xxx 或 /c/xxx 形式。'
      : '命令运行在 PowerShell 环境（未检测到 Git Bash）。'
    : '命令运行在 bash 环境。'
  const shellNoteEn = process.platform === 'win32'
    ? bashPath
      ? 'Commands run in Git Bash (POSIX): you can use ls / grep / sed / find / cat, pipes, and Unix syntax. For Windows paths prefer C:/xxx or /c/xxx.'
      : 'Commands run in PowerShell (Git Bash not detected).'
    : 'Commands run in bash.'

  /**
   * 改动类工具的统一闸门。
   *
   * 返回 `null` = 放行；返回字符串 = 这个字符串就是**工具结果**（回绝说明），
   * 直接 return 回去即可 —— 不用抛错：回绝是「预期内的结果」，让模型看到原因后
   * 能向用户解释，而不是变成一个工具报错把整轮打断。
   *
   * `denied` 用来拼文案，写成「文件未写入」这类短句。
   */
  const guardWrite = async (
    denied: string,
    req: { toolCallId: string; toolName: string; command: string }
  ): Promise<string | null> => {
    // 每次调用现取：用户在一轮中途切了权限档时这里立刻按新档裁决
    const mode = currentMode()
    if (mode === 'readonly') {
      return `当前是只读模式：${denied}。请把这一点告诉用户（他可以在「设置 → 通用」里把权限切换成「确认模式」或「完全访问」），不要反复尝试同类操作。`
    }
    if (mode !== 'confirm') return null
    // 没有审批通道时**失败关闭**：与 `guardMutation` / `client-tool-gate` / ACP 同一条口径。
    // 曾经这里直接放行 —— 那等于「没人能点允许」的环境反而裸跑改动类工具，方向是反的。
    if (!opts.requestConfirm) {
      return `「${req.toolName}」需要用户确认，但当前环境没有可用的确认通道（无界面 / 未接入审批），已取消这次调用。请告诉用户这次没有执行，不要重试。`
    }
    const approved = await opts.requestConfirm(req)
    return approved
      ? null
      : `用户拒绝了这次调用：${denied}。请询问用户接下来希望怎么做，不要擅自重试同一步。`
  }

  /** 把按需加载的子目录规则附在工具结果后面（没有规则 / 钩子抛错就原样返回） */
  const withNestedDocs = async (text: string, abs: string, isDirectory: boolean): Promise<string> => {
    if (!opts.nestedDocs) return text
    const extra = await opts.nestedDocs(abs, isDirectory).catch(() => null)
    return extra ? `${text}\n\n${extra}` : text
  }

  const all = {
    list_files: tool({
      description:
        tr(
          '列出工作区目录内容（自动忽略 .git、node_modules、构建产物与 .gitignore 规则）。返回每个条目的相对路径，目录带 / 后缀，文件附大小。适合先了解项目结构。',
          'List workspace directory contents (ignores .git, node_modules, build outputs, and .gitignore rules). Returns relative paths; directories end with /, files include size. Useful for getting oriented in a project.'
        ),
      inputSchema: z.object({
        path: z.string().optional().describe(tr('相对工作区的目录路径，缺省为工作区根目录', 'Directory path relative to the workspace; defaults to the workspace root')),
        depth: z.number().optional().describe(tr('递归深度，默认 0（仅当前目录），最大 4', 'Recursion depth; default 0 (current directory only), max 4'))
      }),
      execute: async ({ path = '', depth = 0 }) => {
        const absDir = resolveInside(root, path)
        const stat = await fs.stat(absDir).catch(() => null)
        if (!stat) throw new Error(`路径不存在：${path || '.'}（相对于工作区根）`)
        if (!stat.isDirectory()) throw new Error(`不是目录：${path || '.'}（list_dir 的 path 必须是目录）`)
        const ignored = await createIgnoreChecker(root)
        const lines: string[] = []
        await listDir(absDir, root, clampInt(depth, 0, 4, 0), ignored, lines)
        return withNestedDocs(lines.length ? lines.join('\n') : '（空目录）', absDir, true)
      }
    }),

    read_file: tool({
      description:
        tr(
          '读取文件内容并附行号，用于理解源码 / 配置 / 文档。路径相对工作区根目录。' +
            '默认只读前 200 行（上限 2000）：大文件请用 offset/limit 按需分段读，不要一次拉全文。' +
            '超出预算时会按行裁剪并告诉你还有哪些行没显示。' +
            '⚠️ 行号只是给你定位用的（格式 `  42 | 代码`），**不要**把它复制进 edit_file 的 oldText。',
          'Read a file with line numbers for understanding source, config, or docs. Paths are relative to the workspace root. ' +
            'By default it reads the first 200 lines (max 2000): for large files use offset/limit instead of fetching everything at once. ' +
            'When over budget it trims by line and tells you which lines were omitted. ' +
            '⚠️ Line numbers are only for navigation (`  42 | code`); do NOT copy them into edit_file oldText.'
        ),
      inputSchema: z.object({
        path: z.string().describe(tr('相对工作区的文件路径', 'File path relative to the workspace')),
        offset: z.number().optional().describe(tr('起始行号（1 起），缺省 1', 'Starting line number (1-based); defaults to 1')),
        limit: z.number().optional().describe(tr('返回行数上限，默认 200，最大 2000', 'Maximum lines to return; default 200, max 2000'))
      }),
      execute: async ({ path, offset = 1, limit = 200 }) => {
        const abs = resolveInside(root, path)
        const text = await readTextFile(abs)
        const rel = relPathOf(root, abs)
        const lines = text.split('\n')
        const start = Math.max(0, offset - 1)
        const slice = lines.slice(start, start + clampInt(limit, 1, 2000, 200))
        const body = slice
          .map((l, i) => `${String(start + i + 1).padStart(5)} | ${l}`)
          .join('\n')
        const header = `${rel}（共 ${lines.length} 行 / ${text.length} 字符）`
        const endLine = start + slice.length

        // 小文件：一行给全，靠 offset/limit 翻页就够了
        if (text.length <= MAX_TOOL_RESULT_CHARS) {
          const more = endLine < lines.length ? `\n…（本段到第 ${endLine} 行，offset=${endLine + 1} 继续）` : ''
          return withNestedDocs(`${header}\n${body}${more}`, abs, false)
        }

        /*
          * 大文件：本次只回预算内的一段（按行窗口），并说清还剩哪些行没显示。
          *
          * 关键信息往往不在头几行（构建日志的第一条 error、文件末尾的导出表），所以提示
          * 里必须写清「这次给的是哪一段、下一段从哪行开始」，模型才能按行翻到位，而不是
          * 只看到一句「已截断」后反复从头读。文件本身不落盘（output-log 只留给
          * execute_command），用 offset/limit 翻即可。
         */
        return withNestedDocs(
          [
            header,
            clipToBudget(body),
            `…（本次返回第 ${start + 1}–${endLine} 行；文件还有第 ${endLine + 1}–${lines.length} 行没显示，用 offset=${endLine + 1} 继续）…`
          ].join('\n'),
          abs,
          false
        )
      }
    }),

    write_file: tool({
      description:
        tr(
          '创建或整体覆盖写入一个文件（自动创建父目录）。会覆盖已有内容，写入前请先 read_file 确认原文。路径相对工作区根目录。',
          'Create or fully overwrite a file (parent directories are created automatically). Existing content is replaced; use read_file first to confirm. Paths are relative to the workspace root.'
        ),
      inputSchema: z.object({
        path: z.string().describe(tr('相对工作区的文件路径', 'File path relative to the workspace')),
        content: z.string().describe(tr('完整文件内容', 'Full file contents'))
      }),
      execute: async ({ path, content }, options) => {
        const refused = await guardWrite('文件未写入', {
          toolCallId: options.toolCallId,
          toolName: 'write_file',
          command: `写入文件 ${path}（${content.length} 字符）`
        })
        if (refused) return refused
        const abs = resolveInside(root, path)
        await fs.mkdir(dirname(abs), { recursive: true })
        await fs.writeFile(abs, content, 'utf8')
        return `已写入 ${relPathOf(root, abs)}（${content.length} 字符）`
      }
    }),

    edit_file: tool({
      description:
        tr(
          '对文件做多处查找替换编辑（只改局部，不整体重写）。oldText 直接用 read_file 看到的原文内容：不要带输出里的「行号 | 」前缀，也不要自己加工转义符。' +
            '系统已容忍行尾（CRLF/LF）、缩进、行尾空白的细微差异，但替换范围以 oldText 为准，所以仍要带上足够上下文、避免误伤相似片段。' +
            '同一段文本出现多处时全部替换；一处都找不到则报错且不落盘（错误里会指出 oldText 首行在文件第几行出现过）。',
          'Apply multiple search/replace edits to a file (local changes only, no full rewrite). oldText must be the exact text seen in read_file: no “line | ” prefix and no escaping changes. ' +
            'Minor differences in line endings (CRLF/LF), indentation, and trailing whitespace are tolerated, but the replacement range follows oldText — include enough context to avoid hitting similar snippets. ' +
            'Every occurrence is replaced; if none is found the call errors and nothing is written (the error reports where oldText’s first line occurs).'
        ),
      inputSchema: z.object({
        path: z.string().describe(tr('相对工作区的文件路径', 'File path relative to the workspace')),
        edits: z
          .array(
            z.object({
              oldText: z.string().describe(tr('要查找的原文片段（照抄 read_file 的内容，不含行号前缀）', 'Exact source text to find (copy read_file output without line-number prefixes)')),
              newText: z.string().describe(tr('替换后的文本', 'Replacement text'))
            })
          )
          .describe(tr('按顺序应用的替换列表', 'List of replacements applied in order'))
      }),
      execute: async ({ path, edits }, options) => {
        if (edits.length === 0) throw new Error('edits 是空的：至少给一处 oldText/newText')
        const abs = resolveInside(root, path)
        let text: string
        try {
          text = await readTextFile(abs)
        } catch (err) {
          // 文件不存在给一句人话：模型常常拿一个猜的路径来 edit（原始 ENOENT 看不出该怎么办）
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            throw new Error(`文件不存在：${path}（edit_file 只能改已存在的文件，新建请用 write_file）`)
          }
          throw err
        }

        /*
         * 先在**内存里**把替换全部跑通，再走审批闸门。
         * 顺序很重要：匹配失败是「这段 oldText 根本没对上」这种**注定失败**的调用，
         * 让用户在确认弹窗上点一次「允许」再去报错，纯属白打扰；反过来确认被拒
         * （只读模式 / 用户点拒绝）时我们一个字节都没落盘，也不会有副作用。
         */
        const applied: string[] = []
        for (const { oldText, newText } of edits) {
          const result = applyTolerantEdit(text, oldText, newText)
          text = result.text
          // 摘要取 oldText 的第一行有效内容（多行 oldText 直接 trim 会把换行也带进结果文案）
          const head = oldText
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.length > 0) ?? ''
          const brief = `${head.slice(0, 40)}${head.length > 40 ? '…' : ''}`
          applied.push(`${brief}（${result.count} 处${result.note ? `，${result.note}` : ''}）`)
        }

        const refused = await guardWrite('文件未被编辑', {
          toolCallId: options.toolCallId,
          toolName: 'edit_file',
          command: `编辑文件 ${path}（${edits.length} 处替换）`
        })
        if (refused) return refused

        await fs.writeFile(abs, text, 'utf8')
        return `已应用 ${applied.length} 处编辑（${relPathOf(root, abs)}）：${applied.join('；')}`
      }
    }),

    search_files: tool({
      description:
        tr(
          '在工作区中按正则搜索文件内容（自动跳过忽略目录、二进制与大文件）。返回命中文件的相对路径、行号与行内容。用于定位符号、关键配置与错误来源。结果很多时用 filesOnly 只拿「文件:命中数」省上下文；要看代码上下文用 context。',
          'Search file contents in the workspace by regex (skips ignored directories, binaries, and large files). Returns relative paths, line numbers, and matching lines. Use it to locate symbols, key config, and error sources. For many results use filesOnly to get “file:count” and save context; use context to see surrounding code.'
        ),
      inputSchema: z.object({
        pattern: z.string().describe(tr('正则表达式（默认区分大小写）', 'Regular expression (case-sensitive by default)')),
        path: z
          .string()
          .optional()
          .describe(tr('搜索起点（相对工作区的文件或目录）：给目录递归搜，给文件只搜这一个，缺省为根目录', 'Search root (file or directory relative to the workspace): directories are searched recursively, a file only itself; defaults to root')),
        filePattern: z.string().optional().describe(tr('限定文件名正则，如 "\\.(ts|tsx|json)$"', 'Optional file-name regex, e.g. "\\.(ts|tsx|json)$"')),
        caseInsensitive: z
          .boolean()
          .optional()
          .describe(tr('忽略大小写（同时作用于 pattern 与 filePattern），默认 false', 'Case-insensitive (applies to pattern and filePattern); default false')),
        filesOnly: z
          .boolean()
          .optional()
          .describe(tr('只返回命中的文件及其命中数（每行 `路径:命中数`），不返回行内容', 'Return only matching files and hit counts (`path:count` per line), not line contents')),
        context: z
          .number()
          .optional()
          .describe(tr('每条命中附带的前后上下文行数（0–5），默认 0。适合需要看清代码结构的场景', 'Context lines around each hit (0–5); default 0. Useful when code structure matters')),
        maxResults: z.number().optional().describe(tr('最大命中行数，默认 200，最大 1000', 'Maximum matching lines; default 200, max 1000'))
      }),
      execute: async ({
        pattern,
        path = '',
        filePattern,
        caseInsensitive = false,
        filesOnly = false,
        context = 0,
        maxResults = 200
      }) => {
        const flags = caseInsensitive ? 'i' : ''
        let re: RegExp
        try {
          re = new RegExp(pattern, flags)
        } catch (e) {
          throw new Error(`无效的正则：${(e as Error).message}`)
        }
        let fileRe: RegExp | null = null
        if (filePattern) {
          try {
            fileRe = new RegExp(filePattern, flags)
          } catch (e) {
            throw new Error(`无效的文件名正则：${(e as Error).message}`)
          }
        }
        const absPath = resolveInside(root, path)
        const stat = await fs.stat(absPath).catch(() => null)
        if (!stat) throw new Error(`路径不存在：${path || '.'}（相对于工作区根）`)
        const ctx = clampInt(context, 0, 5, 0)
        const max = clampInt(maxResults, 1, 1000, 200)
        const acc: SearchAcc = { files: [], hits: 0, max }
        if (stat.isFile()) {
          // 借 OpenCode / ripgrep 的语义：path 显式指向**文件**时只搜这一个文件。
          // 不走忽略规则 —— 显式点名 = 明确意图（.env 这类被忽略的文件也照搜）。
          await scanFile(absPath, relPathOf(root, absPath), re, fileRe, acc, ctx > 0)
        } else {
          const ignored = await createIgnoreChecker(root)
          await searchDir(absPath, root, re, fileRe, ignored, acc, ctx > 0)
        }
        if (!acc.files.length) return '（未找到匹配）'
        if (filesOnly) {
          const rows = acc.files.map((f) => `${f.rel}:${f.hits.length}`)
          return `${rows.join('\n')}\n（${acc.files.length} 个文件，共 ${acc.hits} 处匹配）`
        }
        const full = formatSearchHits(acc, ctx)
        // 超预算就按预算裁剪，但必须说清「还有匹配没查完」与怎么把范围收窄，
        // 而不是让模型以为「只有这些命中」
        const tail =
          acc.hits >= max
            ? `\n…（本轮已到 ${max} 行命中上限，还有匹配没查完：想看更多就提高 maxResults（上限 1000）、缩小 path / filePattern，或换更精确的 pattern）…`
            : ''
        return `${clipToBudget(full, MAX_TOOL_RESULT_CHARS)}${tail}`
      }
    }),

    find_files: tool({
      description:
        tr(
          '按文件名 / 通配符查找文件（如 "*.ts"、"**/*.test.tsx"、"src/**/index.*"）。只匹配文件名，不搜内容（搜内容用 search_files）。自动跳过忽略目录。用于「项目里有哪些 X 文件」这类问题。',
          'Find files by name or glob (e.g. "*.ts", "**/*.test.tsx", "src/**/index.*"). Matches file names only, not contents (use search_files for contents). Ignored directories are skipped. Useful for “which X files exist in this project?”.'
        ),
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(tr('文件名通配符：* 匹配单层任意字符，? 匹配单个字符，** 跨目录；不含 / 时匹配任意层级下的文件名', 'File-name glob: * matches any characters in one segment, ? one character, ** across directories; without / it matches file names at any depth')),
        path: z
          .string()
          .optional()
          .describe(tr('搜索起点（相对工作区的文件或目录）：给目录递归找，给文件只检查这一个，缺省为根目录', 'Search root (file or directory relative to the workspace): directories are searched recursively, a file only itself; defaults to root')),
        maxResults: z.number().optional().describe(tr('最大返回条数，默认 200，最大 1000', 'Maximum results; default 200, max 1000'))
      }),
      execute: async ({ pattern, path = '', maxResults = 200 }) => {
        const re = globToRegExp(pattern)
        const absPath = resolveInside(root, path)
        const stat = await fs.stat(absPath).catch(() => null)
        if (!stat) throw new Error(`路径不存在：${path || '.'}（相对于工作区根）`)
        const max = clampInt(maxResults, 1, 1000, 200)
        const out: string[] = []
        if (stat.isFile()) {
          // 显式给了文件：只检查这一个是否匹配 glob（借 ripgrep --files 的语义）
          const rel = relPathOf(root, absPath)
          if (re.test(rel)) out.push(rel)
        } else {
          const ignored = await createIgnoreChecker(root)
          await findFiles(absPath, root, re, ignored, out, max)
        }
        if (!out.length) return `（没有匹配 ${pattern} 的文件）`
        const more = out.length >= max ? `\n…（已达上限 ${max}，可能有更多）` : ''
        return `${out.length} 个文件：\n${out.join('\n')}${more}`
      }
    }),

    execute_command: tool({
      description:
        tr(
          '在工作区目录下执行 shell 命令并返回输出（stdout + stderr）。适用于运行构建 / 测试 / git 操作 / 安装依赖 / 启动服务等。命令默认超时 120 秒。' +
            '输出超过一个工具结果的预算时会被完整落盘到工作区的 .fizz/tool-output/ 下，结果里给出相对路径、全文行数与本次返回了哪几行；' +
            '其余部分用 read_file 传那个 path 加 offset / limit 按行接着读，也可以用 search_files 检索（常见于构建 / 测试的完整日志）。' +
            '注意这是真实执行环境，删除、覆盖、危险命令（rm -rf、git push --force 等）前先说明影响。' +
            shellNote,
          'Run a shell command in the workspace and return stdout + stderr. Use it for builds, tests, git, installing dependencies, starting services, etc. Default timeout is 120 seconds. ' +
            'If output exceeds one tool result, the full text is saved under .fizz/tool-output/ and the result includes the relative path, total lines, and which lines were returned; ' +
            'read the rest with read_file offset/limit on that path, or search it with search_files (common for full build/test logs). ' +
            'This is a real execution environment: explain the impact before deleting, overwriting, or running dangerous commands (rm -rf, git push --force, etc.). ' +
            shellNoteEn
        ),
      inputSchema: z.object({
        command: z.string().describe(tr('要执行的命令', 'Command to run')),
        timeoutMs: z.number().optional().describe(tr('超时毫秒数，默认 120000，最大 300000', 'Timeout in milliseconds; default 120000, max 300000')),
        cwd: z.string().optional().describe(tr('执行目录（相对工作区），缺省为工作区根目录', 'Working directory (relative to the workspace); defaults to the workspace root'))
      }),
      execute: async ({ command, timeoutMs, cwd = '' }, options) => {
        const refused = await guardWrite('命令未运行', {
          toolCallId: options.toolCallId,
          toolName: 'execute_command',
          command
        })
        if (refused) return refused
        const execDir = resolveInside(root, cwd)
        const stat = await fs.stat(execDir)
        if (!stat.isDirectory())
          throw new Error(`执行目录不是目录：${cwd || '.'}（cwd 必须是目录；要操作某个文件请把路径写进命令里）`)
        const t = clampInt(timeoutMs, 1000, 300_000, 120_000)
        /**
         * per-command 停止器：单条停止（调用方持有的 `stop()`）与整轮停止
         * （`options.abortSignal`）都只 abort 这一个 controller —— 互不影响：
         * 单条停不动 run，整轮停照旧杀进程树（原来的 signal 分支就是它）。
         */
        const ctrl = new AbortController()
        const stop = () => ctrl.abort()
        if (options.abortSignal) {
          if (options.abortSignal.aborted) ctrl.abort()
          else options.abortSignal.addEventListener('abort', stop, { once: true })
        }
        const toolCallId = options.toolCallId
        opts.onCommandStart?.(toolCallId, stop)
        try {
          return await runCommand(command, execDir, t, root, ctrl.signal, {
            onOutput: (stream, chunk) => opts.onCommandOutput?.(toolCallId, stream, chunk),
            onEnd: () => opts.onCommandEnd?.(toolCallId)
          })
        } finally {
          options.abortSignal?.removeEventListener('abort', stop)
        }
      }
    }),

    /**
     * 待办清单（todo list）：把一个**多步骤**任务拆成可勾选条目，边做边维护进度。
     *
     * 为什么是「每次整份重发」而不是 add / update / remove 三个粒度工具：
     * 动态重规划天然就是整份重写 —— 做到一半发现后面的安排不对 / 偏离目标 / 冒出新
     * 需求时，模型需要能自由改写任意条目（增、删、改、换序）。粒度工具反而逼它先算
     * 清「该动哪条」，把一件本来简单的事变成对账。（Claude Code 的 TodoWrite 同此取舍。）
     *
     * 不写盘、不改动任何东西 → 不走 guardWrite（只读模式下也允许）。清单本身随工具
     * 结果进消息历史（见 model-messages 的 toToolOutput），刷新 / 切会话后由渲染端从
     * part 里重建 —— 不需要另立一份服务端存储。
     */
    todo_write: tool({
      description:
        tr(
          '创建 / 更新本次任务的**待办清单**（todo list）。把多步骤任务拆成「一句话一个动作」的' +
            '条目，边做边维护：完成一项就把它的 status 改成 completed、把下一项改成 in_progress。\n' +
            '用法要点：\n' +
            '- 每次调用都要传**当前完整的清单**（整份重发，不是增量 / 不是补丁）；顺序即执行顺序。\n' +
            '- **规划是动态的**：做到某一步发现后面的安排不对、偏离目标、或冒出新需求时，直接改写' +
            '后续条目（增 / 删 / 改 / 换序都行），让清单始终反映真实的下一步，而不是被最初的计划绑死。\n' +
            '- 同一时刻最多保留一条 in_progress（手上正在做的那件）。\n' +
            '- 单步骤 / 琐碎任务不要用这个工具；只在确实有三步以上、值得跟踪时才建清单。\n' +
            '- 任务全部结束后，可以再调用一次传空数组把清单清掉（或全部标 completed 留作记录）。',
          'Create/update the **todo list** for this task. Break a multi-step task into one-action items and maintain progress as you go: mark finished items completed and the next one in_progress.\n' +
            'Usage:\n' +
            '- Every call must send the **current complete list** (full replacement, not a patch); order is execution order.\n' +
            '- **Planning is dynamic**: when later steps no longer fit, the goal shifts, or new requirements appear, rewrite the remaining items (add/remove/edit/reorder) so the list always reflects the real next steps instead of being locked to the original plan.\n' +
            '- Keep at most one in_progress item at a time.\n' +
            '- Do not use this for single-step or trivial tasks; create a list only when there are genuinely 3+ steps worth tracking.\n' +
            '- When everything is done, call once more with an empty array to clear it (or mark all completed to keep a record).'
        ),
      inputSchema: z.object({
        todos: z
          .array(
            z.object({
              content: z.string().describe(tr('这一项要做的事：一句话、具体、可执行（顺序即执行顺序）', 'What to do for this item: one concrete, actionable sentence (order is execution order)')),
              status: z
                .enum(['pending', 'in_progress', 'completed'])
                .describe(tr('pending 待办 / in_progress 进行中 / completed 已完成', 'pending / in_progress / completed'))
            })
          )
          .describe(tr('当前**完整**的任务清单（每次整份重发；空数组 = 清空清单）', 'Current **complete** todo list (resend the whole list each time; empty array clears it)'))
      }),
      execute: async ({ todos }) => {
        // 收口：去掉纯空白条目（模型偶尔会留一条空的占位），其余原样
        const clean = todos
          .map((t) => ({ content: t.content.trim(), status: t.status }))
          .filter((t) => t.content)
        const counts = {
          total: clean.length,
          completed: clean.filter((t) => t.status === 'completed').length,
          inProgress: clean.filter((t) => t.status === 'in_progress').length,
          pending: clean.filter((t) => t.status === 'pending').length
        }
        // 结构化结果：渲染端据此画勾选清单，模型读到的则是紧凑 JSON
        return { ok: true, kind: 'todo', todos: clean, counts }
      }
    }),

    /**
     * 删除文件。存在的意义不只是「省得拼 rm」—— 更重要的是把删除收敛成
     * 一个「单路径 + resolveInside 校验 + 同一道确认闸」的动作：
     * 让模型拼 `rm -rf xxx` 才删，误伤面比单文件大得多。
     */
    delete_file: tool({
      description:
        tr(
          '删除工作区内的文件。默认只删单个文件；path 是目录时必须显式传 recursive=true（会连同目录内所有内容一起删）。路径不存在会报错，不会静默成功。不可恢复操作，调用前请确认路径。',
          'Delete a file in the workspace. By default only a single file is deleted; if path is a directory you must pass recursive=true (deletes all contents too). Missing paths error instead of silently succeeding. This is irreversible — confirm the path before calling.'
        ),
      inputSchema: z.object({
        path: z.string().describe(tr('相对工作区的路径', 'Path relative to the workspace')),
        recursive: z
          .boolean()
          .optional()
          .describe(tr('path 是目录时必须显式传 true 才允许删除，默认 false（此时传目录会报错）', 'When path is a directory, explicitly pass true to allow deletion; default false (passing a directory then errors)'))
      }),
      execute: async ({ path, recursive = false }, options) => {
        const abs = resolveInside(root, path)
        // 先确认存在：删一个不存在的路径直接报错，避免「静默成功」让模型误以为已删除
        let stat: Awaited<ReturnType<typeof fs.stat>>
        try {
          stat = await fs.stat(abs)
        } catch {
          throw new Error(`路径不存在：${path}`)
        }
        const isDir = stat.isDirectory()
        if (isDir && !recursive) {
          throw new Error(
            `${path} 是目录。删除目录必须显式传 recursive: true（会连同目录内所有内容一起删除）。`
          )
        }
        // 破坏性操作：与 execute_command / write_file 同一道闸，不能绕
        const refused = await guardWrite('内容未被删除', {
          toolCallId: options.toolCallId,
          toolName: 'delete_file',
          command: isDir ? `删除目录（含全部内容）：${path}` : `删除文件：${path}`
        })
        if (refused) return refused
        if (isDir) await fs.rm(abs, { recursive: true })
        else await fs.unlink(abs)
        return `已删除${isDir ? '目录' : '文件'} ${path}`
      }
    }),

    // 技能说明通常在**工作区之外**（用户级 / Claude 兼容目录），read_file 的
    // resolveInside 够不着，所以单独给一个只读工具（范围限制在已发现的技能目录内）。
    // 没有可用技能时干脆不暴露这个工具，免得模型拿着空清单乱试。
    ...(opts.skills?.length ? buildReadSkillTool(opts.skills) : {})
  }
  return filterToolSet(all as ToolSet, opts.includeTools)
}
