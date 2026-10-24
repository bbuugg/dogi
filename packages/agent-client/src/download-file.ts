/**
 * 把远端文件下载到本机：**fetch → blob → `<a download>`**。
 *
 * 为什么不直接给 `<a href download>`：跨域（或 `file://` 页面）上 `download` 属性会被浏览器
 * 忽略，退化成「打开一个新标签页」，用户拿不到文件 —— 必须自己过一道 blob。聊天里的外链图片
 * （`components/ai-elements/markdown-image.tsx`）、工作区文件（`lib/api.ts` 的
 * `downloadWorkspaceFile`）与容器工作台（`flow/node-workbench.tsx`）都走这里，一份实现。
 *
 * 分成 `fetchBlob` + `triggerBlobDownload` 两步而不是一个函数：调用方有时要先看 blob 才能定
 * 文件名（图片按 MIME 猜扩展名），合成一步就得多发一次请求。
 *
 * 文件是**整块**进内存的（blob 没有 Range），所以别拿它下几个 G 的东西；工作区媒体路由
 * 本来就不限大小，真要下载超大文件得另做流式 + `showSaveDialog`（现在没有）。
 */
import { getAgentHostOrNull } from './host'

export interface DownloadFileOptions {
  /** 请求实现；缺省运行时解析宿主（desktop = IPC 桥，web = `globalThis.fetch`） */
  fetchImpl?: typeof fetch
  /** 额外请求头（工作区媒体要带 Authorization，`<a>` / `<video>` 带不了头） */
  headers?: Record<string, string>
}

/**
 * 拉取失败。**带 HTTP 状态**是有意的：调用方要按 401 走「统一未授权收场」
 * （`lib/api.ts` 的 `fireUnauthorized`），抛裸 `Error` 就分不出来，token 过期时
 * 下载只会静静失败而用户还停在原地。
 */
export class DownloadError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

/**
 * 默认请求实现：**运行时**解析宿主 —— 与 `lib/api.ts` 的 `hostFetch` 同一套理由
 * （宿主注入可能晚于本模块求值，绑死 `globalThis.fetch` 会让 desktop 打一个不存在的地址）。
 * 刻意自己实现而不是 import 那个：`api.ts` 反过来要用本模块的 `downloadFile`，
 * 两个模块互相 import 会成环。
 */
const defaultFetch: typeof fetch = (input, init) => {
  const host = getAgentHostOrNull()
  const impl = host ? host.fetch : globalThis.fetch
  return impl(input, init)
}

/** 拉一个 URL 成 blob（失败抛 `DownloadError`，消息就是人能读懂的那句） */
export async function fetchBlob(url: string, options: DownloadFileOptions = {}): Promise<Blob> {
  const res = await (options.fetchImpl ?? defaultFetch)(url, { headers: options.headers })
  if (!res.ok) throw new DownloadError(`下载失败（HTTP ${res.status}）`, res.status)
  return res.blob()
}

/** 触发一次「浏览器另存为」；`revoke` 必须延后，Safari 立刻回收会拿不到数据 */
export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

/** 拉一个 URL 并存到本机（文件名已知时用；要先看内容定文件名就自己组合上面两步） */
export async function downloadFile(
  url: string,
  fileName: string,
  options: DownloadFileOptions = {}
): Promise<void> {
  triggerBlobDownload(await fetchBlob(url, options), fileName)
}
