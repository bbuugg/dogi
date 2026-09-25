/**
 * 工作区文件的预览约定：可预览类型判定 + 媒体 URL 约定（主进程与渲染端共用）。
 *
 * 预览**不走 IPC 传 base64**：视频动辄上百 MB，塞进 JS 字符串会直接把内存打爆，
 * 而且没有 Range 支持（拖进度条得整片重来）。改成主进程注册一个自定义协议
 * `dogi-ws://<工作区 id>/<相对路径>`，只服务工作区内的文件（越界一律 403），
 * 由 Chromium 的 media loader 自己发 Range 请求 —— 边下边播、图片懒加载。
 *
 * SVG 特殊对待：它既是图片（可以预览）又是 XML 文本（可以编辑），
 * 所以两种形态都支持，由 UI 给一个「预览 / 编辑」切换。
 */

/** 自定义协议名（`protocol.registerSchemesAsPrivileged` 与 CSP 里都要用） */
export const WORKSPACE_MEDIA_SCHEME = 'dogi-ws'

/**
 * 文件的预览类型：
 * - `image` / `video` / `audio`：只预览，不能编辑（二进制）；
 * - `svg`：既能预览（`<img>` 渲染，不执行脚本）又能当 XML 编辑；
 * - `binary`：明确不支持预览的二进制（压缩包 / 可执行文件 …），别拿去当文本读；
 * - `null`（本函数返回 null）：按普通文本处理。
 */
export type PreviewKind = 'image' | 'svg' | 'video' | 'audio' | 'binary'

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'apng',
  'tif',
  'tiff'
])

const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba', 'mid'])

/** 明确不可预览的二进制（列出来的直接提示「不支持预览」，不做无谓的读盘） */
const BINARY_EXTS = new Set([
  'zip',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'tar',
  'jar',
  'war',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'dat',
  'class',
  'o',
  'a',
  'lib',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'db',
  'sqlite',
  'sqlite3',
  'pyc',
  'wasm'
])

/** 扩展名 → MIME（预览响应里显式带上，别指望 Chromium 靠扩展名猜） */
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
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  weba: 'audio/webm',
  mid: 'audio/midi'
}

/** 取扩展名（小写，不含点；无扩展名返回空串） */
export function extOf(fileName: string): string {
  const lower = fileName.toLowerCase()
  const dot = lower.lastIndexOf('.')
  // 开头的点（.gitignore）不算扩展名
  return dot > 0 ? lower.slice(dot + 1) : ''
}

/** 扩展名对应的 MIME；未知返回 undefined（主进程回落到 application/octet-stream） */
export function mimeOf(fileName: string): string | undefined {
  return MIME_BY_EXT[extOf(fileName)]
}

/** 判定预览类型；返回 null 表示按普通文本处理（走 Monaco 读取 / 编辑链路） */
export function previewKindOf(fileName: string): PreviewKind | null {
  const ext = extOf(fileName)
  if (ext === 'svg') return 'svg'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (BINARY_EXTS.has(ext)) return 'binary'
  return null
}

/** 能否直接预览（`binary` 与文本不算） */
export function isPreviewable(kind: PreviewKind | null): boolean {
  return kind === 'image' || kind === 'svg' || kind === 'video' || kind === 'audio'
}

/** 能否当文本编辑：普通文本（null）与 svg 可以，其余二进制不行 */
export function isEditable(kind: PreviewKind | null): boolean {
  return kind === null || kind === 'svg'
}

/**
 * 拼媒体 URL：`dogi-ws://<工作区 id>/<逐段编码的相对路径>`。
 * 路径按段编码（`#`、`?`、空格都能过），避免被当成 URL 的 fragment / query。
 */
export function buildWorkspaceMediaUrl(workspaceId: string, path: string): string {
  const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return `${WORKSPACE_MEDIA_SCHEME}://${workspaceId}/${encoded}`
}
