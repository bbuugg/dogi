/**
 * 文件管理器的**读**操作：列目录、单条属性、可跳转的根。
 *
 * 三条都只读磁盘、不改任何东西，所以与 `ops.ts`（改动动作）分开 —— 前者可以随便重试，
 * 后者每一条都要想清楚「中途失败会留下什么」。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { FmEntry, FmListResult, FmPlace, FmRootsResult } from '@fizz/contracts/agent-api'
import { baseNameOf, homeDir, normalizeTarget, parentOf, trashRoot } from './paths'

/**
 * 一次最多列多少条。
 *
 * 5000 而不是无限：`C:\Windows\WinSxS` 那种目录能列出一万多项，一次性回给浏览器既卡
 * 又没人看。超了截断并**明确告诉界面**（`truncated`），别让人以为文件丢了。
 */
const MAX_ENTRIES = 5000

/** 目录项的统一构造：lstat 拿大小与时间，链接再跟一次 stat 判真实类型 */
async function entryOf(dir: string, dirent: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): Promise<FmEntry | null> {
  const abs = join(dir, dirent.name)
  const isLink = dirent.isSymbolicLink()
  let isDir = dirent.isDirectory()
  let stat = await fs.lstat(abs).catch(() => null)
  /**
   * 符号链接 / Windows 目录联接：`Dirent.isDirectory()` 是 **lstat 语义**，链接两个都为
   * false，不额外问一次就会被当成「既不是文件也不是目录」丢掉 —— 用户自己造的软链
   * 在文件管理器里凭空消失（工作区文件树踩过同一个坑，见 `workspaces/[id]/files`）。
   *
   * 跟随一次；断链（目标不存在）时按**文件**列出来 —— 至少要让他看见「这儿有个坏链」，
   * 而不是看不见。
   */
  if (!isDir && !dirent.isFile()) {
    const target = await fs.stat(abs).catch(() => null)
    isDir = target?.isDirectory() === true
    stat = stat ?? target
  }
  if (!stat) return null
  return {
    name: dirent.name,
    path: abs,
    isDir,
    isLink,
    // 目录的大小在界面上恒显示 `-`，这里给 0 免得把「目录项本身占的 4KB」当成内容大小
    size: isDir ? 0 : Number(stat.size) || 0,
    mtime: Math.round(Number(stat.mtimeMs) || 0),
    hidden: dirent.name.startsWith('.')
  }
}

/** 列一个目录（`path` 缺省 = 主目录） */
export async function listDir(path?: string | null): Promise<FmListResult> {
  const abs = normalizeTarget(path)
  const dirents = await fs.readdir(abs, { withFileTypes: true })
  const entries: FmEntry[] = []
  let truncated = false
  for (const dirent of dirents) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const entry = await entryOf(abs, dirent)
    if (entry) entries.push(entry)
  }
  // 目录在前、同类按名字排（`localeCompare` 而不是 `<`：中文按拼音、大小写更符合直觉）
  entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  )
  return {
    path: abs,
    parent: parentOf(abs),
    entries,
    ...(truncated ? { truncated: true } : {})
  }
}

/** 单条属性（属性弹窗 / 预览头部用） */
export async function statPath(path?: string | null): Promise<FmEntry> {
  const abs = normalizeTarget(path)
  const stat = await fs.lstat(abs)
  const isDir = stat.isDirectory()
  const isLink = stat.isSymbolicLink()
  return {
    name: baseNameOf(abs),
    path: abs,
    isDir,
    isLink,
    size: isDir ? 0 : Number(stat.size) || 0,
    mtime: Math.round(Number(stat.mtimeMs) || 0),
    hidden: baseNameOf(abs).startsWith('.')
  }
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Windows 的盘符清单。
 *
 * 不调 `wmic` / PowerShell：Win11 上 `wmic` 已被移除，起进程还要处理编码与超时。
 * 直接对 A–Z 各 stat 一次 —— 24 次系统调用，比起一个进程快两个数量级；不存在的盘
 * 会立刻抛 ENOENT。
 */
async function windowsDrives(): Promise<FmPlace[]> {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const found = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`
      return (await isDir(root)) ? { id: `drive:${letter}`, label: `本地磁盘 (${letter}:)`, path: root } : null
    })
  )
  return found.filter((x): x is FmPlace => x !== null)
}

/**
 * 常用位置。名字按「英文名 + 本地化名」两套候选找 —— Windows 中文系统的目录**实际名字**
 * 就是「桌面」「下载」，但用户也可能把系统语言设成英文（目录叫 Desktop / Downloads）。
 */
const HOME_PLACES: { id: string; label: string; names: string[] }[] = [
  { id: 'desktop', label: '桌面', names: ['Desktop', '桌面'] },
  { id: 'documents', label: '文档', names: ['Documents', '文档'] },
  { id: 'downloads', label: '下载', names: ['Downloads', '下载'] },
  { id: 'pictures', label: '图片', names: ['Pictures', '图片'] },
  { id: 'music', label: '音乐', names: ['Music', '音乐'] },
  { id: 'videos', label: '视频', names: ['Videos', '视频'] }
]

/** 可跳转的根：主目录 + 盘符（Windows）/ `/`、`/home`（POSIX）+ 常用位置 */
export async function listRoots(): Promise<FmRootsResult> {
  const home = homeDir()
  const platform = process.platform
  const drives: FmPlace[] = []
  if (platform === 'win32') {
    drives.push(...(await windowsDrives()))
  } else {
    drives.push({ id: 'root', label: '根目录 (/)', path: '/' })
    if (await isDir('/home')) drives.push({ id: 'root:home', label: '/home', path: '/home' })
    if (await isDir('/mnt')) drives.push({ id: 'root:mnt', label: '/mnt', path: '/mnt' })
  }

  const candidates = await Promise.all(
    HOME_PLACES.map(async (place) => {
      for (const name of place.names) {
        const path = join(home, name)
        if (await isDir(path)) return { id: place.id, label: place.label, path }
      }
      return null
    })
  )
  const places = candidates.filter((x): x is FmPlace => x !== null)
  // 主目录本身放最前：它是「我的文件」最自然的落点
  places.unshift({ id: 'home', label: '主目录', path: home })

  return { home, platform, drives, places, trash: trashRoot() }
}
