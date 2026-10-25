/**
 * 文件类型判定与图标 —— 文件管理器里**唯一**该判断「这是什么东西」的地方。
 *
 * 判定一律按扩展名（不读文件头）：列表里有几千个文件，为了一个图标去开几 KB 的文件
 * 头不值得；扩展名错了顶多图标不准，不影响任何操作。（`/api/files/read` 判二进制
 * 才用内容里的 NUL，那是另一回事。）
 */
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  Folder,
  Presentation,
  type LucideIcon
} from 'lucide-react'

/** 文件大类（决定图标、预览方式、能否当文本编辑） */
export type FileKind =
  | 'dir'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'archive'
  | 'code'
  | 'text'
  | 'markdown'
  | 'sheet'
  | 'doc'
  | 'slides'
  | 'other'

const KIND_BY_EXT: Record<string, FileKind> = {
  // 图片
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  svg: 'image',
  avif: 'image',
  apng: 'image',
  tif: 'image',
  tiff: 'image',
  // 视频
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
  mkv: 'video',
  avi: 'video',
  // 音频
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  opus: 'audio',
  // 文档
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  doc: 'doc',
  docx: 'doc',
  rtf: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  // 压缩包
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  '7z': 'archive',
  rar: 'archive',
  // 代码 / 配置（走「文本预览 + 就地编辑」）
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  json: 'code',
  jsonc: 'code',
  css: 'code',
  scss: 'code',
  less: 'code',
  html: 'code',
  htm: 'code',
  xml: 'code',
  yml: 'code',
  yaml: 'code',
  toml: 'code',
  ini: 'code',
  conf: 'code',
  env: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  ps1: 'code',
  bat: 'code',
  cmd: 'code',
  py: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  kt: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  hpp: 'code',
  cs: 'code',
  php: 'code',
  rb: 'code',
  lua: 'code',
  sql: 'code',
  // 纯文本
  txt: 'text',
  log: 'text',
  text: 'text',
  nfo: 'text',
  lock: 'text'
}

/** 扩展名（小写，不含点）；没有扩展名时返回空串 */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // 点开头的隐藏文件（`.env`）没有扩展名 —— 但 `.env` 按内容看确实是配置文本，
  // 所以这里单独认一下：`\.env*` 当代码 / 文本处理，其余 `.xxx` 当无扩展名。
  if (dot < 0) return ''
  if (dot === 0) return /^\.(env|gitignore|npmrc|editorconfig)/i.test(name) ? 'env' : ''
  return name.slice(dot + 1).toLowerCase()
}

export function kindOf(name: string, isDir: boolean): FileKind {
  if (isDir) return 'dir'
  return KIND_BY_EXT[extOf(name)] ?? 'other'
}

/** 能不能在预览里看（其余类型只能下载 / 用本机应用打开） */
export function canPreview(kind: FileKind): boolean {
  return kind !== 'other'
}

/** 能不能当文本就地编辑（预览里的「编辑」按钮） */
export function isTextual(kind: FileKind): boolean {
  return kind === 'text' || kind === 'code' || kind === 'markdown'
}

/** 类型 → 图标 + 配色（配色走 Tailwind 语义色，深浅主题都不用单独适配） */
export function iconOf(kind: FileKind, isDir: boolean): { Icon: LucideIcon; className: string } {
  if (isDir) return { Icon: Folder, className: 'text-amber-500' }
  switch (kind) {
    case 'image':
      return { Icon: FileImage, className: 'text-emerald-500' }
    case 'video':
      return { Icon: FileVideo, className: 'text-violet-500' }
    case 'audio':
      return { Icon: FileAudio, className: 'text-pink-500' }
    case 'pdf':
      return { Icon: FileType2, className: 'text-red-500' }
    case 'archive':
      return { Icon: FileArchive, className: 'text-orange-500' }
    case 'code':
      return { Icon: FileCode2, className: 'text-sky-500' }
    case 'markdown':
    case 'text':
      return { Icon: FileText, className: 'text-slate-500' }
    case 'sheet':
      return { Icon: FileSpreadsheet, className: 'text-green-600' }
    case 'doc':
      return { Icon: FileType2, className: 'text-blue-500' }
    case 'slides':
      return { Icon: Presentation, className: 'text-amber-600' }
    default:
      return { Icon: FileIcon, className: 'text-muted-foreground' }
  }
}

/** 字节数的可读展示（与 SFTP 面板同一套口径，1 位小数足够） */
export function formatSize(n: number): string {
  if (!n) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 时间戳 → 本地可读时间 */
export function formatTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
