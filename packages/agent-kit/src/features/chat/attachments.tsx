/**
 * 主会话输入区的附件交互（图片 / PDF / 其它）：上传入口 + 待发送预览行。
 *
 * 交互对齐 ainav/sdk 的 ChatInput：回形针 → 向上弹几项（图片 / PDF / 其它文件）→ 各自的
 * 隐藏 file input（可多选）；预览行 = 缩略图 / 文件图标 + 文件名 + 删除，上传中底部进度条、
 * 失败盖错误态。状态（ChatAttachment[]）归 ChatPanel 持有，这里只收 state + 回调。
 *
 * **上传源选择器**：可选的源超过一个时（内置存储 + 装了上传插件），菜单底部多一段
 * 「传到哪儿」，点一下切换（选择状态同样归 ChatPanel）。只装了内置那一个源时这段不出现
 * —— 不给一个只有一个选项的下拉。
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { AlertCircle, Check, FileText, ImageIcon, Paperclip, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import { CHAT_ICON_PILL } from '@fizz/agent-kit/features/chat/composer'
import { loadMediaObjectUrl } from '@fizz/agent-kit/shared/lib/media-url'
import type { ChatAttachment } from '@fizz/agent-kit/shared/lib/attachments'
import type { UploadProviderView } from '@fizz/contracts/agent-api'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/**
 * 操作行最左的上传入口。向上弹（side="top" + sideOffset 6）与权限 / 模型 pill 同款
 * （触发器都贴着窗口底部，popper 向上才不顶出屏幕）；触发器用 title 而非 IconTip ——
 * 与 `ModelPicker` 的触发器同款（Tooltip.Trigger 与 DropdownMenuTrigger 双 asChild 嵌套没必要）。
 */
export function AttachmentUploadButton({
  disabled,
  onPick,
  providers,
  providerId,
  onSelectProvider,
  onMenuOpen
}: {
  disabled?: boolean
  onPick: (files: FileList | File[]) => void
  /** 可选上传源（由 ChatPanel 按当前项目拉取）；不传 / 只有一个 = 不显示选择器 */
  providers?: UploadProviderView[]
  /** 当前选中的上传源（缺省那个用 null 表示） */
  providerId?: string | null
  onSelectProvider?: (id: string) => void
  /**
   * 菜单打开时回调（ChatPanel 用它重拉上传源清单）。
   *
   * 为什么要有：清单是**按项目拉的快照**，而在设置里刚启用一个上传插件、或刚往插件目录里
   * 放了文件时，这份快照是旧的 —— 不重拉的话用户会以为插件没生效（菜单里根本没那一项）。
   * 打开的这一刻重拉，是「即时而准确」最省的口子（不必轮询、不必全局状态）。
   */
  onMenuOpen?: () => void
}) {
  const imageRef = useRef<HTMLInputElement>(null)
  const pdfRef = useRef<HTMLInputElement>(null)
  const otherRef = useRef<HTMLInputElement>(null)
  const pick = (input: HTMLInputElement | null) => input?.click()

  /** 选择器里能选的源（插件可以声明 selectable:false 表示「只想被显式指定」） */
  const pickable = (providers ?? []).filter((p) => p.selectable)
  const selected =
    pickable.find((p) => p.id === providerId) ?? pickable.find((p) => p.isDefault) ?? pickable[0]
  /**
   * 「其它文件」这一项只在**选中的源支持图片 / PDF 之外的类型**时出现，`accept` 也按它算。
   * 少了这条，插件声明了 `text/csv` 这类 accept 也选不进来（回形针只认图片和 PDF）。
   */
  const extraAccept = (selected?.acceptMime ?? []).filter(
    (mime) => !mime.startsWith('image/') && mime !== 'application/pdf'
  )

  const inputEl = (ref: RefObject<HTMLInputElement | null>, accept: string) => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      multiple
      className="hidden"
      onChange={(e) => {
        if (e.target.files?.length) onPick(e.target.files)
        e.target.value = ''
      }}
    />
  )

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          // 只在打开时重拉（关闭时没必要打一次服务端）
          if (open) onMenuOpen?.()
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="上传附件"
            title={
              selected && selected.id !== 'local'
                ? `上传附件（当前传到：${selected.title}）`
                : '上传附件（图片 / PDF）'
            }
            disabled={disabled}
            className={CHAT_ICON_PILL}
          >
            <Paperclip className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={6}>
          <DropdownMenuItem onSelect={() => pick(imageRef.current)}>
            <ImageIcon className="size-4" />
            图片
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => pick(pdfRef.current)}>
            <FileText className="size-4" />
            PDF
          </DropdownMenuItem>
          {extraAccept.length > 0 && (
            <DropdownMenuItem onSelect={() => pick(otherRef.current)}>
              <FileText className="size-4" />
              其它文件
            </DropdownMenuItem>
          )}
          {pickable.length > 1 && (
            <>
              <DropdownMenuSeparator />
              {pickable.map((provider) => (
                <DropdownMenuItem
                  key={provider.id}
                  onSelect={() => onSelectProvider?.(provider.id)}
                  title={provider.source === 'plugin' ? `插件：${provider.sourceName}` : '内置存储'}
                >
                  {/* 勾选位：用固定宽度的空位占位，避免未选中项文字错位 */}
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {selected?.id === provider.id && <Check className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{provider.title}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {inputEl(imageRef, 'image/*')}
      {inputEl(pdfRef, 'application/pdf')}
      {extraAccept.length > 0 && inputEl(otherRef, extraAccept.join(','))}
    </>
  )
}

/** 待发送附件的预览行：渲染在输入卡片 header 槽位的最上方（队列区之上） */
export function AttachmentPreviewRow({
  attachments,
  onRemove
}: {
  attachments: ChatAttachment[]
  onRemove: (id: string) => void
}) {
  if (attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-3 py-2">
      {attachments.map((att) => (
        <AttachmentCard key={att.id} att={att} onRemove={onRemove} />
      ))}
    </div>
  )
}

function AttachmentCard({
  att,
  onRemove
}: {
  att: ChatAttachment
  onRemove: (id: string) => void
}) {
  const isUploading = !att.uploaded && !att.error
  const isImage = att.mediaType.startsWith('image/')
  // 预览源：刚选的图片是本地 data URL；编辑回显的图片只有服务端 url —— 统一经
  // loadMediaObjectUrl 解析（web 原样、desktop 转 blob objectURL），PDF 不出缩略图
  const previewSource = att.previewUrl ?? (att.uploaded ? att.url : '')
  const [src, setSrc] = useState('')
  useEffect(() => {
    if (!isImage || !previewSource) return
    let alive = true
    loadMediaObjectUrl(previewSource)
      .then((resolved) => {
        if (alive) setSrc(resolved)
      })
      .catch(() => {
        if (alive) setSrc('')
      })
    return () => {
      alive = false
    }
  }, [isImage, previewSource])

  return (
    <div
      className={cn(
        'relative w-20 overflow-hidden rounded-lg border',
        att.error ? 'border-destructive' : 'border-border'
      )}
    >
      <div
        className={cn(
          'flex h-14 w-full items-center justify-center bg-muted/40',
          isUploading && 'opacity-60'
        )}
      >
        {isImage ? (
          src ? (
            <img src={src} alt={att.name} className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="size-5 text-muted-foreground" />
          )
        ) : (
          <FileText className="size-5 text-muted-foreground" />
        )}
      </div>
      <div className="px-1 py-0.5 text-center">
        <span className="block truncate text-[0.6875rem] text-muted-foreground">{att.name}</span>
      </div>
      {isUploading && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-border">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${att.progress}%` }} />
        </div>
      )}
      {att.error && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-destructive/15"
          title={att.error}
        >
          <AlertCircle className="size-5 text-destructive" />
        </div>
      )}
      <button
        type="button"
        aria-label={`移除 ${att.name}`}
        title={`移除 ${att.name}`}
        onClick={() => onRemove(att.id)}
        className="absolute right-1 top-1 rounded-full bg-background/85 p-0.5 text-foreground shadow-sm transition-colors hover:bg-background"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
