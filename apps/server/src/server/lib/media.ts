/**
 * 媒体预览辅助：扩展名 → MIME 映射与 HTTP Range 解析（图片/视频/音频边下边播）。
 */
import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

/** 扩展名 → MIME（预览响应里显式带上）。与桌面端 workspace-media 的映射保持一致。 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  apng: 'image/apng',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  weba: 'audio/webm'
}

export function mimeOf(fileName: string): string {
  const ext = extname(fileName).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** 解析 `bytes=start-end`；不支持的形式返回 null（回落到整文件） */
export function parseRangeHeader(
  header: string | null | undefined,
  size: number
): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  if (!m[1]) {
    const suffix = Number(m[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (!Number.isFinite(start) || start > end || start >= size) return null
  return { start, end }
}

/** 组装媒体响应（整文件 200 / 分包 206 的统一入口） */
export function mediaResponse(
  abs: string,
  mime: string,
  size: number,
  rangeHeader: string | null | undefined,
  method: string
): Response {
  const base = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'content-disposition': 'inline'
  }
  const range = parseRangeHeader(rangeHeader, size)
  if (!range) {
    return new Response(
      method === 'HEAD' ? null : (Readable.toWeb(createReadStream(abs)) as ReadableStream),
      { status: 200, headers: { ...base, 'content-length': String(size) } }
    )
  }
  return new Response(
    method === 'HEAD'
      ? null
      : (Readable.toWeb(
          createReadStream(abs, { start: range.start, end: range.end })
        ) as ReadableStream),
    {
      status: 206,
      headers: {
        ...base,
        'content-length': String(range.end - range.start + 1),
        'content-range': `bytes ${range.start}-${range.end}/${size}`
      }
    }
  )
}