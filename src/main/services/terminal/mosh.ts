import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { MoshClientStatus } from '@shared/types'

/**
 * 本地 mosh-client 探测（Mosh 会话的前置条件：没有本地客户端就没法建立会话）。
 *
 * - 原生：PATH 优先（Windows 用 where.exe、Unix 用 which），再查 MSYS2 / Cygwin / Homebrew 等常见路径；
 * - 回退：Windows 没有原生 mosh（mosh.org 明确不提供），改用 WSL —— 在默认发行版里 `command -v mosh-client`。
 *
 * 结果有缓存，但「没找到」不长期缓存：用户装好 mosh-client 不必重启应用，
 * 下一次触发（弹窗勾选 / 发起连接）就会重新扫描一次（WSL 探测要起 wsl.exe 进程，只在必要时做）。
 */

/** 解析出的本地客户端启动方式（sessions.ts 照着它 spawn） */
export type ResolvedMoshClient =
  | {
      kind: 'native'
      /** mosh-client 可执行文件路径 */
      command: string
    }
  | {
      kind: 'wsl'
      /** wsl.exe 路径 */
      launcher: string
      /** 发行版内的 mosh-client 路径（展示与诊断用） */
      innerPath: string
    }

interface DetectionResult {
  client: ResolvedMoshClient | null
  status: MoshClientStatus
}

let cached: DetectionResult | null = null

function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 在 PATH 中查找可执行文件，返回第一个命中的完整路径（Windows 用 where，Unix 用 which） */
function findInPath(name: string): string | null {
  try {
    const [cmd, args] =
      process.platform === 'win32' ? ['where.exe', [name]] : ['which', [name]]
    const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 3000 })
    if (res.status === 0) {
      const first = res.stdout.trim().split(/\r?\n/)[0]
      if (first) return first
    }
  } catch {
    // where / which 不可用时忽略
  }
  return null
}

/** MSYS2 / Cygwin / 包管理器常见安装位置（PATH 之外兜底） */
const NATIVE_CANDIDATES =
  process.platform === 'win32'
    ? [
        'C:\\msys64\\usr\\bin\\mosh-client.exe',
        'C:\\cygwin64\\bin\\mosh-client.exe',
        'C:\\cygwin\\bin\\mosh-client.exe'
      ]
    : [
        '/opt/homebrew/bin/mosh-client',
        '/usr/local/bin/mosh-client',
        '/usr/bin/mosh-client',
        '/opt/local/bin/mosh-client'
      ]

function detectNative(): string | null {
  const found = findInPath(process.platform === 'win32' ? 'mosh-client.exe' : 'mosh-client')
  if (found) return found
  for (const candidate of NATIVE_CANDIDATES) {
    if (exists(candidate)) return candidate
  }
  return null
}

function wslExe(): string | null {
  if (process.platform !== 'win32') return null
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
  return exists(exe) ? exe : null
}

/**
 * WSL 探测：只认默认发行版。
 * 用登录 shell 查询，覆盖 /usr/local/bin、~/.local/bin 这类非默认 PATH。
 */
function detectWsl(launcher: string): string | null {
  try {
    const res = spawnSync(launcher, ['-e', 'sh', '-lc', 'command -v mosh-client'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000
    })
    if (res.status !== 0 || !res.stdout) return null
    const inner = res.stdout.trim().split(/\r?\n/)[0]
    return inner || null
  } catch {
    // WSL 未安装 / 无发行版
    return null
  }
}

/** 两处都没有时的安装指引（按平台给出可直接照做的命令） */
function buildHint(hasWsl: boolean): string {
  if (process.platform === 'darwin') {
    return '本地未检测到 mosh-client：请先执行 brew install mosh'
  }
  if (process.platform === 'win32') {
    return hasWsl
      ? '本地未检测到 mosh-client：可在 WSL 里安装（sudo apt install mosh）后自动回退使用，或安装 MSYS2 / Cygwin 的 mosh 包'
      : '本地未检测到 mosh-client：请安装 MSYS2（pacman -S mosh）/ Cygwin，或安装 WSL 后在其中执行 sudo apt install mosh'
  }
  return '本地未检测到 mosh-client：请用发行版包管理器安装（如 sudo apt install mosh）'
}

function detect(): DetectionResult {
  const native = detectNative()
  if (native) {
    return { client: { kind: 'native', command: native }, status: { kind: 'native', path: native } }
  }
  const launcher = wslExe()
  const innerPath = launcher ? detectWsl(launcher) : null
  if (launcher && innerPath) {
    return {
      client: { kind: 'wsl', launcher, innerPath },
      status: { kind: 'wsl', path: innerPath }
    }
  }
  return { client: null, status: { kind: 'none', hint: buildHint(Boolean(launcher)) } }
}

/** 命中/未命中都做一次判定；未命中时下次调用重新扫描 */
function getDetection(refresh: boolean): DetectionResult {
  if (refresh || !cached || !cached.client) cached = detect()
  return cached
}

/** 解析本地 mosh-client 启动方式；返回 null 表示不可用（此时用 moshClientStatus 取安装指引） */
export function resolveMoshClient(refresh = false): ResolvedMoshClient | null {
  return getDetection(refresh).client
}

/** 本地 mosh-client 探测状态（渲染端提示用） */
export function moshClientStatus(refresh = false): MoshClientStatus {
  return getDetection(refresh).status
}
