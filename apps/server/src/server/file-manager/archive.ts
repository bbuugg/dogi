/**
 * 压缩包读写：文件管理器「压缩 / 解压 / 看包里的内容」。
 *
 * ## 支持哪些格式，为什么
 *
 * | 格式 | 读 | 写 | 说明 |
 * | --- | --- | --- | --- |
 * | zip | ✅ | ✅ | 跨平台最稳；写入复用 `lib/zip.ts` 的零依赖实现 |
 * | tar | ✅ | ❌ | POSIX 上到处都是，读它只需要解析 512 字节的头 |
 * | tar.gz / tgz | ✅ | ❌ | 先 `gunzip` 再按 tar 读 |
 * | gz（单文件） | ✅ | ❌ | 解出 `<原名去掉 .gz>` 一个文件 |
 * | xz / bz2 / 7z / rar | ❌ | ❌ | Node 内置没有对应解码器；引三方包要进 asar、要换锁文件，不值 |
 *
 * **压缩只写 zip**：`archive` 老实现（linux_web）能选格式，但 tar.gz 写起来要自己拼
 * ustar + pax 长路径（>=100 字符的路径在 fizz 仓库里很常见），一块写错就是坏包。
 * 第一版只给 zip，界面上把 tar 系列标成「只读」。
 *
 * ## 安全底线
 *
 * 解压**必须**挡住 zip-slip：条目名里带 `../` 或绝对路径的一律拒绝（否则一个恶意包能把
 * 文件写到 `~/.ssh/authorized_keys`）。这里统一过 `safeJoin`。
 */
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import type { FmArchiveEntry } from '@fizz/contracts/agent-api'

/** 归档格式（按扩展名判定） */
export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'gz'

/** 认格式；不认识的返回 null（界面据此显示「无法预览」而不是报错） */
export function formatOf(abs: string): ArchiveFormat | null {
  const lower = abs.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz'
  if (lower.endsWith('.tar')) return 'tar'
  if (lower.endsWith('.gz')) return 'gz'
  if (lower.endsWith('.zip')) return 'zip'
  return null
}

/** 解压/列举的上限：包是用户给的文件，不能让它把内存或磁盘吃干 */
const MAX_ENTRIES = 100_000
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

/**
 * 归档内的相对路径 → 落地绝对路径。
 *
 * 挡三类：绝对路径（`/etc/passwd`、`C:\x`）、含 `..` 段的（`a/../../x`）、空段。
 * 归一化之后再确认仍在 `root` 之内 —— 只靠字符串判断容易漏（Windows 的 `\` 与 `/` 混用）。
 */
function safeJoin(root: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned) throw new Error('压缩包里有空文件名')
  if (isAbsolute(rel)) throw new Error(`压缩包里有绝对路径条目：${rel}`)
  const target = normalize(join(root, cleaned))
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`压缩包试图写到目录外面：${rel}`)
  }
  return target
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

interface ZipItem {
  name: string
  isDir: boolean
  method: number
  compressedSize: number
  size: number
  /** 数据起点（本地头之后） */
  dataStart: number
}

/** 读中央目录（不 inflate）—— 列举与解压共用 */
function readZipDirectory(buffer: Buffer): ZipItem[] {
  let eocd = -1
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')
  const total = buffer.readUInt16LE(eocd + 10)
  if (total > MAX_ENTRIES) throw new Error(`压缩包条目过多（${total}）`)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const items: ZipItem[] = []
  for (let i = 0; i < total; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('zip 目录已损坏')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLen = buffer.readUInt16LE(cursor + 28)
    const extraLen = buffer.readUInt16LE(cursor + 30)
    const commentLen = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    cursor += 46 + nameLen + extraLen + commentLen
    // 目录条目以 '/' 结尾（有些工具也写成属性位，按名字判断更通用）
    if (name.endsWith('/')) {
      items.push({ name, isDir: true, method: 0, compressedSize: 0, size: 0, dataStart: 0 })
      continue
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`压缩包用了不支持的压缩方式（${method}，只支持 store / deflate）`)
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('zip 本地文件头已损坏')
    }
    // 数据起点一律按**本地头**里的名字/扩展长度算（中央目录里的 extra 可能不同）
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    items.push({
      name,
      isDir: false,
      method,
      compressedSize,
      size,
      dataStart: localOffset + 30 + localNameLen + localExtraLen
    })
  }
  return items
}

/** 解一条 zip 条目（只有 deflate / store 两种） */
function zipEntryData(buffer: Buffer, item: ZipItem): Buffer {
  const raw = buffer.subarray(item.dataStart, item.dataStart + item.compressedSize)
  return item.method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

interface TarItem {
  name: string
  isDir: boolean
  size: number
  /** 数据在 buffer 里的偏移 */
  dataStart: number
}

/** 读 tar 的头：大小是 12 字节八进制（可能带前导空格 / 结尾 NUL） */
function tarSize(header: Buffer): number {
  const text = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim()
  return text ? parseInt(text, 8) || 0 : 0
}

/**
 * 扫一遍 tar。
 *
 * 只处理三种 typeflag：
 * - `0` / `\0`：普通文件；
 * - `5`：目录；
 * - `L`（GNU 长名字）/ `x`（PAX 扩展头，取 `path=`）：**下一个条目**的名字，
 *   长路径全靠它 —— fizz 里 `packages/agent-kit/src/features/…` 轻松超过 ustar 的 100 字符。
 *
 * 其余（硬链 / 设备 / fifo）直接跳过：解出来也不是文件管理器该管的东西。
 */
function readTarDirectory(buffer: Buffer): TarItem[] {
  const items: TarItem[] = []
  let offset = 0
  /** 待生效的长名字（`L` 或 pax `path=`） */
  let longName: string | null = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    // 全零块 = 归档结束（后面可能还有填充，直接收工）
    if (header.every((b) => b === 0)) break
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const size = tarSize(header)
    const dataStart = offset + 512
    const padded = Math.ceil(size / 512) * 512

    if (typeflag === 'L') {
      longName = buffer.toString('utf8', dataStart, dataStart + size).replace(/\0.*$/, '')
      offset = dataStart + padded
      continue
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const text = buffer.toString('utf8', dataStart, dataStart + size)
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)
      if (match) longName = match[1]
      offset = dataStart + padded
      continue
    }

    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '')
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '')
    const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName)
    longName = null

    if (typeflag === '5') {
      if (name) items.push({ name: name.replace(/\/?$/, '/'), isDir: true, size: 0, dataStart })
    } else if (typeflag === '0' || typeflag === '\0') {
      if (name) items.push({ name, isDir: false, size, dataStart })
    }
    if (items.length > MAX_ENTRIES) throw new Error('压缩包条目过多')
    offset = dataStart + padded
  }
  return items
}

// ---------------------------------------------------------------------------
// 对外：列举 / 解压
// ---------------------------------------------------------------------------

/**
 * 列归档内容（不落盘）。
 *
 * `gz`（单文件）没有目录概念，包里也没有名字 —— 解出来就是「去掉 `.gz` 的那个
 * 文件名」，这里照这个语义给一条。
 */
export async function listArchive(abs: string): Promise<{ format: ArchiveFormat; entries: FmArchiveEntry[] }> {
  const format = formatOf(abs)
  if (!format) throw new Error('这个格式还不支持：只能看 zip / tar / tar.gz / gz')
  const buffer = await fs.readFile(abs)

  if (format === 'gz') {
    const out = gunzipSync(buffer)
    return {
      format,
      entries: [{ name: abs.replace(/\.gz$/i, '').split(/[\\/]/).pop() ?? 'data', size: out.length, isDir: false }]
    }
  }
  if (format === 'zip') {
    return {
      format,
      entries: readZipDirectory(buffer).map((item) => ({
        name: item.name,
        size: item.size,
        isDir: item.isDir
      }))
    }
  }
  const tarBuffer = format === 'tar.gz' ? gunzipSync(buffer) : buffer
  return {
    format,
    entries: readTarDirectory(tarBuffer).map((item) => ({
      name: item.name,
      size: item.size,
      isDir: item.isDir
    }))
  }
}

/**
 * 解压到 `destRoot`（目录不存在就建）。
 *
 * 返回解出来的**顶层条目数**（界面据此说「解出 12 项」）。同名文件直接覆盖 ——
 * 解压本来就是「把这个包铺开」，弹窗里会把目标目录摆给用户看清楚。
 */
export async function extractArchive(abs: string, destRoot: string): Promise<number> {
  const format = formatOf(abs)
  if (!format) throw new Error('这个格式还不支持：只能解 zip / tar / tar.gz / gz')
  const buffer = await fs.readFile(abs)
  await fs.mkdir(destRoot, { recursive: true })

  let written = 0
  let totalBytes = 0

  /** 每写一份都过一遍总字节上限，超了立刻停 */
  const writeOut = async (target: string, data: Buffer): Promise<void> => {
    totalBytes += data.length
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('解压后总量超过 2GB，已中止')
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, data)
    written++
  }

  if (format === 'gz') {
    const out = gunzipSync(buffer)
    const name = (abs.replace(/\.gz$/i, '').split(/[\\/]/).pop() ?? 'data').trim() || 'data'
    await writeOut(safeJoin(destRoot, name), out)
    return written
  }

  if (format === 'zip') {
    for (const item of readZipDirectory(buffer)) {
      const target = safeJoin(destRoot, item.name)
      if (item.isDir) {
        await fs.mkdir(target, { recursive: true })
        continue
      }
      await writeOut(target, zipEntryData(buffer, item))
    }
    return written
  }

  const tarBuffer = format === 'tar.gz' ? gunzipSync(buffer) : buffer
  for (const item of readTarDirectory(tarBuffer)) {
    const target = safeJoin(destRoot, item.name)
    if (item.isDir) {
      await fs.mkdir(target, { recursive: true })
      continue
    }
    await writeOut(target, Buffer.from(tarBuffer.subarray(item.dataStart, item.dataStart + item.size)))
  }
  return written
}
