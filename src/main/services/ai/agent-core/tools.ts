/**
 * 工作区 Agent 工具集：文件读取 / 查找 / 写入 / 编辑 / 删除 / 执行命令。
 *
 * 所有工具都绑定一个工作区根目录（root），文件路径一律相对工作区，
 * 经 resolveInside 越界校验后落盘，防止 Agent 逃出工作区。
 *
 * 权限：**会改动东西的工具**（execute_command / delete_file / write_file / edit_file）
 * 统一走 `guardWrite` 一道闸 —— 确认模式下弹卡片等用户点「允许」，被拒绝就当次调用放弃；
 * 只读类工具（list_files / read_file / search_files / find_files / read_skill）任何模式下都不拦。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import {
  convertToLineEnding,
  detectLineEnding,
  normalizeLineEndings,
  replaceContent
} from './edit-match'
import { buildReadSkillTool, type AgentSkill } from './skills'
import { createIgnoreChecker, relPathOf, resolveInside } from './workspace'

export type AgentPermissionMode = 'full' | 'confirm'

/**
 * read_file 单次输出的字符上限。超了就停在这一行，给出「用 offset=N 继续」的指引
 * （与 opencode 的 50KB 封顶同一思路：模型该按窗口读大文件，而不是一口气吞进去）。
 */
const MAX_READ_OUTPUT_CHARS = 60_000
/** read_file 单行截断长度（minified / 压缩成一行的文件不再撑爆结果） */
const MAX_READ_LINE_CHARS = 2000
/** read_file 拒绝读取的文件大小上限（文本工作区文件远达不到；超出建议走 search / 命令） */
const MAX_READ_FILE_BYTES = 30_000_000
/** 二进制探测的采样字节数 */
const BINARY_SAMPLE_BYTES = 8192
/** 命令输出保留上限（超出时保留头部 4KB + 尾部 26KB） */
const MAX_CMD_OUT = 30_000
/** 搜索文件的大小上限（1MB，跳过大文件避免卡死） */
const MAX_SEARCH_FILE_SIZE = 1_048_576
/** 搜索命中的单行截断长度 */
const MAX_LINE_CHARS = 200

/** 一个已读文件的快照：写 / 编辑前用它判定「模型手里的内容还是不是新的」 */
export interface AgentFileSnapshot {
  mtimeMs: number
  size: number
}

/**
 * 会话级的「已读文件」状态（先读后改的依据）。
 *
 * 工具集每轮对话都会重建（见 services/ai/agent.ts），这个状态必须由调用方持有并跨轮
 * 传入 —— 与 Claude Code 的 ReadState 同一语义：read_file 记录快照，write_file /
 * edit_file 校验快照（没读过 / 读后被外部改动都不放行）。
 */
export interface AgentFileState {
  /** key 为文件绝对路径 */
  reads: Map<string, AgentFileSnapshot>
}

export function createAgentFileState(): AgentFileState {
  return { reads: new Map() }
}

export interface AgentToolOptions {
  /** 确认模式下**会改动东西的工具**（执行命令 / 写 / 编辑 / 删除）执行前需用户批准 */
  permissionMode: AgentPermissionMode
  requestConfirm?: (req: {
    toolCallId: string
    toolName: string
    command: string
  }) => Promise<boolean>
  /** 可用技能（见 skills.ts）；有值时额外暴露 read_skill 工具，空值不暴露 */
  skills?: AgentSkill[]
  /**
   * Windows 上 execute_command 的 POSIX shell（Git Bash 的 bash.exe 绝对路径），由调用方注入
   * （见 services/ai/agent.ts）。有值：命令经由 `<bash> -lc` 执行，模型拿到的是 Linux 工具链
   * （ls / grep / sed / 管道……）；空值：回退 PowerShell。POSIX 平台不走这个字段（始终 bash）。
   */
  bashPath?: string | null
  /**
   * 「先读后改」状态（见 AgentFileState）。不传时跳过校验（探针 / 轻量调用方），
   * 正常 Agent 路径必须传，否则模型可以不看文件就覆盖内容。
   */
  fileState?: AgentFileState
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback
  return Math.max(min, Math.min(max, Math.trunc(v)))
}

/**
 * 二进制探测（采样首部）：含 NUL 即判二进制；不可打印字符（除 \t \n \r 等控制空白外）
 * 占比超 30% 也判二进制 —— 与 opencode 同一启发式，能挡住「读出来全是乱码」的浪费。
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SAMPLE_BYTES)
  if (n === 0) return false
  let nonPrintable = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) nonPrintable++
  }
  return nonPrintable / n > 0.3
}

/** 找不到文件时，在同一目录里找名字相近的文件给模型指路（大小写不敏感，最多 3 个） */
async function suggestSimilarFiles(abs: string): Promise<string[]> {
  try {
    const dir = dirname(abs)
    const base = basename(abs).toLowerCase()
    const entries = await fs.readdir(dir)
    return entries
      .filter((e) => {
        const l = e.toLowerCase()
        return l !== base && (l.includes(base) || base.includes(l))
      })
      .slice(0, 3)
  } catch {
    return []
  }
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
    if (fileRe && !fileRe.test(ent.name)) continue
    await searchFile(abs, root, re, needSource, acc)
  }
}

/** 单文件内容搜索：命中即累计进 `acc`。大文件 / 二进制直接跳过。 */
async function searchFile(
  abs: string,
  root: string,
  re: RegExp,
  needSource: boolean,
  acc: SearchAcc
): Promise<void> {
  if (acc.hits >= acc.max) return
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
  if (hits.length) {
    const rel = relPathOf(root, abs)
    acc.files.push(needSource ? { rel, hits, source } : { rel, hits })
  }
}

/**
 * 把 glob 编译成 RegExp：`**` 跨目录，`*` / `?` 不跨 `/`。
 * 不含 `/` 的 glob（如 `*.ts`）自动补 `**​/` 前缀，让它能匹配任意层级 —— 符合直觉。
 */
function globToRegExp(glob: string): RegExp {
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

function truncateOutput(s: string, max = MAX_CMD_OUT): string {
  if (s.length <= max) return s
  const head = 4000
  const tail = s.slice(-(max - head))
  return `${s.slice(0, head)}\n…（输出过长，已截断，共 ${s.length} 字符）…\n${tail}`
}

function killChild(child: ReturnType<typeof spawn>, isWin: boolean): void {
  if (child.exitCode !== null || child.killed) return
  if (isWin) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // 忽略
      }
    }
  } else {
    try {
      process.kill(-(child.pid ?? 0), 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // 忽略
      }
    }
  }
}

/**
 * 在工作区目录下执行 shell 命令：输出 stdout + stderr（截断），
 * 超时 / abortSignal 触发时终止整个进程树（POSIX 用进程组，Windows 用 taskkill /T）。
 *
 * shell 选择：POSIX 恒为 bash；Windows 优先用注入的 Git Bash（`bashPath`）——
 * 模型拿到的是 POSIX 工具链（ls / grep / 管道…），与主流编码代理一致；
 * 没有 Git Bash 时回退 PowerShell（强制 UTF-8 输出，cmd 的 GBK 会乱码）。
 */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  bashPath?: string | null
): Promise<string> {
  const isWin = process.platform === 'win32'
  const useBash = !isWin || Boolean(bashPath)
  const shellCmd = isWin ? (bashPath ?? 'powershell.exe') : '/bin/bash'
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
    // Git Bash 的 coreutils 在 <Git>\usr\bin：登录 profile 之外再显式置前，
    // 保证 ls / grep 一定找得到（继承的 Windows PATH 里通常没有它）
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
    const finish = (reason: 'exit' | 'timeout' | 'aborted', code?: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const info =
        reason === 'exit'
          ? `（退出码 ${code}）`
          : reason === 'timeout'
            ? `（超时 ${timeoutMs}ms，已终止进程树）`
            : '（已中止）'
      const err = stderr.trim()
      const body = truncateOutput(stdout.trim())
      resolve(`$ ${command}\n${info}\n${body}${err ? `\n${err}` : ''}`)
    }
    const onAbort = () => {
      killChild(child, isWin)
      finish('aborted')
    }
    const timer = setTimeout(() => {
      killChild(child, isWin)
      finish('timeout')
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
      if (stdout.length > MAX_CMD_OUT) stdout = stdout.slice(-MAX_CMD_OUT)
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
      if (stderr.length > MAX_CMD_OUT) stderr = stderr.slice(-MAX_CMD_OUT)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(`$ ${command}\n（命令启动失败：${err.message}）`)
    })
    child.on('exit', (code) => finish('exit', code))
  })
}

// ---------- 工具集 ----------

/** 构建工作区 Agent 工具集（绑定 root 目录；确认模式下改动类工具先请示用户） */
export function buildAgentTools(root: string, opts: AgentToolOptions): ToolSet {
  const confirm = opts.requestConfirm
  const needConfirm = opts.permissionMode === 'confirm' && !!confirm
  const isWin = process.platform === 'win32'
  const bashPath = opts.bashPath ?? null
  const fileState = opts.fileState
  // 工具描述必须如实描述执行环境，模型才会放心用对应风格的命令
  const shellNote = isWin
    ? bashPath
      ? '命令运行在 Git Bash（POSIX）环境：可以用 ls / grep / sed / find / cat / 管道等 Unix 工具与语法；Windows 路径建议写成 C:/xxx 或 /c/xxx 形式。'
      : '命令运行在 PowerShell 环境（未检测到 Git Bash）。'
    : '命令运行在 bash 环境。'

  /**
   * 改动类工具的**统一闸门**（与 fishwork 的 `guardWrite` 同一套语义）。
   *
   * 返回 `null` = 放行；返回字符串 = 这串就是**工具结果**（回绝说明），直接 `return` 回去 ——
   * 刻意不抛错：回绝是「预期内的结果」，让模型看到原因后能向用户解释，
   * 而不是变成一个工具报错把整轮打断。
   *
   * 必须过闸的是**会动磁盘 / 动进程**的工具：execute_command、delete_file、
   * write_file、edit_file。新增工具时想清楚它会不会改动东西 —— 会，就得走这里。
   */
  const guardWrite = async (
    /** 回绝时的短句，拼进工具结果（如「文件未写入：src/a.ts」） */
    denied: string,
    req: { toolCallId: string; toolName: string; command: string }
  ): Promise<string | null> => {
    if (!needConfirm || !confirm) return null
    const approved = await confirm(req)
    return approved
      ? null
      : `用户拒绝了这次调用（${denied}）。请询问用户接下来希望怎么做，不要擅自重试同一步。`
  }

  /**
   * 「先读后改」：成功读到文件后记录快照（write / edit 成功后也记录 —— 写完的内容
   * 模型自然是知道的，后续编辑不必强制重读）。
   */
  const noteRead = async (abs: string): Promise<void> => {
    if (!fileState) return
    try {
      const st = await fs.stat(abs)
      fileState.reads.set(abs, { mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      // 文件刚被删等情况：不记快照，后续写 / 编辑自然会拿到「不存在」的明确报错
    }
  }

  /**
   * 写 / 编辑前的「先读后改」校验。返回 null = 放行；返回字符串 = 拒绝说明
   * （同 guardWrite 的约定：这是预期内的回绝，让模型自行纠正，不当作工具报错打断整轮）。
   *
   * 校验两件事：本会话读过该文件（模型必须基于真实内容修改，不许凭想象覆盖）；
   * 读取之后文件没被外部改动（模型手里的内容还作数）。
   */
  const assertReadForModify = async (abs: string, action: string): Promise<string | null> => {
    if (!fileState) return null
    const rel = relPathOf(root, abs)
    const snap = fileState.reads.get(abs)
    if (!snap) {
      return `${action}失败：本次会话还没有读过 ${rel}。请先 read_file 查看文件内容，再基于真实内容做修改（不要凭记忆或猜测覆盖文件）。`
    }
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(abs)
    } catch {
      return `${action}失败：${rel} 在读取之后已不存在（可能被外部删除）。请先确认文件状态。`
    }
    if (stat.mtimeMs !== snap.mtimeMs || stat.size !== snap.size) {
      return `${action}失败：${rel} 在读取之后又被修改过（可能是用户或其它程序改的）。请重新 read_file 确认最新内容后再试。`
    }
    return null
  }

  return {
    list_files: tool({
      description:
        '列出工作区目录内容（自动忽略 .git、node_modules、构建产物与 .gitignore 规则）。返回每个条目的相对路径，目录带 / 后缀，文件附大小。适合先了解项目结构。',
      inputSchema: z.object({
        path: z.string().optional().describe('相对工作区的目录路径，缺省为工作区根目录'),
        depth: z.number().optional().describe('递归深度，默认 0（仅当前目录），最大 4')
      }),
      execute: async ({ path = '', depth = 0 }) => {
        const absDir = resolveInside(root, path)
        const stat = await fs.stat(absDir)
        if (!stat.isDirectory()) throw new Error(`不是目录：${path || '.'}`)
        const ignored = await createIgnoreChecker(root)
        const lines: string[] = []
        await listDir(absDir, root, clampInt(depth, 0, 4, 0), ignored, lines)
        return lines.length ? lines.join('\n') : '（空目录）'
      }
    }),

    read_file: tool({
      description:
        '读取文件内容。输出每行带「行号: 内容」前缀（构造 edit_file 的 oldString 时只要冒号后面的原文，绝不要把行号前缀带进去）。' +
        '默认最多 2000 行；大文件按结尾提示的 offset 继续读取，不要反复读 30 行级别的小窗口。' +
        '要找内容位置先用 search_files；不确定文件名先用 find_files。路径相对工作区根目录。',
      inputSchema: z.object({
        path: z.string().describe('相对工作区的文件路径'),
        offset: z.number().optional().describe('起始行号（1 起），缺省 1'),
        limit: z.number().optional().describe('返回行数上限，默认 2000，最大 2000')
      }),
      execute: async ({ path, offset = 1, limit }) => {
        const abs = resolveInside(root, path)
        let stat: Awaited<ReturnType<typeof fs.stat>>
        try {
          stat = await fs.stat(abs)
        } catch {
          const suggestions = await suggestSimilarFiles(abs)
          const relDir = relPathOf(root, dirname(abs))
          const prefix = relDir === '.' ? '' : `${relDir}/`
          const hint = suggestions.length
            ? `\n\n你是不是想要这些文件之一？\n${suggestions.map((s) => `${prefix}${s}`).join('\n')}`
            : ''
          throw new Error(`文件不存在：${path}${hint}`)
        }
        if (stat.isDirectory()) {
          throw new Error(`${path} 是目录。要浏览目录结构请用 list_files。`)
        }
        if (stat.size > MAX_READ_FILE_BYTES) {
          throw new Error(
            `文件过大（${(stat.size / 1_048_576).toFixed(1)}MB），read_file 不支持。请用 search_files 定位内容，或用 execute_command（如 sed -n '10,50p' ${path}）按需查看。`
          )
        }
        const buf = await fs.readFile(abs)
        if (looksBinary(buf)) throw new Error('二进制文件，无法以文本方式读取')
        const text = buf.toString('utf8')
        const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
        const start = Math.max(0, offset - 1)
        if (start >= lines.length && !(offset === 1 && lines.length === 0)) {
          throw new Error(`offset ${offset} 超出范围（文件共 ${lines.length} 行）`)
        }
        const cap = clampInt(limit, 1, 2000, 2000)
        // 逐行取出，直到行数上限或输出字符上限：字符上限触发时提示从下一行续读
        const taken: string[] = []
        let chars = 0
        let cutByChars = false
        const end = Math.min(start + cap, lines.length)
        for (let i = start; i < end; i++) {
          let line = lines[i]
          if (line.length > MAX_READ_LINE_CHARS) {
            line = `${line.slice(0, MAX_READ_LINE_CHARS)}…（本行超长，已截断）`
          }
          const size = line.length + 1
          if (taken.length > 0 && chars + size > MAX_READ_OUTPUT_CHARS) {
            cutByChars = true
            break
          }
          taken.push(line)
          chars += size
        }
        const last = start + taken.length
        let footer: string
        if (cutByChars) {
          footer = `\n\n（输出已达字符上限，显示第 ${offset}-${last} 行。用 offset=${last + 1} 继续读取）`
        } else if (last < lines.length) {
          footer = `\n\n（显示第 ${offset}-${last} 行，共 ${lines.length} 行。用 offset=${last + 1} 继续读取）`
        } else {
          footer = `\n\n（文件结尾，共 ${lines.length} 行）`
        }
        const body = taken.map((l, i) => `${start + i + 1}: ${l}`).join('\n')
        await noteRead(abs)
        return `${relPathOf(root, abs)}（共 ${lines.length} 行）\n${body}${footer}`
      }
    }),

    write_file: tool({
      description:
        '创建新文件，或对已有文件做**有意的整体重写**（自动创建父目录）。' +
        '优先用 edit_file 做局部修改，不要动不动整文件重写；也不要主动创建文档类文件（README / *.md）除非用户明确要求。' +
        '覆盖已有文件前必须先用 read_file 读过（本会话内），否则会被拒绝。路径相对工作区根目录。',
      inputSchema: z.object({
        path: z.string().describe('相对工作区的文件路径'),
        content: z.string().describe('完整文件内容')
      }),
      execute: async ({ path, content }, options) => {
        const abs = resolveInside(root, path)
        const rel = relPathOf(root, abs)
        // 已存在的文件必须先读过：防止模型凭想象把用户文件整个覆盖掉
        const exists = await fs
          .stat(abs)
          .then(() => true)
          .catch(() => false)
        if (exists) {
          const stale = await assertReadForModify(abs, '覆盖写入')
          if (stale) return stale
        }
        // 会覆盖已有内容、且无法撤销：与执行命令同一道闸
        const refused = await guardWrite(`文件未写入：${rel}`, {
          toolCallId: options.toolCallId,
          toolName: 'write_file',
          command: `写入文件 ${rel}（${content.length} 字符，${exists ? '覆盖' : '新建'}）`
        })
        if (refused) return refused
        await fs.mkdir(dirname(abs), { recursive: true })
        await fs.writeFile(abs, content, 'utf8')
        await noteRead(abs)
        return `${exists ? '已覆盖写入' : '已创建'} ${rel}（${content.length} 字符）`
      }
    }),

    edit_file: tool({
      description:
        '对文件做精确的字符串替换（只改局部，不整体重写）。必须先用 read_file 读过目标文件（本会话内），oldString 从读取输出中复制（不要带「行号: 」前缀）。' +
        'oldString 必须唯一命中：多处出现时报错 —— 请扩大上下文使其唯一，或传 replaceAll: true 全部替换（重命名变量等场景）。' +
        '找不到时通常是细节记岔了：重新 read_file 再试。路径相对工作区根目录。',
      inputSchema: z.object({
        path: z.string().describe('相对工作区的文件路径'),
        oldString: z.string().describe('要替换的原文片段（必须与文件内容精确一致，且在文件中唯一）'),
        newString: z.string().describe('替换后的文本（必须与 oldString 不同）'),
        replaceAll: z
          .boolean()
          .optional()
          .describe('替换 oldString 的全部出现（默认 false，此时多处出现会报错）')
      }),
      execute: async ({ path, oldString, newString, replaceAll = false }, options) => {
        const abs = resolveInside(root, path)
        const rel = relPathOf(root, abs)
        if (!oldString.trim()) {
          throw new Error(
            'oldString 不能为空。编辑已有文件请提供要替换的原文；新建 / 整体重写请用 write_file。'
          )
        }
        // 先读后改：模型必须基于真实内容修改（文件不存在时给「用 write_file」的指引）
        const exists = await fs
          .stat(abs)
          .then(() => true)
          .catch(() => false)
        if (!exists) throw new Error(`文件不存在：${path}。新建文件请用 write_file。`)
        const stale = await assertReadForModify(abs, '编辑')
        if (stale) return stale
        const buf = await fs.readFile(abs)
        if (looksBinary(buf)) throw new Error('二进制文件，无法编辑')
        const contentOld = buf.toString('utf8')
        // 换行符归一：模型输出恒为 \n；文件是 CRLF 时把 old/new 转成 \r\n 再匹配，
        // 写回时天然保留文件的换行风格（Windows 下没有这步，编辑 CRLF 文件必失败）
        const ending = detectLineEnding(contentOld)
        const old = convertToLineEnding(normalizeLineEndings(oldString), ending)
        const replacement = convertToLineEnding(normalizeLineEndings(newString), ending)
        // 匹配 + 试算都在内存里完成（找不到 / 多处 / 抓错块在这里抛错），
        // 确认卡为「真的会落盘」而弹，注定失败的编辑不值得打扰用户。
        const applied = replaceContent(contentOld, old, replacement, replaceAll)
        const refused = await guardWrite(`文件未被编辑：${rel}`, {
          toolCallId: options.toolCallId,
          toolName: 'edit_file',
          command: `编辑文件 ${rel}（精确替换${replaceAll ? '，全部出现' : ''}）`
        })
        if (refused) return refused
        await fs.writeFile(abs, applied.text, 'utf8')
        await noteRead(abs)
        return `已编辑 ${rel}（替换 ${applied.count} 处）`
      }
    }),

    search_files: tool({
      description:
        '在工作区中按正则搜索文件内容（自动跳过忽略目录、二进制与大文件）。返回命中文件的相对路径、行号与行内容。用于定位符号、关键配置与错误来源。结果很多时用 filesOnly 只拿「文件:命中数」省上下文；要看代码上下文用 context。',
      inputSchema: z.object({
        pattern: z.string().describe('正则表达式（默认区分大小写）'),
        path: z.string().optional().describe('搜索起点：相对工作区的目录或单个文件；缺省为根目录'),
        filePattern: z.string().optional().describe('限定文件名正则，如 "\\.(ts|tsx|json)$"'),
        caseInsensitive: z
          .boolean()
          .optional()
          .describe('忽略大小写（同时作用于 pattern 与 filePattern），默认 false'),
        filesOnly: z
          .boolean()
          .optional()
          .describe('只返回命中的文件及其命中数（每行 `路径:命中数`），不返回行内容'),
        context: z
          .number()
          .optional()
          .describe('每条命中附带的前后上下文行数（0–5），默认 0。适合需要看清代码结构的场景'),
        maxResults: z.number().optional().describe('最大命中行数，默认 200，最大 1000')
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
        const absDir = resolveInside(root, path)
        const stat = await fs.stat(absDir)
        const ignored = await createIgnoreChecker(root)
        const ctx = clampInt(context, 0, 5, 0)
        const max = clampInt(maxResults, 1, 1000, 200)
        const acc: SearchAcc = { files: [], hits: 0, max }
        if (stat.isDirectory()) {
          await searchDir(absDir, root, re, fileRe, ignored, acc, ctx > 0)
        } else {
          // path 指向单个文件：直接在文件内搜索（仍受 filePattern / ignore 约束）
          const rel = relPathOf(root, absDir)
          if (ignored(rel, false)) return '（未找到匹配）'
          if (fileRe && !fileRe.test(basename(absDir))) {
            return '（文件名不匹配 filePattern）'
          }
          await searchFile(absDir, root, re, ctx > 0, acc)
        }
        if (!acc.files.length) return '（未找到匹配）'
        if (filesOnly) {
          const rows = acc.files.map((f) => `${f.rel}:${f.hits.length}`)
          return `${rows.join('\n')}\n（${acc.files.length} 个文件，共 ${acc.hits} 处匹配）`
        }
        const more = acc.hits >= max ? `\n…（已达上限 ${max} 行，可能有更多）` : ''
        return formatSearchHits(acc, ctx) + more
      }
    }),

    find_files: tool({
      description:
        '按文件名 / 通配符查找文件（如 "*.ts"、"**/*.test.tsx"、"src/**/index.*"）。只匹配文件名，不搜内容（搜内容用 search_files）。自动跳过忽略目录。用于「项目里有哪些 X 文件」这类问题。',
      inputSchema: z.object({
        pattern: z
          .string()
          .describe('文件名通配符：* 匹配单层任意字符，? 匹配单个字符，** 跨目录；不含 / 时匹配任意层级下的文件名'),
        path: z.string().optional().describe('搜索起点目录（相对工作区），缺省为根目录'),
        maxResults: z.number().optional().describe('最大返回条数，默认 200，最大 1000')
      }),
      execute: async ({ pattern, path = '', maxResults = 200 }) => {
        const re = globToRegExp(pattern)
        const absDir = resolveInside(root, path)
        const stat = await fs.stat(absDir)
        if (!stat.isDirectory()) throw new Error(`不是目录：${path || '.'}`)
        const ignored = await createIgnoreChecker(root)
        const max = clampInt(maxResults, 1, 1000, 200)
        const out: string[] = []
        await findFiles(absDir, root, re, ignored, out, max)
        if (!out.length) return `（没有匹配 ${pattern} 的文件）`
        const more = out.length >= max ? `\n…（已达上限 ${max}，可能有更多）` : ''
        return `${out.length} 个文件：\n${out.join('\n')}${more}`
      }
    }),

    execute_command: tool({
      description:
        '在工作区目录下执行 shell 命令并返回输出（stdout + stderr，自动截断）。适用于运行构建 / 测试 / git 操作 / 安装依赖 / 启动服务等。命令默认超时 120 秒。注意这是真实执行环境，删除、覆盖、危险命令（rm -rf、git push --force 等）前先说明影响。' +
        shellNote,
      inputSchema: z.object({
        command: z.string().describe('要执行的命令'),
        timeoutMs: z.number().optional().describe('超时毫秒数，默认 120000，最大 300000'),
        cwd: z.string().optional().describe('执行目录（相对工作区），缺省为工作区根目录')
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
        if (!stat.isDirectory()) throw new Error(`执行目录不是目录：${cwd || '.'}`)
        const t = clampInt(timeoutMs, 1000, 300_000, 120_000)
        return runCommand(command, execDir, t, options.abortSignal, bashPath)
      }
    }),

    /**
     * 删除文件。存在的意义不只是「省得拼 rm」—— 更重要的是把删除收敛成
     * 一个「单路径 + resolveInside 校验 + 同一道确认闸」的动作：
     * 让模型拼 `rm -rf xxx` 才删，误伤面比单文件大得多。
     */
    delete_file: tool({
      description:
        '删除工作区内的文件。默认只删单个文件；path 是目录时必须显式传 recursive=true（会连同目录内所有内容一起删）。路径不存在会报错，不会静默成功。不可恢复操作，调用前请确认路径。',
      inputSchema: z.object({
        path: z.string().describe('相对工作区的路径'),
        recursive: z
          .boolean()
          .optional()
          .describe('path 是目录时必须显式传 true 才允许删除，默认 false（此时传目录会报错）')
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
        // 破坏性操作：确认模式下必须请示（与写 / 执行同一道闸，不能绕）
        const refused = await guardWrite(isDir ? `目录未被删除：${path}` : `文件未被删除：${path}`, {
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
}
