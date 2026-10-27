/**
 * 「把界面上的这张图存到本机」的唯一实现。
 *
 * 两个调用方长得像但不是同一件事，所以拆成这里：
 * - **Markdown 正文里的图**（`shared/ai-elements/markdown-image.tsx`）：多为外链，还可能已经
 *   预取过一份 blob（desktop 的服务端截图，渲染端没有端口，只能走 IPC 拿字节）；
 * - **消息附件里的图**（`features/chat/PartView.tsx` 的 `FilePartView`）：`src` 已经是
 *   `loadMediaObjectUrl` 解析过的（web 同源相对地址 / desktop 的 blob: 对象地址）。
 *
 * 两条路都要「先 fetch 成 blob 再 `<a download>`」—— 跨域图片上 `download` 属性会被浏览器
 * 忽略、退化成打开新标签页，用户拿不到文件（与 `@fizz/agent-client/download-file` 同一套理由）。
 *
 * ⚠️ 一律用 `globalThis.fetch`，**不能**用宿主 fetch：desktop 的宿主 fetch 是 IPC 桥，
 * 只接受进程内服务端的相对路径，把外链 / blob: 地址丢给它必然失败。
 */
import { fetchBlob, triggerBlobDownload } from '@fizz/agent-client/download-file'

/** 按 MIME 猜扩展名（文件名里没有可用后缀时用） */
export function imageExtOf(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('svg')) return 'svg'
  return 'png'
}

/** 名字里带一个像样的扩展名（`.png` / `.jpeg` 这类，长度 2~5，不含路径分隔符） */
function hasExt(name: string): boolean {
  return /\.[a-z0-9]{2,5}$/i.test(name)
}

/**
 * 去掉扩展名（`screenshot.png` → `screenshot`）。
 *
 * **只剥真正的扩展名**：`a.b 的截图` 这种带点的描述性 alt 整段保留 —— 早期这里用的是
 * 「去掉最后一个点之后的所有内容」，于是 alt 变成 `a`，落盘文件名莫名其妙地被截断。
 */
function baseNameOf(name: string): string {
  return hasExt(name) ? name.replace(/\.[a-z0-9]{2,5}$/i, '') : name
}

/** URL 的末段文件名；URL 不合法（`data:`、畸形串）或无法解析相对路径时给空串 */
function lastSegmentOf(src: string): string {
  try {
    // 没有 `location`（单测 / SSR）时给一个假基址：相对路径也要能解析出末段
    const base = typeof location === 'undefined' ? 'http://fizz.local/' : location.href
    return new URL(src, base).pathname.split('/').pop() ?? ''
  } catch {
    return ''
  }
}

/**
 * 落盘用的文件名。优先级：
 * 1. 调用方给的名字**自带扩展名**（附件的 `name` 通常是这样）→ 原样用；
 * 2. URL 末段带扩展名（`/api/uploads/abc.png`）→ 用它；
 * 3. 都没有 → 用名字（或 alt、或 `image`）按 MIME 补一个扩展名。
 */
export function imageFileNameOf(src: string, mime: string, preferred?: string): string {
  const preferredName = (preferred ?? '').trim()
  if (preferredName && hasExt(preferredName)) return preferredName
  const last = lastSegmentOf(src)
  if (last && hasExt(last)) return last
  const base = baseNameOf(preferredName || last || 'image') || 'image'
  return `${base}.${imageExtOf(mime)}`
}

export interface SaveImageOptions {
  /** 建议的文件名（附件名 / alt / 图注都行；带扩展名就原样用） */
  name?: string
  /** 已知的 MIME（附件有 `mediaType`；Markdown 的图只能从 blob 里读） */
  mime?: string
  /** 已经拿到的字节（desktop 的截图预览就属于这种，别再上网拉一次） */
  blob?: Blob
}

/**
 * 存到本机。**失败会抛**（消息就是人能读懂的那句，来自 `DownloadError`），
 * 由调用方决定是「退化成打开原图」还是提示一句 —— 这里的两个调用方策略不同。
 */
export async function saveImageLocally(src: string, options: SaveImageOptions = {}): Promise<void> {
  const blob = options.blob ?? (await fetchBlob(src, { fetchImpl: globalThis.fetch }))
  triggerBlobDownload(blob, imageFileNameOf(src, options.mime ?? blob.type, options.name))
}
