// 系统打开服务：文件管理器 / 终端 / 已安装 IDE 的跨平台启动。
// 平台差异集中在此：Windows 用 explorer/Windows Terminal，macOS 用 open/AppleScript，
// Linux 用 xdg-open 与常见终端模拟器。
import { spawn } from 'node:child_process'
import { accessSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { IdeInfo, OpenResult } from '@shared/types'

const platform = process.platform

function exists(p: string | null | undefined): boolean {
  if (!p) return false
  try {
    accessSync(p)
    return true
  } catch {
    return false
  }
}

/** 在 PATH 中查找可执行文件（Windows 按 PATHEXT 尝试扩展名），找不到返回 null */
function findInPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const exts =
    platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  const base = name.toLowerCase()
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, base + ext.toLowerCase())
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/** 把命令名解析为可 spawn 的形式：完整路径直接用，否则 PATH 查找；win32 兜底保留原名 */
function resolveCommand(name: string): string | null {
  if (exists(name)) return name
  const found = findInPath(name)
  if (found) return found
  return platform === 'win32' ? name : null
}

/** 脱离当前进程启动外部程序（unref 不阻塞退出）；错误通过返回值上报 */
function launch(name: string, args: string[], cwd?: string): OpenResult {
  const cmd = resolveCommand(name)
  if (!cmd) return { ok: false, error: `找不到程序：${name}` }
  const isPath = cmd.includes('/') || cmd.includes('\\')
  if (isPath && !exists(cmd)) return { ok: false, error: `找不到程序：${cmd}` }
  try {
    // 不能用 windowsHide: true：SW_HIDE 会被 explorer.exe 等 GUI 程序继承，
    // 导致新窗口被隐藏（spawn 成功返回但用户看不到窗口）
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd })
    child.on('error', (err) => console.warn('[opener] launch failed:', cmd, err.message))
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------- 文件管理器 ----------

export function openFileManagerAt(dir: string): OpenResult {
  if (platform === 'darwin') return launch('open', [dir])
  if (platform === 'linux') return launch('xdg-open', [dir])
  return launch('explorer', [dir])
}

// ---------- 终端 ----------

export function openTerminalAt(dir: string): OpenResult {
  if (platform === 'win32') {
    // 优先 Windows Terminal（Win11 自带），回退新开 PowerShell 窗口并切目录
    const windowsApps = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe')
      : null
    const wt = resolveCommand('wt.exe') ?? (exists(windowsApps) ? windowsApps : null)
    if (wt) {
      const r = launch(wt, ['-d', dir])
      if (r.ok) return r
    }
    const ps = resolveCommand('powershell.exe')
    if (!ps) return { ok: false, error: '找不到 powershell.exe' }
    const cmd = `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`
    return launch(ps, ['-NoExit', '-Command', cmd])
  }
  if (platform === 'darwin') {
    // 优先 iTerm（open -a iTerm <目录> 会新建窗口并进入该目录），回退 AppleScript 开 Terminal
    if (exists('/Applications/iTerm.app')) {
      const r = launch('open', ['-a', 'iTerm', dir])
      if (r.ok) return r
    }
    const safe = dir.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script = `tell application "Terminal" to do script "cd \\"${safe}\\""`
    return launch('osascript', ['-e', script])
  }
  // Linux：常见终端模拟器，优先带目录参数的，兜底用 cwd 继承
  const terms: Array<{ name: string; args: (d: string) => string[] }> = [
    { name: 'gnome-terminal', args: (d) => [`--working-directory=${d}`] },
    { name: 'konsole', args: (d) => ['--workdir', d] },
    { name: 'xfce4-terminal', args: (d) => [`--working-directory=${d}`] },
    { name: 'x-terminal-emulator', args: () => [] },
    { name: 'xterm', args: () => [] }
  ]
  for (const t of terms) {
    const args = t.args(dir)
    const r = launch(t.name, args, args.length === 0 ? dir : undefined)
    if (r.ok) return r
  }
  return { ok: false, error: '未检测到可用的终端程序' }
}

// ---------- IDE 探测 ----------

interface IdeCandidate {
  id: string
  name: string
  /** 返回可直接 spawn 的启动器；null = 未安装 */
  detect: () => { command: string; args: string[] } | null
}

/** 常见 IDE 的探测候选：优先安装路径，其次 PATH 内的 CLI（macOS 用 open -a 最稳） */
function buildIdeCandidates(): IdeCandidate[] {
  const local = process.env.LOCALAPPDATA ?? ''
  const programFiles = process.env.ProgramFiles ?? ''
  const cli = (name: string) => findInPath(name)
  const exe = (...paths: string[]) => paths.find((p) => exists(p)) ?? null
  const macApp = (appName: string) => {
    const appPath = `/Applications/${appName}.app`
    if (exists(appPath)) return { command: 'open', args: ['-a', appName] }
    const c = cli(appName === 'Visual Studio Code' ? 'code' : appName.toLowerCase())
    return c ? { command: c, args: [] } : null
  }

  if (platform === 'darwin') {
    return [
      { id: 'vscode', name: 'Visual Studio Code', detect: () => macApp('Visual Studio Code') },
      { id: 'cursor', name: 'Cursor', detect: () => macApp('Cursor') },
      { id: 'windsurf', name: 'Windsurf', detect: () => macApp('Windsurf') },
      { id: 'vscodium', name: 'VSCodium', detect: () => macApp('VSCodium') },
      { id: 'trae', name: 'Trae', detect: () => macApp('Trae') }
    ]
  }
  if (platform === 'linux') {
    const cliLauncher = (name: string) => {
      const c = cli(name)
      return c ? { command: c, args: [] } : null
    }
    return [
      { id: 'vscode', name: 'Visual Studio Code', detect: () => cliLauncher('code') },
      { id: 'vscodium', name: 'VSCodium', detect: () => cliLauncher('codium') },
      { id: 'cursor', name: 'Cursor', detect: () => cliLauncher('cursor') },
      { id: 'windsurf', name: 'Windsurf', detect: () => cliLauncher('windsurf') }
    ]
  }
  // win32
  return [
    {
      id: 'vscode',
      name: 'Visual Studio Code',
      detect: () => {
        const p = exe(
          join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
          join(programFiles, 'Microsoft VS Code', 'Code.exe')
        )
        if (p) return { command: p, args: [] }
        const c = cli('code.cmd') ?? cli('code.exe')
        return c ? { command: c, args: [] } : null
      }
    },
    {
      id: 'cursor',
      name: 'Cursor',
      detect: () => {
        const p = exe(join(local, 'Programs', 'cursor', 'Cursor.exe'))
        if (p) return { command: p, args: [] }
        const c = cli('cursor.exe') ?? cli('cursor.cmd')
        return c ? { command: c, args: [] } : null
      }
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      detect: () => {
        const p = exe(
          join(local, 'Programs', 'Windsurf', 'Windsurf.exe'),
          join(local, 'Programs', 'windsurf', 'Windsurf.exe')
        )
        if (p) return { command: p, args: [] }
        const c = cli('windsurf.exe') ?? cli('windsurf.cmd')
        return c ? { command: c, args: [] } : null
      }
    },
    {
      id: 'vscodium',
      name: 'VSCodium',
      detect: () => {
        const p = exe(join(local, 'Programs', 'VSCodium', 'VSCodium.exe'))
        if (p) return { command: p, args: [] }
        const c = cli('codium.exe') ?? cli('codium.cmd')
        return c ? { command: c, args: [] } : null
      }
    },
    {
      id: 'trae',
      name: 'Trae',
      detect: () => {
        const p = exe(
          join(local, 'Programs', 'Trae', 'Trae.exe'),
          join(local, 'Programs', 'Trae CN', 'Trae.exe'),
          join(local, 'Programs', 'Trae Code', 'Trae Code.exe')
        )
        if (p) return { command: p, args: [] }
        const c = cli('trae.exe') ?? cli('trae.cmd')
        return c ? { command: c, args: [] } : null
      }
    }
  ]
}

export function listInstalledIdes(): IdeInfo[] {
  const out: IdeInfo[] = []
  for (const c of buildIdeCandidates()) {
    const launcher = c.detect()
    if (launcher) out.push({ id: c.id, name: c.name, command: launcher.command, args: launcher.args })
  }
  return out
}

export function openIdeWith(id: string, dir: string): OpenResult {
  const candidate = buildIdeCandidates().find((c) => c.id === id)
  if (!candidate) return { ok: false, error: '未知的 IDE' }
  // 打开时重新探测，保证刚安装/卸载也能得到最新结果
  const launcher = candidate.detect()
  if (!launcher) return { ok: false, error: `未检测到已安装的 ${candidate.name}` }
  return launch(launcher.command, [...launcher.args, dir])
}
