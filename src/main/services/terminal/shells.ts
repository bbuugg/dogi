import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ShellDetectResult, ShellProfile } from '@shared/types'

/**
 * 本地 shell 检测：
 * - Windows：PowerShell / PowerShell 7 / CMD / Git Bash / WSL
 * - Unix：$SHELL 与常见安装路径（bash/zsh/fish/sh 等）
 * 检测不到时回退到写死的兜底列表，保证下拉永远有可选项。
 */

/** 检测结果缓存：shell 安装情况在运行期基本不变，避免每次创建终端都扫盘 */
let cached: ShellDetectResult | null = null

function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Windows 下在 PATH 中查找可执行文件，返回第一个命中的完整路径 */
function findInPathWin(name: string): string | null {
  try {
    const res = spawnSync('where.exe', [name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    })
    if (res.status === 0) {
      const first = res.stdout.trim().split(/\r?\n/)[0]
      if (first) return first
    }
  } catch {
    // where 不可用时忽略
  }
  return null
}

function idFromCommand(command: string): string {
  const base = path.basename(command).replace(/\.(exe|sh)$/i, '').toLowerCase()
  return base || command
}

/** Git Bash 探测：常见安装路径 + 由 where git 的路径推导 */
function findGitBash(): string | null {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe')
  ]
  const git = findInPathWin('git.exe')
  if (git) {
    candidates.push(git.replace(/[\\/]cmd[\\/]git\.exe$/i, '\\bin\\bash.exe'))
    candidates.push(git.replace(/[\\/]mingw64[\\/]bin[\\/]git\.exe$/i, '\\usr\\bin\\bash.exe'))
  }
  for (const p of candidates) {
    if (p && p.includes('\\') && exists(p)) return p
  }
  return null
}

function detectWin(): ShellDetectResult {
  const shells: ShellProfile[] = [
    // PowerShell / CMD 为 Windows 自带，写死兜底，保证下拉永远有项
    { id: 'powershell', name: 'PowerShell', command: 'powershell.exe' },
    { id: 'cmd', name: 'CMD', command: 'cmd.exe' }
  ]
  const pwsh = findInPathWin('pwsh.exe') ?? [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\6\\pwsh.exe'
  ].find((p) => exists(p))
  if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell 7', command: pwsh })

  const gitBash = findGitBash()
  if (gitBash) {
    shells.push({ id: 'gitbash', name: 'Git Bash', command: gitBash, args: ['--login', '-i'] })
  }

  const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
  if (exists(wsl)) shells.push({ id: 'wsl', name: 'WSL', command: 'wsl.exe' })

  return { shells, defaultId: 'powershell' }
}

function detectUnix(): ShellDetectResult {
  const defaultShell = process.env.SHELL || '/bin/bash'
  const candidates = [
    defaultShell,
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/zsh',
    '/usr/bin/zsh',
    '/bin/fish',
    '/usr/bin/fish',
    '/bin/sh',
    '/bin/dash'
  ]
  const seen = new Set<string>()
  const shells: ShellProfile[] = []
  for (const command of candidates) {
    if (!command || seen.has(command)) continue
    seen.add(command)
    if (!exists(command)) continue
    const id = idFromCommand(command)
    if (shells.some((s) => s.id === id)) continue
    shells.push({ id, name: id, command })
  }
  // 兜底：一个都检测不到时写死 /bin/sh
  if (shells.length === 0) {
    shells.push({ id: 'sh', name: 'sh', command: '/bin/sh' })
  }
  const defaultId = shells.find((s) => s.command === defaultShell)?.id ?? shells[0].id
  return { shells, defaultId }
}

/** 检测本地可用 shell（带缓存）；返回结果可直接用于下拉展示与新建会话 */
export function detectShells(): ShellDetectResult {
  if (!cached) {
    try {
      cached = process.platform === 'win32' ? detectWin() : detectUnix()
    } catch {
      cached =
        process.platform === 'win32'
          ? { shells: [{ id: 'powershell', name: 'PowerShell', command: 'powershell.exe' }], defaultId: 'powershell' }
          : { shells: [{ id: 'sh', name: 'sh', command: '/bin/sh' }], defaultId: 'sh' }
    }
  }
  return cached
}

export interface ResolvedShell {
  command: string
  args?: string[]
  /** 终端标签展示名 */
  title: string
}

/** 按配置 id 解析出实际要 spawn 的 shell；id 为空 / 'default' / 无效时回退平台默认 */
export function resolveLocalShell(shellId: string | undefined): ResolvedShell {
  const { shells, defaultId } = detectShells()
  const id = shellId && shellId !== 'default' ? shellId : defaultId
  const profile = shells.find((s) => s.id === id)
  if (profile) {
    return { command: profile.command, args: profile.args, title: profile.name }
  }
  // 兜底：与旧版 pickLocalShell 行为一致
  if (process.platform === 'win32') {
    return { command: process.env.PWSH_PATH || 'powershell.exe', title: 'PowerShell' }
  }
  const command = process.env.SHELL || '/bin/bash'
  return { command, title: idFromCommand(command) }
}