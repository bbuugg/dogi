/**
 * 最小 PNG 编码器（移植自 `console/apps/captcha` 的 `png.go`，那边用 Go 标准库 `image/png`）。
 *
 * 为什么必须是**像素图**而不是 SVG：SVG 是文本，缺口坐标会以数字形式躺在响应里，攻击者
 * 三行正则就能抠出答案（真实发生过）。PNG 之后答案只存在于图像里 —— 要拿答案得真的解码
 * PNG 做图像分析。
 *
 * 为什么自己写而不引依赖：只用得上「RGBA / 8bit / 无交错 / 每行 filter 0」这一种形态，
 * 编码器不到 100 行；引一个图像库只为这点事不值得（本项目服务端也刻意保持零图像依赖）。
 *
 * ⚠️ 像素按**直通（非预乘）alpha** 写入 —— 与 Go 版的 `image.NRGBA` 同口径。若按预乘处理，
 * 拼图块的抗锯齿描边（全是半透明像素）整圈会被压暗成「毛边」。
 */
import { deflateSync } from 'node:zlib'

/** CRC-32（PNG 每个 chunk 都要）。表只算一次。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crcInput = Buffer.concat([head.subarray(4), Buffer.from(data)])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([head, Buffer.from(data), tail])
}

/**
 * 把 `width * height * 4` 的 RGBA 缓冲编码成 PNG 字节。
 *
 * @param rgba 直通 alpha 的像素，行优先、每像素 4 字节
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (width <= 0 || height <= 0) throw new Error('encodePng: 宽高必须为正')
  if (rgba.length < width * height * 4) throw new Error('encodePng: 像素缓冲长度不足')

  // IHDR：宽 / 高 / 8bit / colorType 6（RGBA）/ 压缩 0 / filter 0 / 非交错
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // 每行前面补一个 filter 字节（0 = None），这是 PNG 的扫描线格式
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    )
  }

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', new Uint8Array(0))
    ])
  )
}

/** 编码成 `data:image/png;base64,...`（前端直接塞 `<img src>`）。 */
export function pngDataUrl(bytes: Uint8Array): string {
  return 'data:image/png;base64,' + Buffer.from(bytes).toString('base64')
}
