import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Modal, message } from 'antd'
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Loader2,
  MessageCircleQuestionMark,
  MessageSquarePlus,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type { AgentConversation, AgentWorkspace } from '@shared/types'

/** 新建 / 重命名工作区表单 */
interface WorkspaceEdit {
  id?: string
  name: string
  path: string
}

/** 路径取末段作为默认名（去掉结尾分隔符） */
function defaultName(path: string): string {
  const p = path.replace(/[\\/]+$/, '')
  const seg = p.split(/[\\/]/).pop()
  return seg || p
}

/**
 * Agent 侧边栏：工作区 + 其下的会话列表（两层）。
 *
 * 一个工作区（绑定的本地目录）下可以有多个会话，每个会话是独立的消息历史与
 * Agent 上下文（ACP 后端的 agent session 也按会话隔离）。
 * 工作区行可展开/收起，展开后列出该工作区的会话：点击即切换，行尾可重命名 / 删除。
 *
 * 布局与交互对齐「主机 / 脚本」侧边栏，但这里只有两层、不需要拖拽排序。
 */
export function AgentPanel() {
  const workspaces = useAppStore((s) => s.agentWorkspaces)
  const conversations = useAppStore((s) => s.agentConversations)
  const activeWorkspaceId = useAppStore((s) => s.activeAgentWorkspaceId)
  const activeConversationId = useAppStore((s) => s.activeAgentConversationId)
  // 会话行的状态图标：这两张表都是「引用变了才变」，直接取整表再按行推导，
  // 不要用返回新对象 / 新 Set 的 selector（zustand 用 Object.is 比较，会无限重渲染）
  const agentRuns = useAppStore((s) => s.agentRuns)
  const followupRequests = useAppStore((s) => s.followupRequests)
  const selectAgentWorkspace = useAppStore((s) => s.selectAgentWorkspace)
  const selectAgentConversation = useAppStore((s) => s.selectAgentConversation)
  const createAgentConversation = useAppStore((s) => s.createAgentConversation)
  const renameAgentConversation = useAppStore((s) => s.renameAgentConversation)
  const deleteAgentConversation = useAppStore((s) => s.deleteAgentConversation)
  const saveAgentWorkspace = useAppStore((s) => s.saveAgentWorkspace)
  const deleteAgentWorkspace = useAppStore((s) => s.deleteAgentWorkspace)

  /** 展开的工作区 id（收起后其会话列表隐藏） */
  const [expanded, setExpanded] = useState<string[]>([])
  const [edit, setEdit] = useState<WorkspaceEdit | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AgentWorkspace | null>(null)
  /** 待重命名的会话（id 为空表示不处于重命名中） */
  const [convRename, setConvRename] = useState<{ id: string; title: string } | null>(null)
  const [pendingConvDelete, setPendingConvDelete] = useState<AgentConversation | null>(null)
  const [picking, setPicking] = useState(false)

  /**
   * 切换到**另一个**工作区时把它展开（从别处切过来也能立刻看到它的会话）。
   *
   * 只在 activeWorkspaceId 真的变化时动手：否则用户在同一工作区上手动收起后，
   * 任何一次重渲染都会把它又撑开。
   */
  const prevActiveRef = useRef<string | null>(null)
  useEffect(() => {
    const changed = activeWorkspaceId !== prevActiveRef.current
    prevActiveRef.current = activeWorkspaceId
    if (!activeWorkspaceId || !changed) return
    setExpanded((prev) => (prev.includes(activeWorkspaceId) ? prev : [...prev, activeWorkspaceId]))
  }, [activeWorkspaceId])

  /** 按工作区归类会话，组内按最近更新排序（最近在用的在最上面） */
  const byWorkspace = useMemo(() => {
    const map = new Map<string, AgentConversation[]>()
    for (const c of conversations) {
      const list = map.get(c.workspaceId) ?? []
      list.push(c)
      map.set(c.workspaceId, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
    return map
  }, [conversations])

  /**
   * 该会话是否正在等用户回答提问（`ask_followup_question` 的卡片挂在它的请求上）。
   * followupRequests 按 toolCallId 索引，靠 requestId 反查所属会话（一个会话同时只有一个请求在跑）。
   */
  const isAsking = (conversationId: string): boolean => {
    const requestId = agentRuns[conversationId]?.requestId
    if (!requestId) return false
    return Object.values(followupRequests).some((f) => f.requestId === requestId)
  }

  const toggleExpand = (id: string) =>
    setExpanded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  /** 打开系统目录选择框，回填路径（选了路径才允许保存） */
  const pickDir = async () => {
    if (!edit) return
    if (picking) return
    setPicking(true)
    try {
      const { canceled, filePaths } = await window.api.dialog.open({
        properties: ['openDirectory']
      })
      if (canceled || !filePaths[0]) return
      setEdit((e) => (e ? { ...e, path: filePaths[0] } : e))
    } catch (err) {
      message.error(`选择目录失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPicking(false)
    }
  }

  const submitEdit = async () => {
    if (!edit) return
    if (!edit.path.trim()) {
      message.warning('请选择工作区目录')
      return
    }
    try {
      await saveAgentWorkspace({
        id: edit.id,
        name: edit.name.trim() || defaultName(edit.path),
        path: edit.path
      })
      setEdit(null)
    } catch (err) {
      message.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    try {
      await deleteAgentWorkspace(target.id)
      message.success(`已删除工作区「${target.name}」`)
    } catch (err) {
      message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const submitConvRename = async () => {
    const target = convRename
    if (!target) return
    setConvRename(null)
    try {
      await renameAgentConversation(target.id, target.title)
    } catch (err) {
      message.error(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const confirmConvDelete = async () => {
    const target = pendingConvDelete
    if (!target) return
    setPendingConvDelete(null)
    try {
      await deleteAgentConversation(target.id)
    } catch (err) {
      message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 行尾小按钮统一样式：平时隐形，hover 所在行才浮现；没有 hover 的窄屏（<768px）常显 */
  const rowAction =
    'rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100 max-md:opacity-100'

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center justify-between gap-1 px-3 py-2">
        <span className="text-sm font-medium text-muted-foreground">
          工作区 ({workspaces.length})
        </span>
        <Button
          type="text"
          size="small"
          className="px-0.5 text-muted-foreground"
          title="新建工作区"
          icon={<Plus className="size-3.5" />}
          onClick={() => setEdit({ name: '', path: '' })}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {workspaces.length === 0 ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            还没有工作区。
            <br />
            点击右上角 + 选择一个本地目录，
            <br />
            Agent 将只在该目录内读写文件与执行命令。
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {workspaces.map((w) => {
              const isWsSelected = w.id === activeWorkspaceId
              const isExpanded = expanded.includes(w.id)
              const list = byWorkspace.get(w.id) ?? []
              /**
               * 当前激活会话就属于这个工作区时，分组头不再高亮 ——
               * 会话行自己已经高亮了，分组再亮一份反而看不清「选中点」在哪。
               */
              const hasActiveConv =
                activeConversationId != null && list.some((c) => c.id === activeConversationId)
              const isActiveWs = isWsSelected && !hasActiveConv
              return (
                <div key={w.id}>
                  <div
                    onClick={() => {
                      // 点整行 = 选中该工作区 + 切换它的会话列表展开状态，
                      // 不必非得去点名称右侧那个箭头
                      selectAgentWorkspace(w.id)
                      toggleExpand(w.id)
                    }}
                    className={cn(
                      'group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm transition-colors',
                      isActiveWs
                        ? 'bg-primary/15 text-foreground'
                        : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                    )}
                    title={w.path}
                  >
                    <Folder
                      className={cn(
                        'size-4 shrink-0',
                        isActiveWs ? 'text-primary' : 'text-muted-foreground'
                      )}
                    />
                    {/*
                      名称与展开箭头必须是这一行的**同级 flex 子项**：
                      - 名称**不要**给 `flex-1`：它按自身宽度占位，箭头才会随名称长度往右走，
                        最长只能顶到右侧那排按钮（「新建会话」…）之前，再长就截断成省略号；
                      - 两者都在 flex 行里，由 `items-center` 按**中线**对齐（不会走基线错位）；
                      - `min-w-0 truncate` 保证长名字不出省略号以外的溢出，
                        也不会把箭头挤出可视区（看起来像「没有展开图标」）。
                    */}
                    <span className="min-w-0 truncate">{w.name}</span>
                    <button
                      type="button"
                      title={isExpanded ? '收起会话' : '展开会话'}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleExpand(w.id)
                      }}
                      className="shrink-0 rounded p-0.5 hover:bg-foreground/10"
                    >
                      <ChevronRight
                        className={cn('size-4 transition-transform duration-200', isExpanded && 'rotate-90')}
                      />
                    </button>
                    {/* 弹性空隙：吃掉「名称 + 箭头」到行尾按钮之间的余量，名称再长也止步于按钮左侧 */}
                    <span className="flex-1" aria-hidden="true" />
                    <button
                      type="button"
                      title="新建会话"
                      onClick={(e) => {
                        e.stopPropagation()
                        createAgentConversation(w.id)
                        if (!isExpanded) toggleExpand(w.id)
                      }}
                      className={rowAction}
                    >
                      <MessageSquarePlus className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="重命名工作区"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEdit({ id: w.id, name: w.name, path: w.path })
                      }}
                      className={rowAction}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="删除工作区"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingDelete(w)
                      }}
                      className={cn(rowAction, 'hover:bg-destructive/10 hover:text-destructive')}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>

                  {/* 会话列表：嵌在工作区下方，**只用缩进表示从属**（与 fishwork 侧栏一致，不画竖线/分隔符） */}
                  {isExpanded && (
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {list.length === 0 && (
                        <div className="py-1.5 pl-7 text-xs text-muted-foreground/60">
                          还没有会话，点右侧的「新建会话」图标开始
                        </div>
                      )}
                      {list.map((c) => {
                        // 会话行高亮只看「是不是当前激活会话」（它所在的分组头已让位不高亮）
                        const isActiveConv = c.id === activeConversationId && isWsSelected
                        // 提问优先于运行中：它需要用户动手，光转圈会让人以为还在跑
                        const asking = isAsking(c.id)
                        const running = agentRuns[c.id]?.streaming === true
                        return (
                          <div
                            key={c.id}
                            onClick={() => {
                              selectAgentWorkspace(w.id)
                              selectAgentConversation(c.id)
                            }}
                            className={cn(
                              // 缩进交给下面那个「图标槽」占位（不再写 pl-*），标题才能和工作区名称同列
                              'group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm transition-colors',
                              isActiveConv
                                ? 'bg-primary/15 text-foreground'
                                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                            )}
                            title={c.title}
                          >
                            {/*
                              状态图标槽：**始终占位**（静止时是空的）—— 等回答 > 运行中。
                              占位而不是「有图标才渲染」是为了两列对齐：
                              槽左边 = 行的 px-1.5、宽度 size-4，于是
                                ① 运行中的转圈 / 等待图标与工作区的**文件夹图标同列**；
                                ② 标题从 px-1.5 + 16 + gap-1.5 = 28px（pl-7）起，
                                   与工作区**名称同列**，也不会因为当前有没有图标而左右跳。
                            */}
                            <span
                              className="flex size-4 shrink-0 items-center justify-center"
                              title={asking ? '等待你的回答' : running ? '正在运行' : undefined}
                            >
                              {asking ? (
                                <MessageCircleQuestionMark className="size-4 text-amber-500" />
                              ) : running ? (
                                <Loader2 className="size-4 animate-spin text-primary" />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{c.title}</span>
                            <button
                              type="button"
                              title="重命名会话"
                              onClick={(e) => {
                                e.stopPropagation()
                                setConvRename({ id: c.id, title: c.title })
                              }}
                              className={rowAction}
                            >
                              <Pencil className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              title="删除会话"
                              onClick={(e) => {
                                e.stopPropagation()
                                setPendingConvDelete(c)
                              }}
                              className={cn(rowAction, 'hover:bg-destructive/10 hover:text-destructive')}
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 新建 / 重命名工作区 */}
      <Modal
        open={edit !== null}
        onCancel={() => setEdit(null)}
        title={edit?.id ? '重命名工作区' : '新建工作区'}
        okText="保存"
        cancelText="取消"
        centered
        width={440}
        destroyOnHidden
        okButtonProps={{ disabled: !edit?.path.trim() }}
        onOk={() => void submitEdit()}
      >
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">名称</div>
            <Input
              autoFocus
              placeholder="工作区名称（留空自动取目录名）"
              value={edit?.name ?? ''}
              onChange={(e) => setEdit((v) => (v ? { ...v, name: e.target.value } : v))}
              onPressEnter={() => void submitEdit()}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">目录</div>
            <div className="flex gap-1.5">
              <Input
                placeholder="工作区根目录（Agent 只能在此目录内操作）"
                value={edit?.path ?? ''}
                onChange={(e) => setEdit((v) => (v ? { ...v, path: e.target.value } : v))}
              />
              <Button
                icon={<FolderPlus className="size-3.5" />}
                loading={picking}
                onClick={() => void pickDir()}
              >
                选择
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* 重命名会话 */}
      <Modal
        open={convRename !== null}
        onCancel={() => setConvRename(null)}
        title="重命名会话"
        okText="保存"
        cancelText="取消"
        centered
        width={400}
        destroyOnHidden
        onOk={() => void submitConvRename()}
      >
        <Input
          autoFocus
          placeholder="会话标题"
          value={convRename?.title ?? ''}
          onChange={(e) => setConvRename((v) => (v ? { ...v, title: e.target.value } : v))}
          onPressEnter={() => void submitConvRename()}
        />
      </Modal>

      {/* 删除会话确认 */}
      <Modal
        open={pendingConvDelete !== null}
        onCancel={() => setPendingConvDelete(null)}
        title="删除会话？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmConvDelete()}
        centered
        width={420}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingConvDelete?.title}」的对话记录将被删除，该操作不可撤销。
        </p>
      </Modal>

      {/* 删除工作区确认 */}
      <Modal
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        title="删除工作区？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        centered
        width={420}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingDelete?.name}」及其全部会话都将被移除（不会删除目录中的文件）。
        </p>
      </Modal>
    </div>
  )
}
