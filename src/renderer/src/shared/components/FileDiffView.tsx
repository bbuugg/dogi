/**
 * 「代码修改前后对比」：git 风格的 unified diff 视图。
 *
 * 目前**只有工具卡在用**：`features/agent/tool-file-diff.ts` 的 `buildFileDiff` 从工具
 * **入参**还原 hunks —— edit_file 的 oldText / newText 做行级 diff、write_file 的整文件
 * 当作「空 → 全文」的全量新增、delete_file 只给一句提示。
 *
 * 源代码管理面板**暂时还是它自己的内联实现**（`GitPanel.tsx` 里那个按行首字符上色的
 * `DiffView`）：它的输入是 `git diff` 原始文本，切过来只需先过一遍 `parseUnifiedDiff`
 * 把它解析成 hunks（`lib/diff.ts` 里那个解析器就是为此写的，带 oldStart/newStart）。
 *
 * 刻意不放进工具返回值、不送回模型：那样会把整文件灌进模型上下文。
 */
import { cn } from '../lib/utils'
import type { DiffHunk } from '../lib/diff'

/** `DiffHunk` 的定义搬到了 `lib/diff`（解析器和视图共用）；这里转出，保持老引用可用 */
export type { DiffHunk }

/** 统计 hunks 的增删行数（对比视图顶部 +N / −M 用） */
function diffStat(hunks: DiffHunk[]): { adds: number; dels: number } {
  let adds = 0
  let dels = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') adds++
      else if (l.type === 'del') dels++
    }
  }
  return { adds, dels }
}

/** 最多渲染多少行；超出只在末尾提示，避免「写入一个大文件」把对话流撑成几千个 DOM 节点 */
const DEFAULT_MAX_LINES = 400

export function FileDiffView({
  path,
  hunks,
  deleted,
  className,
  maxLines = DEFAULT_MAX_LINES
}: {
  path: string
  hunks: DiffHunk[]
  /** delete_file：入参没有内容，无法对比，只提示删了哪个文件 */
  deleted?: boolean
  /** 外间距由调用方给（组件自己不带 margin，方便塞进各种容器） */
  className?: string
  /** 渲染行数上限（0 = 不限）；被截断的部分只在末尾提示，头部计数仍是完整统计 */
  maxLines?: number
}) {
  const { adds, dels } = diffStat(hunks)
  const totalLines = hunks.reduce((n, h) => n + h.lines.length, 0)
  const truncated = maxLines > 0 && totalLines > maxLines
  /** 剩余还能渲染多少行（跨 hunk 连续扣减） */
  let budget = truncated ? maxLines : Number.POSITIVE_INFINITY

  let oldNo = 1
  let newNo = 1

  return (
    <div className={cn('overflow-hidden rounded-md border border-border font-mono text-xs', className)}>
      {/* 文件头：路径 + 增删计数 */}
      <div className="flex items-center justify-between gap-2 bg-foreground/5 px-2 py-1 text-muted-foreground">
        <span className="truncate" title={path}>
          {path}
        </span>
        <span className="shrink-0 tabular-nums">
          <span className="text-emerald-500">+{adds}</span> <span className="text-red-500">−{dels}</span>
        </span>
      </div>

      {deleted ? (
        <div className="px-2 py-1.5 text-muted-foreground/70">文件已删除（工具入参没有内容，无原文可对比）</div>
      ) : hunks.length === 0 ? (
        <div className="px-2 py-1.5 text-muted-foreground/70">
          没有可展示的文本差异（二进制文件，或只有权限 / 模式变化）
        </div>
      ) : (
        <div className="overflow-x-auto">
          {/*
            `min-w-max` 是关键：横向滚动容器里的**块级子元素只按容器宽度铺**，
            所以一行很长时往右滚，那行自己的底色（绿/红）会在右半边断掉 —— 看起来像
            「滚出去的地方没有 diff 样式」。套一层撑到「最长行宽度」的盒子，
            行/横条/截断提示就都能铺满整个滚动区。
          */}
          <div className="min-w-max">
            {hunks.map((h, hi) => {
              // git diff 的每个片段各有起点（@@ -a,b +c,d @@），按它对上行号；
              // 工具卡的片段对比没有起点，就沿用老行为：整段从 1 连续累加
              if (h.oldStart !== undefined) oldNo = h.oldStart
              if (h.newStart !== undefined) newNo = h.newStart
              // 行数预算跨 hunk 连续扣减：超限的 hunk 直接不渲染（末尾统一提示）
              const shown = budget === Number.POSITIVE_INFINITY ? h.lines : h.lines.slice(0, budget)
              if (budget !== Number.POSITIVE_INFINITY) budget -= shown.length
              if (shown.length === 0) return null
              return (
                <div key={hi}>
                  {h.header && (
                    <div className="bg-foreground/5 px-2 py-0.5 text-muted-foreground/70">
                      {h.header}
                    </div>
                  )}
                  {shown.map((l, li) => {
                    const oldGutter = l.type === 'add' ? '' : String(oldNo++)
                    const newGutter = l.type === 'del' ? '' : String(newNo++)
                    return (
                      <div
                        key={li}
                        className={cn(
                          'flex',
                          l.type === 'del' && 'bg-red-500/10',
                          l.type === 'add' && 'bg-emerald-500/10'
                        )}
                      >
                        <span
                          className={cn(
                            'w-9 shrink-0 select-none px-1 text-right tabular-nums',
                            l.type === 'del'
                              ? 'text-red-500/60'
                              : l.type === 'add'
                                ? 'text-emerald-500/60'
                                : 'text-muted-foreground/40'
                          )}
                        >
                          {oldGutter}
                        </span>
                        <span
                          className={cn(
                            'w-9 shrink-0 select-none px-1 text-right tabular-nums',
                            l.type === 'del'
                              ? 'text-red-500/60'
                              : l.type === 'add'
                                ? 'text-emerald-500/60'
                                : 'text-muted-foreground/40'
                          )}
                        >
                          {newGutter}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 select-none px-1',
                            l.type === 'del'
                              ? 'text-red-500'
                              : l.type === 'add'
                                ? 'text-emerald-500'
                                : 'text-muted-foreground/50'
                          )}
                        >
                          {l.type === 'del' ? '−' : l.type === 'add' ? '+' : ' '}
                        </span>
                        <span
                          className={cn(
                            'whitespace-pre px-1',
                            l.type === 'del'
                              ? 'text-red-300'
                              : l.type === 'add'
                                ? 'text-emerald-300'
                                : 'text-foreground/80'
                          )}
                        >
                          {l.text === '' ? ' ' : l.text}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {/* 截断提示：头部计数仍是完整统计，这里只说明画面少给了多少行 */}
            {truncated && (
              <div className="bg-foreground/5 px-2 py-1 text-muted-foreground/70">
                …（共 {totalLines} 行，只显示前 {maxLines} 行）
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
