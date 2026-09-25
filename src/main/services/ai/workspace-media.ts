/**
 * 工作区文件预览的媒体协议：`dogi-ws://<工作区 id>/<相对路径>`。
 *
 * 为什么不用 IPC 传 base64：视频动辄上百 MB，base64 再胀 1/3 且没有 Range 支持
 * （拖进度条要重下全片）。这里把文件交给 Chromium 的流式加载器，图片懒加载、
 * 音视频边下边播。
 *
 * 安全边界与 Agent 工具一致：请求里的路径必须落在**该工作区目录之内**
 * （`resolveInside` 拦 `..` / 绝对路径），工作区 id 必须是已登记的工作区 ——
 * 换句话说，这个协议对外只暴露「工作区」，不暴露整台机器的文件系统。
 */
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { resolveInside } from './agent-core'
import { WORKSPACE_MEDIA_SCHEME, mimeOf } from '@shared/workspace-media'
import { storage } from '../storage'

/**
 * 必须在 app ready **之前**调用：把协议登记为标准 / 安全 / 支持流式的，
 * 否则页面里的 `<img>` / `<video>` 用不了它（`stream: true` 正是音视频 Range 请求的前提）。
 */
export function registerWorkspaceMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WORKSPACE_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true
      }
    }
  ])
}

/** 解析 `bytes=start-end` 形式的 Range 头；不支持的形式返回 null（回落到整文件） */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  if (!m[1]) {
    // 后缀形式 bytes=-N：最后 N 字节
    const suffix = Number(m[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (!Number.isFinite(start) || start > end || start >= size) return null
  return { start, end }
}

function fileResponse(
  abs: string,
  size: number,
  mime: string,
  range: { start: number; end: number } | null,
  headOnly: boolean
): Response {
  const base = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    // 预览的是本地文件，禁掉缓存以外的推断（也避免 Chromium 把它当下载）
    'content-disposition': 'inline'
  }
  if (!range) {
    return new Response(headOnly ? null : (Readable.toWeb(createReadStream(abs)) as ReadableStream), {
      status: 200,
      headers: { ...base, 'content-length': String(size) }
    })
  }
  return new Response(
    headOnly
      ? null
      : (Readable.toWeb(createReadStream(abs, { start: range.start, end: range.end })) as ReadableStream),
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

/** app ready 之后调用：挂上协议的处理器 */
export function serveWorkspaceMedia(): void {
  protocol.handle(WORKSPACE_MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const workspace = storage.getAgentWorkspace(url.hostname)
    if (!workspace) return new Response('工作区不存在', { status: 404 })

    let abs: string
    try {
      abs = resolveInside(workspace.path, decodeURIComponent(url.pathname).replace(/^\/+/, ''))
    } catch {
      // 越界（..、绝对路径）：协议只服务工作区内部，直接拒
      return new Response('路径越界', { status: 403 })
    }

    const stat = await fs.stat(abs).catch(() => null)
    if (!stat?.isFile()) return new Response('文件不存在', { status: 404 })

    const mime = mimeOf(abs) ?? 'application/octet-stream'
    // 音视频加载器会先发 Range（甚至只发 0- 探个头），这里如实回 206
    const range = parseRange(request.headers.get('range'), stat.size)
    return fileResponse(abs, stat.size, mime, range, request.method === 'HEAD')
  })
}
