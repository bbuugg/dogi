import {
  ClipboardPaste,
  FilePlus2,
  FolderPlus,
  Loader2,
  MoreVertical,
  Upload,
} from 'lucide-react'
import { Button } from '@fizz/ui/button'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'

/**
 * 手机文件树行尾的「更多操作」：没有右键，所有条目动作从这颗按钮进。
 */
export function MobileEntryMoreButton({ onOpen }: { onOpen: () => void }) {
  return (
    <IconTip label="更多操作">
      <button
        type="button"
        aria-label="更多操作"
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      >
        <MoreVertical className="size-3.5" />
      </button>
    </IconTip>
  )
}

/**
 * 手机文件树头部的入口：桌面把这些动作放在空白处右键菜单里，手机没有右键，
 * 只能在头部保留新建 / 上传 / 粘贴到根目录。
 *
 * 上传目标沿用 `currentPasteTarget()` 的语义：选中目录 = 传进它、选中文件 = 传进它旁边、
 * 什么都没选 = 右侧当前标签所在目录，全空则回根目录。
 */
export function MobileFilesHeaderActions({
  canUpload,
  uploading,
  uploadTarget,
  clipboardLabel,
  onNewFile,
  onNewFolder,
  onUpload,
  onPasteRoot,
}: {
  canUpload: boolean
  uploading: boolean
  /** 上传目标目录（空串 = 根目录），只用于按钮 title */
  uploadTarget: string
  /** 剪贴板里待粘贴内容的说明；没有剪贴板时为 null */
  clipboardLabel: string | null
  onNewFile: () => void
  onNewFolder: () => void
  onUpload: () => void
  onPasteRoot: () => void
}) {
  return (
    <>
      <IconTip label="在根目录新建文件">
        <Button
          size="sm"
          variant="ghost"
          className="size-6 shrink-0 p-0 text-muted-foreground"
          aria-label="在根目录新建文件"
          onClick={onNewFile}
        >
          <FilePlus2 className="size-3.5" />
        </Button>
      </IconTip>
      <IconTip label="在根目录新建文件夹">
        <Button
          size="sm"
          variant="ghost"
          className="size-6 shrink-0 p-0 text-muted-foreground"
          aria-label="在根目录新建文件夹"
          onClick={onNewFolder}
        >
          <FolderPlus className="size-3.5" />
        </Button>
      </IconTip>
      {canUpload && (
        <IconTip label={`上传文件（到 ${uploadTarget || '根目录'}）`}>
          <Button
            size="sm"
            variant="ghost"
            className="size-6 shrink-0 p-0 text-muted-foreground"
            aria-label="上传文件"
            disabled={uploading}
            onClick={onUpload}
          >
            {uploading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
          </Button>
        </IconTip>
      )}
      {clipboardLabel !== null && (
        <IconTip label={`粘贴到根目录（剪贴板：${clipboardLabel}）`}>
          <Button
            size="sm"
            variant="ghost"
            className="size-6 shrink-0 p-0 text-primary"
            aria-label="粘贴到根目录"
            onClick={onPasteRoot}
          >
            <ClipboardPaste className="size-3.5" />
          </Button>
        </IconTip>
      )}
    </>
  )
}
