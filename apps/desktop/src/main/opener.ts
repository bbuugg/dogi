/**
 * 系统打开服务：文件管理器 / 已安装 IDE 的跨平台检测与启动。
 * （移植自旧根应用 `src/main/services/system/opener.ts`，只保留文件管理器与 IDE。）
 *
 * 平台差异集中在此：Windows 用安装路径/PATH 探测 IDE，macOS 用 open -a，
 * Linux 用 PATH 内的 CLI。
 *
 * 「打开目录」与「选中文件」是两个动作（win32 是 explorer 的两种参数，darwin 是 open 与 open -R），
 * 别为省一个函数把它们合成一个 `dir` 参数。
 *
 * ⚠️ 「打开目录」**不走** `spawn('explorer', [dir])`，走 `shell.openPath` —— 原因见
 * `openFileManagerAt` 的注释（explorer 的命令行解析会静默退回「文档」）。
 */
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { accessSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

const platform = process.platform

export interface OpenResult {
  ok: boolean
  error?: string
}

export interface IdeInfo {
  id: string
  name: string
}

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
  const exts = platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
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

/**
 * 把任意来源的路径整理成**当前平台的原生形态**：Windows 统一反斜杠、去掉尾部分隔符。
 *
 * 为什么必须做：文件面板拼出来的路径是 `C:\a\b/c` 这种**混合分隔符**（工作区根带反斜杠、
 * 相对路径按服务端约定用 `/` 拼）。Win32 文件 API 会自己归一化，但 `explorer.exe` 走的是
 * **它自己的命令行解析**，认不出来时不报错，而是静默打开「文档」—— 用户看到的就是
 * 「点了定位，反而跳到了文档」。
 */
function toNativePath(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, '')
  if (platform !== 'win32') return trimmed
  const native = trimmed.replace(/\//g, '\\')
  // 盘符根（`C:\`）去掉尾分隔符会退化成「C 盘的当前目录」，补回来
  return /^[A-Za-z]:$/.test(native) ? `${native}\\` : native
}

/**
 * 在系统文件管理器里打开一个**目录**（进入它）。
 *
 * 三平台统一走 `shell.openPath`（= ShellExecute 的「双击」语义），而不是
 * `spawn('explorer', [dir])`：
 * - explorer.exe 的命令行解析是另一条路，路径认不出来时**不报错**，直接开「文档」；
 *   ShellExecute 的转义 / 空格 / 中文 / 混合分隔符全交给系统，还会尊重用户设的第三方文件管理器；
 * - `openPath` 的返回值就是错误文本（成功为空串），不再需要「spawn 成功 = 打开成功」这种猜。
 *
 * 目录不存在**必须自己拦**：上面两条路都不会说「路径是错的」，用户只会莫名看到一个「文档」窗口。
 */
export async function openFileManagerAt(dir: string): Promise<OpenResult> {
  const target = toNativePath(dir)
  if (!target) return { ok: false, error: '目录路径为空' }
  let isDir = false
  try {
    isDir = statSync(target).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) return { ok: false, error: `目录不存在或不是目录：${target}` }
  try {
    const err = await shell.openPath(target)
    return err ? { ok: false, error: err } : { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 在文件管理器里**显示并选中**一个文件（不是打开它）。
 *
 * 三平台的语义差别是真的，没有统一命令：
 * - Windows：`explorer /select,<path>`（初始就把目标选中，最接近「定位」）；
 * - macOS：`open -R <path>`（reveal，Finder 会选中它）；
 * - Linux：xdg-open 只有「打开」没有 reveal，退化成打开**所在目录** —— 文件不在视图里，
 *   但至少落在了正确的文件夹中（多数桌面环境的文件管理器会把同名项选上，这个不强求）。
 *
 * ⚠️ Windows 上 `/select,<path>` 必须是**一个** argv 项（explorer 自己按逗号切）。libuv 会把
 * 含空格的参数整体引号化，explorer 收到的仍是 `/select,<完整路径>`，这条路径是通的。
 * 分隔符统一成原生反斜杠（见 `toNativePath`）：混合分隔符下 explorer 会**静默退回「文档」**。
 *
 * 路径不存在也在这里拦一道：`explorer /select,<不存在的路径>` 同样不会报错，
 * 表现与「打开目录」那个坑一模一样。
 */
export function revealInFileManager(filePath: string): OpenResult {
  const target = toNativePath(filePath)
  if (!target) return { ok: false, error: '路径为空' }
  if (!exists(target)) return { ok: false, error: `路径不存在：${target}` }
  if (platform === 'darwin') return launch('open', ['-R', target])
  if (platform === 'linux') return launch('xdg-open', [dirname(target)])
  return launch('explorer', [`/select,${target}`])
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
    const names: Array<{ id: string; name: string; cli: string[] }> = [
      { id: 'vscode', name: 'Visual Studio Code', cli: ['code'] },
      { id: 'cursor', name: 'Cursor', cli: ['cursor'] },
      { id: 'windsurf', name: 'Windsurf', cli: ['windsurf'] },
      { id: 'vscodium', name: 'VSCodium', cli: ['codium'] },
      { id: 'trae', name: 'Trae', cli: ['trae'] }
    ]
    return names.map((n) => ({
      id: n.id,
      name: n.name,
      detect: () => {
        for (const c of n.cli) {
          const p = cli(c)
          if (p) return { command: p, args: [] }
        }
        return null
      }
    }))
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

/** 列出检测到的已安装 IDE（给下拉菜单展示用；不含启动器细节） */
export function listInstalledIdes(): IdeInfo[] {
  const out: IdeInfo[] = []
  for (const c of buildIdeCandidates()) {
    const launcher = c.detect()
    if (launcher) out.push({ id: c.id, name: c.name })
  }
  return out
}

/** 用指定 IDE 打开目录（打开时重新探测，保证刚安装/卸载也能得到最新结果） */
export function openIdeWith(id: string, dir: string): OpenResult {
  const candidate = buildIdeCandidates().find((c) => c.id === id)
  if (!candidate) return { ok: false, error: '未知的 IDE' }
  const launcher = candidate.detect()
  if (!launcher) return { ok: false, error: `未检测到已安装的 ${candidate.name}` }
  return launch(launcher.command, [...launcher.args, dir])
}
