/**
 * 工作区 Agent 工具集：文件读写 / 搜索 / 编辑 / 执行命令。
 *
 * 所有工具都绑定一个工作区根目录（root），文件路径一律相对工作区，
 * 经 resolveInside 越界校验后落盘，防止 Agent 逃出工作区。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
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

async function searchDir(
  dir: string,
  root: string,
  re: RegExp,
  fileRe: RegExp | null,
  ignored: (rel: string, isDir: boolean) => boolean,
  hits: string[],
  max: number
): Promise<void> {
  if (hits.length >= max) return
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    if (hits.length >= max) return
    const abs = join(dir, ent.name)
    const rel = relPathOf(root, abs)
    if (ignored(rel, ent.isDirectory())) continue
    if (ent.isDirectory()) {
      await searchDir(abs, root, re, fileRe, ignored, hits, max)
      continue
    }
    if (!ent.isFile()) continue
    if (fileRe && !fileRe.test(ent.name)) continue
    const stat = await fs.stat(abs)
    if (stat.size > MAX_SEARCH_FILE_SIZE) continue
    const buf = await fs.readFile(abs)
    if (buf.includes(0)) continue
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length && hits.length < max; i++) {
      re.lastIndex = 0
      if (re.test(lines[i])) {
        hits.push(`${rel}:${i + 1}: ${lines[i].trimEnd().slice(0, MAX_LINE_CHARS)}`)
      }
    }
  }
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
        '在工作区中按正则搜索文件内容（自动跳过忽略目录、二进制与大文件）。返回命中文件的相对路径、行号与行内容。用于定位符号、关键配置与错误来源。',
      inputSchema: z.object({
        pattern: z.string().describe('正则表达式（区分大小写）'),
        path: z.string().optional().describe('搜索起点目录（相对工作区），缺省为根目录'),
        filePattern: z.string().optional().describe('限定文件名正则，如 "\\.(ts|tsx|json)$"'),
        maxResults: z.number().optional().describe('最大命中行数，默认 200，最大 1000')
      }),
      execute: async ({ pattern, path = '', filePattern, maxResults = 200 }) => {
        let re: RegExp
        try {
          re = new RegExp(pattern)
        } catch (e) {
          throw new Error(`无效的正则：${(e as Error).message}`)
        }
        let fileRe: RegExp | null = null
        if (filePattern) {
          try {
            fileRe = new RegExp(filePattern)
          } catch (e) {
            throw new Error(`无效的文件名正则：${(e as Error).message}`)
          }
        }
        const absDir = resolveInside(root, path)
        const stat = await fs.stat(absDir)
        if (!stat.isDirectory()) throw new Error(`不是目录：${path || '.'}`)
        const ignored = await createIgnoreChecker(root)
        const hits: string[] = []
        await searchDir(absDir, root, re, fileRe, ignored, hits, clampInt(maxResults, 1, 1000, 200))
        return hits.length ? hits.join('\n') : '（未找到匹配）'
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
    })
  }
}
