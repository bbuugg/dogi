/**
 * 「选择目录」弹窗：**web 端**的目录选择器。
 *
 * 浏览器碰不到服务端的文件系统，只能让 server 列目录（`GET /api/fs/dirs`）、
 * 代劳建目录（`POST /api/fs/mkdir`），所以这里自带一个目录浏览器：路径可直接编辑后回车跳转，
 * 也能进子目录 / 回上级 / 跳到某个盘符根 / **在当前目录下新建文件夹**。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder, FolderPlus, Loader2 } from 'lucide-react'
import type { FsDirsResult } from '@fizz/contracts/agent-api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { Button } from '@fizz/ui/button'
import { Input } from '@fizz/ui/input'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export function ServerDirPicker({
  app,
  open,
  onOpenChange,
  onPick,
  description
}: {
  app: AgentApp
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 用户确认了当前目录（服务端上的绝对路径） */
  onPick: (path: string) => void
  /**
   * 副标题。默认文案是「登记为工作区」—— 但这个组件早就被**别的用途**复用了
   * （笔记根、技能的额外目录、Git 导入的父目录），照默认写的那句话在那些地方是错的。
   * 复用方都该传一句说清「选中的目录会被拿去干什么」。
   */
  description?: string
}) {
  const [data, setData] = useState<FsDirsResult | null>(null)
  /** 输入框里的路径：回车才跳转，免得边打字边发请求 */
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 「新建文件夹」输入行是否展开（列表顶部那一行） */
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  /** 正在提交新建（期间禁掉输入与按钮，别让用户连点建出好几个） */
  const [creatingBusy, setCreatingBusy] = useState(false)

  const load = useCallback(
    async (path: string): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const result = await app.listServerDirs(path)
        setData(result)
        setDraft(result.path)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [app]
  )

  // `app` 每次渲染都是新对象（useAgentApp 返回字面量，方法都是内联箭头函数），把 `load`
  // 直接挂进 effect 依赖会把「打开弹窗 → 请求 → setState 重渲染 → load 换新引用 → effect
  // 再跑」拖成无限请求循环。与 GitPanel 的 refreshRef 同一个理由：ref 拿最新实现，effect
  // 只在「打开」时跑一次。
  const loadRef = useRef(load)
  loadRef.current = load

  // 每次打开都从服务端用户主目录重新起（别留着上次的深层路径），顺手收起新建行
  useEffect(() => {
    if (!open) return
    setData(null)
    setError(null)
    setCreating(false)
    setNewName('')
    void loadRef.current('')
  }, [open])

  /**
   * 在当前目录下建文件夹，**建完直接进去**（省一次点击：刚建的空目录本来就是想去的地方）。
   * 失败时保留输入行，让用户改个名字重试 —— 错误信息显示在列表区，输入内容不丢。
   */
  const createFolder = async (): Promise<void> => {
    if (!data) return
    const name = newName.trim()
    if (!name) return
    setCreatingBusy(true)
    setError(null)
    try {
      const created = await app.createServerDir(data.path, name)
      setCreating(false)
      setNewName('')
      await load(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreatingBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        **高度固定**（用户要求）：不跟目录条数变。
        做法 = 弹窗给死高度（`h-[32rem]`）+ 纵向 flex，列表 `flex-1 min-h-0` 吃掉「扣掉头尾之后
        剩下的那部分」—— 条数变了只影响列表内部滚动，弹窗和列表盒子的高度都不动。
        原来是 `min-h-40 max-h-[45dvh]`：空目录 160px、目录一多涨到 45dvh，在目录之间来回切时
        整个弹窗跟着一跳一跳。
        `max-h-[85dvh]` 留着兜底：视口比 32rem 还矮时（横屏手机 / 小窗口）按视口缩，
        此时列表跟着缩，但**仍然不随条数变**。
        注意基础类里的 `grid` 会被这里的 `flex` 直接顶掉（`cn` 是 tailwind-merge 系，同组同修饰符去重）。
      */}
      <DialogContent className="flex h-[32rem] max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>选择目录</DialogTitle>
          <DialogDescription>
            {description ??
              '这里列的是服务端上的目录（Agent 就跑在那台机器上）。选中的目录会登记为工作区。'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="size-8 shrink-0 p-0"
            aria-label="上一级"
            disabled={!data?.parent || loading}
            onClick={() => {
              if (data?.parent) void load(data.parent)
            }}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(draft.trim())
            }}
            placeholder="绝对路径，回车跳转"
            className="min-w-0 flex-1 font-mono text-xs"
          />
          {/* 新建文件夹：在**当前目录**下建（列表顶部展开一行输入），不是建到某个子目录里 */}
          <Button
            size="sm"
            variant="outline"
            className="size-8 shrink-0 p-0"
            aria-label="新建文件夹"
            title="在当前目录下新建文件夹"
            disabled={!data || loading || creating}
            onClick={() => {
              setCreating(true)
              setNewName('')
              setError(null)
            }}
          >
            <FolderPlus className="size-4" />
          </Button>
        </div>

        {/* 多盘符（Windows）时给一排「跳到哪个盘」；单根（POSIX）不必占地方 */}
        {data && data.roots.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {data.roots.map((root) => (
              <button
                key={root.path}
                type="button"
                onClick={() => void load(root.path)}
                className={cn(
                  'rounded-md px-2 py-0.5 text-xs transition-colors',
                  root.path === data.path
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                )}
              >
                {root.name}
              </button>
            ))}
          </div>
        )}

        <div
          className={cn(
            // 列表盒固定高度：`flex-1` 拿「弹窗扣掉头/尾」的剩余空间，内部滚动。
            // 别写回 `min-h-40 max-h-[45dvh]` —— 那样盒子高度会跟着目录条数变（见上面 DialogContent 的注释）
            'min-h-0 flex-1 overflow-auto rounded-md border border-border/60',
            loading && data && 'opacity-60'
          )}
        >
          {/* 新建行贴顶：目录一多列表会滚，输入框不能跟着滚出去（autoFocus 也会把它带进视口） */}
          {creating && (
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-secondary/40 px-3 py-1.5 backdrop-blur-sm">
              <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createFolder()
                  // Esc 只收起这一行：stopPropagation 是拦 Radix 的 Dialog
                  // （它自己在 document 上听 Escape 关弹窗），拦不住也只是退回原行为
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setCreating(false)
                  }
                }}
                disabled={creatingBusy}
                placeholder="新文件夹名字，回车创建"
                className="h-7 min-w-0 flex-1 text-xs"
              />
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!newName.trim() || creatingBusy}
                onClick={() => void createFolder()}
              >
                创建
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={creatingBusy}
                onClick={() => setCreating(false)}
              >
                取消
              </Button>
            </div>
          )}
          {/* 三种「没有列表项」的状态都撑满这个固定高度的盒子并垂直居中：
              盒子高度是定死的，再用 py-* 顶出来的话字全挤在上边缘 */}
          {loading && !data && (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              读取目录…
            </div>
          )}
          {error && (
            <p className="flex h-full items-center justify-center px-3 text-center text-xs text-destructive">
              {error}
            </p>
          )}
          {!loading && !error && data?.entries.length === 0 && (
            <p className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
              这个目录下没有子目录
            </p>
          )}
          {data?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => void load(entry.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-secondary/60"
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          ))}
        </div>

        <DialogFooter className="items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            title={data?.path}
          >
            {data?.path}
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!data || loading}
            onClick={() => {
              if (!data) return
              onPick(data.path)
              onOpenChange(false)
            }}
          >
            选择此目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
