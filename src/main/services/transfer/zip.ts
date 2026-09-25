/**
 * 极简 ZIP 读写（只支持 deflate 这一种压缩方式）。
 *
 * 这里没有直接用现成的 zip 库：项目里只有 electron-builder 间接带来的 `archiver`
 * （不是声明的依赖，随时可能消失），而导入导出只需要「把几个 JSON 打包 / 解包」
 * 这一点能力 —— 用 node 自带的 zlib 按 ZIP 格式读写即可，不必为一个功能加运行时依赖。
 *
 * 只实现了够用的部分：
 * - 写：本地文件头 + 数据 + 中央目录 + EOCD（无 zip64、无目录条目、无加密）；
 * - 读：从尾部找 EOCD → 遍历中央目录 → 按本地头定位数据 → inflateRaw。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** CRC32 查表（ZIP 的校验和算法，IEEE 802.3 同款） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** 转成 ZIP 里的 DOS 日期 / 时间（时间精度 2 秒，年份从 1980 起算） */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

/** 打包出的一个文件 */
export interface ZipInputFile {
  name: string
  /** 文件原文（写入前才压缩） */
  data: Buffer
}

/** 解包出的一个文件 */
export interface ZipOutputFile {
  name: string
  data: Buffer
}

/** 把若干文件打成一个 zip（Buffer） */
export function createZip(files: ZipInputFile[]): Buffer {
  const bodies: Buffer[] = []
  const directory: Buffer[] = []
  const { time, date } = dosDateTime(new Date())
  /** 已写入内容的累计字节数 = 下一个本地头的偏移 */
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)
    const deflated = deflateRawSync(file.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本
    local.writeUInt16LE(0x0800, 6) // 通用标记：文件名按 UTF-8 解析
    local.writeUInt16LE(8, 8) // 压缩方式：deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度
    bodies.push(local, name, deflated)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0) // 中央目录签名
    entry.writeUInt16LE(20, 4) // 创建版本
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt16LE(time, 12)
    entry.writeUInt16LE(date, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(deflated.length, 20)
    entry.writeUInt32LE(file.data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt16LE(0, 30) // 扩展字段
    entry.writeUInt16LE(0, 32) // 注释
    entry.writeUInt16LE(0, 34) // 起始磁盘号
    entry.writeUInt16LE(0, 36) // 内部属性
    entry.writeUInt32LE(0, 38) // 外部属性
    entry.writeUInt32LE(offset, 42) // 对应本地头的偏移
    directory.push(entry, name)

    offset += local.length + name.length + deflated.length
  }

  const dir = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // EOCD 签名
  end.writeUInt16LE(0, 4) // 当前磁盘号
  end.writeUInt16LE(0, 6) // 中央目录所在磁盘号
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16) // 中央目录起始偏移
  end.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...bodies, dir, end])
}

/**
 * 解包 zip。
 *
 * EOCD 在文件末尾（后面可能跟着注释，最长 64KB），所以从后往前扫签名而不是按固定偏移读。
 */
export function readZip(buffer: Buffer): ZipOutputFile[] {
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
  let cursor = buffer.readUInt32LE(eocd + 16)
  const files: ZipOutputFile[] = []

  for (let i = 0; i < total; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('zip 目录已损坏')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLen = buffer.readUInt16LE(cursor + 28)
    const extraLen = buffer.readUInt16LE(cursor + 30)
    const commentLen = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLen)

    // 目录条目里的 extra 长度可能与本地头不一致，数据起点一律按**本地头**算
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const raw = buffer.subarray(start, start + compressedSize)
    files.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) })

    cursor += 46 + nameLen + extraLen + commentLen
  }

  return files
}
