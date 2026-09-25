/**
 * 工作区文件的只读预览：图片 / SVG / 视频 / 音频。
 *
 * 资源走 `dogi-ws://` 协议（见 src/shared/workspace-media.ts），由主进程按
 * 工作区边界安全地流式返回，所以这里**不要**把内容读成字符串再塞 data URL ——
 * 大文件会把内存打爆。
 *
 * SVG 用 `<img>` 渲染：图片上下文里 SVG 的脚本与外部引用都不会执行，
 * 比直接注入 markup 安全得多（那是 XSS）。
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, FileQuestion, Loader2, Music } from 'lucide-react'
import type { PreviewKind } from '@shared/workspace-media'

export function FilePreview({
  kind,
  url,
  fileName
}: {
  kind: Extract<PreviewKind, 'image' | 'svg' | 'video' | 'audio'>
  url: string
  fileName: string
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  // 换文件要重置状态，否则上一个文件的失败会把新文件也标成失败
  useEffect(() => {
    setState('loading')
  }, [url])

  if (kind === 'audio') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
        <Music className="size-10 text-muted-foreground/40" />
        <div className="text-sm text-muted-foreground">{fileName}</div>
        <audio
          src={url}
          controls
          className="w-full max-w-md"
          onLoadedMetadata={() => setState('ready')}
          onError={() => setState('error')}
        />
        {state === 'error' && <PreviewError />}
      </div>
    )
  }

  if (kind === 'video') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <video
          src={url}
          controls
          preload="metadata"
          className="max-h-full max-w-full rounded-md bg-black/80"
          onLoadedMetadata={() => setState('ready')}
          onError={() => setState('error')}
        />
        {state === 'loading' && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            加载中…
          </div>
        )}
        {state === 'error' && <PreviewError hint="浏览器可能不支持这种视频编码" />}
      </div>
    )
  }

  return (
    <div className="relative flex h-full items-center justify-center overflow-auto p-4">
      <img
        src={url}
        alt={fileName}
        className="max-h-full max-w-full object-contain"
        onLoad={() => setState('ready')}
        onError={() => setState('error')}
      />
      {state === 'loading' && (
        <div className="absolute flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          加载中…
        </div>
      )}
      {state === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <PreviewError />
        </div>
      )}
    </div>
  )
}

function PreviewError({ hint }: { hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-center text-xs text-muted-foreground">
      <AlertTriangle className="size-5 text-amber-500" />
      预览失败
      {hint && <span className="text-muted-foreground/70">{hint}</span>}
    </div>
  )
}

/** 明确不支持预览的二进制（压缩包 / 可执行文件 …） */
export function UnsupportedPreview({ fileName }: { fileName: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
      <FileQuestion className="size-8 opacity-30" />
      <div>「{fileName}」是二进制文件，不支持预览</div>
      <div className="text-xs text-muted-foreground/70">可以用顶部「打开工作区目录」在文件管理器里看</div>
    </div>
  )
}
