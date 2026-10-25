/**
 * `GET /api/files/download?path=` —— 下载到本机：文件原样吐，**目录现场打 zip**。
 *
 * 浏览器只能「另存一个文件」，所以目录必须先打包（与工作区文件视图的
 * `?zip=<rel>` 同一套做法，打包实现共用 `zipDirectory`）。
 *
 * 这里**不做 Range**：下载就是要整份，`mediaResponse` 的分包能力留给上面的
 * `/api/files/content`（预览用）。
 */
import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { describeError, jsonError } from '@/app/api/_lib/auth'
import { mimeOf } from '@/lib/server/lib/media'
import { zipDirectory } from '@/lib/server/lib/zip'
import { baseNameOf, normalizeTarget } from '@/lib/server/file-manager/paths'

export async function GET(request: Request) {
  const url = new URL(request.url)
  try {
    const abs = normalizeTarget(url.searchParams.get('path'))
    const stat = await fs.stat(abs)
    const name = baseNameOf(abs)

    if (!stat.isDirectory()) {
      return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
        headers: {
          'content-type': mimeOf(abs),
          'content-length': String(stat.size),
          // RFC 5987：中文文件名必须按 UTF-8 百分号编码，否则会乱码 / 被截断
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
        }
      })
    }

    const { buffer } = await zipDirectory(abs)
    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type': 'application/zip',
        'content-length': String(buffer.length),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.zip`)}`
      }
    })
  } catch (err) {
    const e = describeError(err)
    return jsonError(e.status, e.message)
  }
}
