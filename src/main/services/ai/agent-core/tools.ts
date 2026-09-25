/**
 * 工作区 Agent 工具集：文件读取 / 查找 / 写入 / 编辑 / 删除 / 执行命令。
 *
 * 所有工具都绑定一个工作区根目录（root），文件路径一律相对工作区，
 * 经 resolveInside 越界校验后落盘，防止 Agent 逃出工作区。
 * 破坏性工具（execute_command、delete_file）在确认模式下统一经 requestConfirm 请示用户。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { buildReadSkillTool, type AgentSkill } from './skills'
import { createIgnoreChecker, relPathOf, resolveInside } from './workspace'

export type AgentPermissionMode = 'full' | 'confirm'

/** 单次文件读取 / 搜索的结果字符上限 */
const MAX_FILE_CHARS = 200_000
/** 命令输出保留上限（超出时保留头部 4KB + 尾部 26KB） */
const MAX_CMD_OUT = 30_000
/** 搜索文件的大小上限（1MB，跳过大文件避免卡死） */
const MAX_SEARCH_FILE_SIZE = 1_048_576
/** 搜索命中的单行截断长度 */
const MAX_LINE_CHARS = 200

export interface AgentToolOptions {
  /** 确认模式下 execute_command 执行前需用户批准 */
  permissionMode: AgentPermissionMode
  requestConfirm?: (req: {
    toolCallId: string
    toolName: string
    command: string
  }) => Promise<boolean>
  /** 可用技能（见 skills.ts）；有值时额外暴露 read_skill 工具，空值不暴露 */
  skills?: AgentSkill[]
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback
  return Math.max(min, Math.min(max, Math.trunc(v)))
}

/** 读取文本文件：二进制（含 NUL）与超大文件直接报错，让模型改用 search/分段 */
async function readTextFile(abs: string): Promise<string> {
  const stat = await fs.stat(abs)
  if (stat.isDirectory()) throw new Error(`不是文件：${basename(abs)}`)
  const buf = await fs.readFile(abs)
  if (buf.includes(0)) throw new Error('二进制文件，无法以文本方式读取')
  const text = buf.toString('utf8')
  if (text.length > MAX_FILE_CHARS) {
    throw new Error(
      `文件过大（${text.length} 字符），请先用 search_files 定位关键内容，再用 read_file 的 offset/limit 分段读取`
    )
  }
  return text
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
    const stat = await fs.stat(abs)
    if (stat.size > MAX_SEARCH_FILE_SIZE) continue
    const buf = await fs.readFile(abs)
    if (buf.includes(0)) continue
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
 */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const isWin = process.platform === 'win32'
  // Windows 用 PowerShell 并强制 UTF-8 输出（cmd 的 GBK 会乱码）；
  // POSIX 用 bash -lc，进程组 detached 便于整树终止
  const shellCmd = isWin ? 'powershell.exe' : '/bin/bash'
  const shellArgs = isWin
    ? [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;${command}`
      ]
    : ['-lc', command]
  const child = spawn(shellCmd, shellArgs, {
    cwd,
    env: process.env,
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

/** 构建工作区 Agent 工具集（绑定 root 目录；确认模式下 execute_command 先请示用户） */
export function buildAgentTools(root: string, opts: AgentToolOptions): ToolSet {
  const needConfirm = opts.permissionMode === 'confirm' && !!opts.requestConfirm

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
        '读取文件内容并附行号，用于理解源码 / 配置 / 文档。路径相对工作区根目录。大文件可用 offset/limit 分段读取。',
      inputSchema: z.object({
        path: z.string().describe('相对工作区的文件路径'),
        offset: z.number().optional().describe('起始行号（1 起），缺省 1'),
        limit: z.number().optional().describe('返回行数上限，默认 500，最大 2000')
      }),
      execute: async ({ path, offset = 1, limit = 500 }) => {
        const abs = resolveInside(root, path)
        const text = await readTextFile(abs)
        const lines = text.split('\n')
        const start = Math.max(0, offset - 1)
        const slice = lines.slice(start, start + clampInt(limit, 1, 2000, 500))
        const body = slice
          .map((l, i) => `${String(start + i + 1).padStart(5)} | ${l}`)
          .join('\n')
        const truncated = start + slice.length < lines.length ? `\n…（共 ${lines.length} 行，已截断）` : ''
        return `${relPathOf(root, abs)}（共 ${lines.length} 行）\n${body}${truncated}`
      }
    }),

    write_file: tool({
      description:
        '创建或整体覆盖写入一个文件（自动创建父目录）。会覆盖已有内容，写入前请先 read_file 确认原文。路径相对工作区根目录。',
      inputSchema: z.object({
        path: z.string().describe('相对工作区的文件路径'),
        content: z.string().describe('完整文件内容')
      }),
      execute: async ({ path, content }) => {
        const abs = resolveInside(root, path)
        await fs.mkdir(dirname(abs), { recursive: true })
        await fs.writeFile(abs, content, 'utf8')
        return `已写入 ${relPathOf(root, abs)}（${content.length} 字符）`
      }
    }),

    edit_file: tool({
      description:
        '对文件做多处查找替换编辑（只改局部，不整体重写）。oldText 必须能在文件中找到（找不到即报错，不落盘）；同一段文本多处出现时全部替换。oldText 要带上足够上下文，避免误伤其它相似片段。',
      inputSchema: z.object({
        path: z.string().describe('相对工作区的文件路径'),
        edits: z
          .array(
            z.object({
              oldText: z.string().describe('要查找的原文片段'),
              newText: z.string().describe('替换后的文本')
            })
          )
          .describe('按顺序应用的替换列表')
      }),
      execute: async ({ path, edits }) => {
        const abs = resolveInside(root, path)
        let text = await readTextFile(abs)
        const applied: string[] = []
        for (const { oldText, newText } of edits) {
          if (!oldText.trim()) throw new Error('oldText 不能为空')
          const count = text.split(oldText).length - 1
          if (count === 0) throw new Error(`未找到要替换的内容：${oldText.slice(0, 60)}`)
          text = text.split(oldText).join(newText)
          applied.push(`${oldText.slice(0, 40)}${oldText.length > 40 ? '…' : ''}（${count} 处）`)
        }
        await fs.writeFile(abs, text, 'utf8')
        return `已应用 ${applied.length} 处编辑（${relPathOf(root, abs)}）：${applied.join('；')}`
      }
    }),

    search_files: tool({
      description:
        '在工作区中按正则搜索文件内容（自动跳过忽略目录、二进制与大文件）。返回命中文件的相对路径、行号与行内容。用于定位符号、关键配置与错误来源。结果很多时用 filesOnly 只拿「文件:命中数」省上下文；要看代码上下文用 context。',
      inputSchema: z.object({
        pattern: z.string().describe('正则表达式（默认区分大小写）'),
        path: z.string().optional().describe('搜索起点目录（相对工作区），缺省为根目录'),
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
        if (!stat.isDirectory()) throw new Error(`不是目录：${path || '.'}`)
        const ignored = await createIgnoreChecker(root)
        const ctx = clampInt(context, 0, 5, 0)
        const max = clampInt(maxResults, 1, 1000, 200)
        const acc: SearchAcc = { files: [], hits: 0, max }
        await searchDir(absDir, root, re, fileRe, ignored, acc, ctx > 0)
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
        '在工作区目录下执行 shell 命令并返回输出（stdout + stderr，自动截断）。适用于运行构建 / 测试 / git 操作 / 安装依赖 / 启动服务等。命令默认超时 120 秒。注意这是真实执行环境，删除、覆盖、危险命令（rm -rf、git push --force 等）前先说明影响。',
      inputSchema: z.object({
        command: z.string().describe('要执行的命令'),
        timeoutMs: z.number().optional().describe('超时毫秒数，默认 120000，最大 300000'),
        cwd: z.string().optional().describe('执行目录（相对工作区），缺省为工作区根目录')
      }),
      execute: async ({ command, timeoutMs, cwd = '' }, options) => {
        if (needConfirm && opts.requestConfirm) {
          const approved = await opts.requestConfirm({
            toolCallId: options.toolCallId,
            toolName: 'execute_command',
            command
          })
          if (!approved) {
            return '用户取消了本次命令执行（命令未运行）。请询问用户接下来希望怎么做，不要擅自重试同一条命令。'
          }
        }
        const execDir = resolveInside(root, cwd)
        const stat = await fs.stat(execDir)
        if (!stat.isDirectory()) throw new Error(`执行目录不是目录：${cwd || '.'}`)
        const t = clampInt(timeoutMs, 1000, 300_000, 120_000)
        return runCommand(command, execDir, t, options.abortSignal)
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
        // 破坏性操作：确认模式下必须请示（与 execute_command 同一道闸，不能绕）
        if (needConfirm && opts.requestConfirm) {
          const approved = await opts.requestConfirm({
            toolCallId: options.toolCallId,
            toolName: 'delete_file',
            command: isDir ? `删除目录（含全部内容）：${path}` : `删除文件：${path}`
          })
          if (!approved) {
            return '用户取消了本次删除（未删除任何内容）。请询问用户接下来希望怎么做，不要擅自重试。'
          }
        }
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
