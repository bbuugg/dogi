import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListPlus, Search, TerminalSquare } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/stores/app-store'
import type { ScriptEntry } from '@shared/types'

/** 终端命令面板（Ctrl+Shift+P）：搜索并选择脚本，写入当前终端自动执行 */
export function ScriptPalette() {
  const open = useAppStore((s) => s.ui.scriptPaletteOpen)
  const setOpen = useAppStore((s) => s.setScriptPaletteOpen)
  const scripts = useAppStore((s) => s.scripts)
  const refreshScripts = useAppStore((s) => s.refreshScripts)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const hasActive = activeSessionId !== null
  const setView = useAppStore((s) => s.setView)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return scripts
    return scripts.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.content.toLowerCase().includes(q)
    )
  }, [scripts, query])

  // 打开时重置搜索并刷新（脚本可能在管理对话框中被改动过）
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      void refreshScripts()
      // 等待 Dialog 渲染后再聚焦输入框
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open, refreshScripts])

  // 结果变化后把高亮重置到首项，并滚动到可见
  useEffect(() => {
    setActiveIndex(0)
  }, [query, scripts])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const run = useCallback(
    (entry: ScriptEntry) => {
      if (!hasActive) return
      // 每行以回车键入，末尾额外回车执行最后一行
      const payload = entry.content.replace(/\r\n/g, '\n').replace(/\n/g, '\r') + '\r'
      void window.api.terminal.write(activeSessionId, payload)
      setOpen(false)
    },
    [activeSessionId, hasActive, setOpen]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = filtered[activeIndex]
      if (pick) void run(pick)
    }
  }

  const openManager = () => {
    setOpen(false)
    setView('scripts')
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="top-[12%] max-w-xl translate-y-0 gap-3 p-3"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogTitle className="sr-only">脚本命令面板</DialogTitle>

          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              placeholder="搜索脚本…"
              className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>

          {!hasActive && (
            <div className="rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600">
              请先打开一个终端，再执行脚本。
            </div>
          )}

          <div ref={listRef} className="max-h-80 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                {scripts.length === 0
                  ? '还没有脚本，点击下方「管理脚本」添加。'
                  : '没有匹配的脚本。'}
              </div>
            ) : (
              filtered.map((s, i) => {
                const preview = s.content.split('\n')[0] || ''
                return (
                  <button
                    key={s.id}
                    type="button"
                    data-idx={i}
                    onMouseMove={() => setActiveIndex(i)}
                    onClick={() => void run(s)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-3 py-2 text-left',
                      i === activeIndex ? 'bg-primary/15' : 'hover:bg-secondary'
                    )}
                  >
                    <TerminalSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{s.name}</div>
                      {preview && (
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {preview}
                        </div>
                      )}
                      {s.description && (
                        <div className="truncate text-xs text-muted-foreground">{s.description}</div>
                      )}
                    </div>
                  </button>
                )
              })
            )}
          </div>

          <div className="flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
            <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
            <Button variant="ghost" size="sm" className="h-7" onClick={openManager}>
              <ListPlus className="size-4" /> 管理脚本
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
