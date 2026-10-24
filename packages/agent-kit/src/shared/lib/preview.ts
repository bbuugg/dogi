/**
 * 工作区文件的预览类型判定。
 *
 * - `image` / `svg` / `video` / `audio`：二进制，只能预览不能当文本编辑；
 * - `binary`：明确不支持的二进制（压缩包 / 可执行文件…），提示「不支持预览」；
 * - `markdown` / `html`：**文本**，既能按源码编辑、又能就地预览（见 `isEditable`）；
 * - `null`：按普通文本处理（可读可编辑）。
 *
 * 判定规则只跟扩展名有关，**不关心它在哪儿跑**：web 与 desktop 共用这一份
 * （桌面端原有的 `@shared/workspace-media` 已不存在，别再照抄那个路径）。
 */
export type PreviewKind = 'image' | 'svg' | 'video' | 'audio' | 'binary' | 'markdown' | 'html'

const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','bmp','ico','avif','apng','tif','tiff'])
const VIDEO_EXTS = new Set(['mp4','webm','ogv','mov','m4v','mkv','avi','wmv','flv','mpg','mpeg'])
const AUDIO_EXTS = new Set(['mp3','wav','ogg','oga','m4a','aac','flac','opus','weba','mid','midi'])
const MARKDOWN_EXTS = new Set(['md','mdx','markdown'])
const HTML_EXTS = new Set(['html','htm'])
const BINARY_EXTS = new Set([
  'zip','gz','tgz','bz2','xz','7z','rar','tar','jar','war','exe','dll','so','dylib',
  'bin','dat','class','o','a','lib','pdf','doc','docx','xls','xlsx','ppt','pptx',
  'woff','woff2','ttf','otf','eot','db','sqlite','sqlite3','dmg','iso','img','pkg','deb','rpm'
])

function extOf(name: string): string {
  const lower = name.toLowerCase()
  return lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
}

export function previewKindOf(fileName: string): PreviewKind | null {
  const ext = extOf(fileName)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext === 'svg') return 'svg'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (HTML_EXTS.has(ext)) return 'html'
  if (BINARY_EXTS.has(ext)) return 'binary'
  return null
}

/** 是否支持预览（svg 也支持，但它是纯文本，只是两种形态都可用） */
export function isPreviewable(kind: PreviewKind | null | undefined): boolean {
  return kind === 'image' || kind === 'svg' || kind === 'video' || kind === 'audio' ||
    kind === 'markdown' || kind === 'html'
}

/** 是否可按文本读写（null 和 svg 文本形态都算） */
export function isEditable(kind: PreviewKind | null | undefined): boolean {
  return kind === null || kind === 'svg' || kind === 'markdown' || kind === 'html'
}

/** 纯媒体 / 二进制：只能靠「可播放 URL」看，取不到正文；其余（null/svg/md/html）走 `read` */
export function isMediaKind(kind: PreviewKind | null | undefined): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'binary'
}

/** 同时有文本形态与预览形态（svg / markdown / html）—— 「预览 / 编辑」切换按钮只对这些出现 */
export function hasDualView(kind: PreviewKind | null | undefined): boolean {
  return isPreviewable(kind) && isEditable(kind)
}
