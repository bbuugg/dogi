/**
 * 消息下方的**文档入口行**：本轮写出 / 改动的 markdown 文档各渲染成一颗 chip
 * （识别见 `shared/lib/artifacts.ts` 的 `presentedDocsOf`）。
 *
 * 为什么放在消息下方的独立一行、而不是塞进正文或工具卡：
 * - 正文是**模型说的话**，工具卡是**过程**（一轮结束还会被折叠进「工具调用 ×N」里）——
 *   两者都不适合承载「给你的交付物」；
 * - 文档入口要能**离消息最近**、且点一下就到位，独立一行是唯一稳定的位置
 *   （与用量统计 `renderFooter`、操作行 `renderActions` 并列，见 `chat-surface.tsx`）。
 *
 * 视觉刻意做得像「文件签名」而不是按钮：图标 + 文件名 + 「查看」两个字，hover 才亮底色。
 * 侧栏 / 面板都窄，用正文色而不是主题色，免得一排入口把消息区抢成广告位。
 */
import { FileText } from 'lucide-react'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import type { PresentedDoc } from '@fizz/agent-kit/shared/lib/artifacts'

export function ArtifactChips({
  docs,
  onOpen,
  className
}: {
  docs: PresentedDoc[]
  /** 点开某一份文档（落点由调用方决定：主会话是右侧「文件」面板） */
  onOpen: (doc: PresentedDoc) => void
  className?: string
}) {
  const tr = useT()
  if (docs.length === 0) return null
  return (
    <div className={cn('mt-1.5 flex flex-wrap items-center gap-1.5', className)}>
      {docs.map((doc) => (
        // 提示里给完整相对路径 —— chip 上的标题会被截断，且同名文档（README.md）
        // 得靠路径区分是哪一份
        <IconTip key={doc.path} label={doc.path}>
          <button
            type="button"
            aria-label={tr('查看文档 {title}', { title: doc.title })}
            onClick={() => onOpen(doc)}
            className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-foreground transition-colors hover:bg-foreground/5"
          >
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{doc.title}</span>
            <span className="shrink-0 text-muted-foreground">{tr('查看')}</span>
          </button>
        </IconTip>
      ))}
    </div>
  )
}
