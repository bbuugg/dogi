import { useAppStore } from '@/stores/app-store'
import {
  selectConversationListMeta,
  type ConversationListMeta
} from '@/features/agent/conversation-list-meta'
import { AcpImportDialog } from '@/features/agent/AcpImportDialog'
import type { AgentWorkspace } from '@shared/types'
import { Button, Checkbox, Dropdown, Input, Modal, message } from 'antd'
import type { MenuProps } from 'antd'
import { cn } from 'cn'
import {
  SIDEBAR_ROW_ACTION,
  SIDEBAR_ROW_NAME,
  SidebarRowActions
} from '@/shared/components/SidebarRowActions'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  CirclePause,
  Folder,
  FolderPlus,
  Import,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** 会话行图标槽的三种状态（静止时为 null，槽仍然占位以对齐两列） */
type RowStatus = 'ask' | 'confirm' | 'running' | null

/**
 * 会话行（`memo` 化的独立组件）。
 *
 * ⚠️ **必须抽出来并 memo 化**：它以前是 `AgentPanel` 里的一段内联 JSX，
 * 于是父组件每次重渲染都会重建整列行 —— 而流式输出每个 token 都会让父组件重渲染
 * （会话对象整个被换掉），表现就是「侧边栏消息一多就卡」。
 * 现在父组件只订阅**展示投影**（流式期间引用不变），这里再兜一层：
 * 状态图标变化只重渲染那一行，不牵连同列其它行。
 */
const ConversationRow = memo(function ConversationRow({
  meta,
  workspaceId,
  status,
  isActive,
  onOpen,
  onRename,
  onDelete,
  onToggleArchive
}: {
  /** 列表投影条目（结构共享：只有列表可见字段变了才会换引用，见 selectConversationListMeta） */
  meta: ConversationListMeta
  workspaceId: string
  status: RowStatus
  isActive: boolean
  onOpen: (workspaceId: string, id: string) => void
  onRename: (meta: ConversationListMeta) => void
  onDelete: (meta: ConversationListMeta) => void
  onToggleArchive: (meta: ConversationListMeta) => void
}) {
  const { id, title } = meta
  return (
    <div
      /* data-conversation-id：探针用来数「列表里到底有几条会话」
         （草稿不进列表，光看 store 里的条数是看不出来的） */
      data-conversation-id={id}
      onClick={() => onOpen(workspaceId, id)}
      className={cn(
        // 缩进交给下面那个「图标槽」占位（不再写 pl-*），标题才能和工作区名称同列
        // relative：行尾「重命名 / 删除」要绝对定位在行右侧
        'group relative flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm transition-colors',
        isActive
          ? 'bg-primary/15 text-foreground'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
      )}
      title={title}
    >
      {/*
        状态图标槽：**始终占位**（静止时是空的）—— 等待处理 > 运行中。
        占位而不是「有图标才渲染」是为了两列对齐：
        槽左边 = 行的 px-1.5、宽度 size-4，于是
          ① 运行中的转圈 / 等待图标与工作区那一行的**展开箭头**同列
            （工作区自己那枚「文件夹 / 运行中」图标在箭头右边一格）；
          ② 标题从 px-1.5 + 16 + gap-1.5 = 28px（pl-7）起，
            与工作区**名称同列**，也不会因为当前有没有图标而左右跳。
      */}
      <span
        className="flex size-4 shrink-0 items-center justify-center"
        title={
          status === 'ask'
            ? '等待你回答提问'
            : status === 'confirm'
              ? '等待你确认操作'
              : status === 'running'
                ? '正在运行'
                : undefined
        }
      >
        {status === 'ask' || status === 'confirm' ? (
          // 暂停（不是转圈）：这一轮已经停下来了，等的是你 —— 两个竖条比问号
          // 更贴「暂停中」，也顺手把审批卡（原来没有任何提示）覆盖了
          <CirclePause className="size-4 text-amber-500" />
        ) : status === 'running' ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : null}
      </span>
      {/* hover 时才把右侧三格让给「归档 / 重命名 / 删除」浮层（pe-* 按按钮个数取） */}
      <span className={SIDEBAR_ROW_NAME.three}>{title}</span>
      <SidebarRowActions
        hoverClass="group-hover:pointer-events-auto group-hover:opacity-100 max-md:pointer-events-auto max-md:opacity-100"
      >
        <button
          type="button"
          title={meta.archived ? '恢复会话' : '归档会话'}
          aria-label={`${meta.archived ? '恢复' : '归档'}会话 ${title}`}
          onClick={(e) => {
            e.stopPropagation()
            onToggleArchive(meta)
          }}
          className={SIDEBAR_ROW_ACTION}
        >
          {meta.archived ? (
            <ArchiveRestore className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          title="重命名会话"
          aria-label={`重命名会话 ${title}`}
          onClick={(e) => {
            e.stopPropagation()
            onRename(meta)
          }}
          className={SIDEBAR_ROW_ACTION}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          title="删除会话"
          aria-label={`删除会话 ${title}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(meta)
          }}
          className={cn(SIDEBAR_ROW_ACTION, 'hover:bg-destructive/10 hover:text-destructive')}
        >
          <Trash2 className="size-3.5" />
        </button>
      </SidebarRowActions>
    </div>
  )
})

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
  /**
   * ⚠️ 这里订阅的是**展示投影**而不是 `s.agentConversations`（见 selectConversationListMeta）：
   * 流式输出每个 token 都会换掉会话对象与整个数组，直接订阅会让**整列会话行每帧重渲染**
   * —— 「侧边栏消息一多就卡」的根因。投影做结构共享，只有增删 / 改名 / 排序键变化才换引用。
   */
  const conversations = useAppStore((s) => selectConversationListMeta(s.agentConversations))
  const activeWorkspaceId = useAppStore((s) => s.activeAgentWorkspaceId)
  const activeConversationId = useAppStore((s) => s.activeAgentConversationId)
  // 会话行的状态图标：这两张表都是「引用变了才变」，直接取整表再按行推导，
  // 不要用返回新对象 / 新 Set 的 selector（zustand 用 Object.is 比较，会无限重渲染）
  const agentRuns = useAppStore((s) => s.agentRuns)
  const followupRequests = useAppStore((s) => s.followupRequests)
  const pendingConfirms = useAppStore((s) => s.pendingConfirms)
  const selectAgentWorkspace = useAppStore((s) => s.selectAgentWorkspace)
  const selectAgentConversation = useAppStore((s) => s.selectAgentConversation)
  const createAgentConversation = useAppStore((s) => s.createAgentConversation)
  const renameAgentConversation = useAppStore((s) => s.renameAgentConversation)
  const deleteAgentConversation = useAppStore((s) => s.deleteAgentConversation)
  const setAgentConversationArchived = useAppStore((s) => s.setAgentConversationArchived)
  const saveAgentWorkspace = useAppStore((s) => s.saveAgentWorkspace)
  const deleteAgentWorkspace = useAppStore((s) => s.deleteAgentWorkspace)

  /** 展开的工作区 id（收起后其会话列表隐藏） */
  const [expanded, setExpanded] = useState<string[]>([])
  const [edit, setEdit] = useState<WorkspaceEdit | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AgentWorkspace | null>(null)
  /** 待重命名的会话（id 为空表示不处于重命名中） */
  const [convRename, setConvRename] = useState<{ id: string; title: string } | null>(null)
  const [pendingConvDelete, setPendingConvDelete] = useState<ConversationListMeta | null>(null)
  /** 删除 ACP 会话时是否连 agent 侧的会话一起删（默认不删，避免误删用户数据） */
  const [deleteRemoteSession, setDeleteRemoteSession] = useState(false)
  /** 展开了「已归档」分组的工作区 id（与工作区本身的展开态分开存，互不影响） */
  const [archivesExpanded, setArchivesExpanded] = useState<string[]>([])
  /** 正在为哪个工作区导入会话（null = 弹窗关闭） */
  const [importTarget, setImportTarget] = useState<AgentWorkspace | null>(null)
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

  /**
   * 按工作区归类会话，组内按最近更新排序（最近在用的在最上面），并**按归档态分成两张表**。
   *
   * ⚠️ **草稿（还没发出首条消息的会话）不进列表**：点「新建会话」只是打开这个工作区的
   * 新建会话页，列表里不该立刻冒出一条空会话 —— 它发出首条消息那一刻才转正
   * （见 `isDraftConversation`）。
   *
   * 归档不改任何会话内容，所以它只是列表分组：**已归档的会话仍然能打开、接着聊**
   * （发消息会自动取消归档，见 `sendAgentMessage`），也不参与 `latestConversation`
   * 的「切工作区落到哪一条」。
   */
  const byWorkspace = useMemo(() => {
    const map = new Map<string, ConversationListMeta[]>()
    const archivedMap = new Map<string, ConversationListMeta[]>()
    for (const c of conversations) {
      if (!c.kind) continue // 草稿（还没发出首条消息）不进列表，见 isDraftConversation
      if (!c.workspaceId) continue
      const bucket = c.archived ? archivedMap : map
      const list = bucket.get(c.workspaceId) ?? []
      list.push(c)
      bucket.set(c.workspaceId, list)
    }
    for (const table of [map, archivedMap]) {
      for (const list of table.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    return { active: map, archived: archivedMap }
  }, [conversations])

  /**
   * 每行的状态图标（等待提问 / 等待确认 / 运行中 / 静止），**一次遍历算完整张表**。
   *
   * 以前是每行调一次 `pendingKindOf`，里面对两张表各做一次 `Object.values().some()`
   * —— 成本是「行数 × 表长」。这里改成先按 requestId 收成两张 Set、再单次遍历会话。
   *
   * 三态优先级：**等待处理 > 运行中 > 静止**。等用户动手的那一轮已经停下来了，
   * 光转圈会让人以为还在跑（见 verify-agent-status.mjs）。
   */
  const statusByConversation = useMemo(() => {
    const askRequests = new Set(Object.values(followupRequests).map((f) => f.requestId))
    const confirmRequests = new Set(Object.values(pendingConfirms).map((c) => c.requestId))
    const map = new Map<string, RowStatus>()
    for (const c of conversations) {
      const run = agentRuns[c.id]
      if (!run) continue
      if (run.requestId && askRequests.has(run.requestId)) map.set(c.id, 'ask')
      else if (run.requestId && confirmRequests.has(run.requestId)) map.set(c.id, 'confirm')
      else if (run.streaming) map.set(c.id, 'running')
    }
    return map
  }, [agentRuns, followupRequests, pendingConfirms, conversations])

  /** 行内回调：引用固定，否则 memo 化的行每次都会因 props 变化而重渲染 */
  const openConversation = useCallback(
    (workspaceId: string, id: string) => {
      selectAgentWorkspace(workspaceId)
      selectAgentConversation(id)
    },
    [selectAgentWorkspace, selectAgentConversation]
  )
  const startConvRename = useCallback(
    (meta: ConversationListMeta) => setConvRename({ id: meta.id, title: meta.title }),
    []
  )
  const startConvDelete = useCallback(
    (meta: ConversationListMeta) => setPendingConvDelete(meta),
    []
  )
  /** 归档 / 恢复（同一入口：目标态 = 当前态取反） */
  const toggleConvArchive = useCallback(
    (meta: ConversationListMeta) => {
      void setAgentConversationArchived(meta.id, !meta.archived)
    },
    [setAgentConversationArchived]
  )
  const toggleArchivesExpanded = (workspaceId: string) =>
    setArchivesExpanded((prev) =>
      prev.includes(workspaceId)
        ? prev.filter((x) => x !== workspaceId)
        : [...prev, workspaceId]
    )

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
    // 只有 ACP 会话（且确实绑定了 agent 侧会话）才谈得上「连它一起删」
    const remote =
      deleteRemoteSession && target.kind === 'acp' && !!target.acpAgentId && !!target.acpSessionId
    setPendingConvDelete(null)
    setDeleteRemoteSession(false)
    try {
      await deleteAgentConversation(target.id, { deleteRemoteSession: remote })
    } catch (err) {
      message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 行尾小按钮统一样式：平时隐形，hover 所在行才浮现；没有 hover 的窄屏（<768px）常显 */
  const rowAction = SIDEBAR_ROW_ACTION

  /**
   * 工作区行的操作菜单。
   *
   * 「新建会话」**不在**这里 —— 它是本工作区最高频的动作，每次都要展开「更多」才碰得到，
   * 所以提到行尾常驻（见下面的悬浮操作区）。这里只留低频项：
   * 导入会话 / 重命名 / 删除（原先连重命名、删除也是平铺按钮，行一窄就把工作区名挤没了）。
   */
  const workspaceMenuItems = (): MenuProps['items'] => [
    { key: 'import', label: '导入会话', icon: <Import className="size-3.5" /> },
    { type: 'divider' },
    { key: 'rename', label: '重命名工作区', icon: <Pencil className="size-3.5" /> },
    {
      key: 'delete',
      label: '删除工作区',
      icon: <Trash2 className="size-3.5" />,
      danger: true
    }
  ]

  /** 「更多」下拉的点击分发（不再有「新建会话」—— 它已常驻行尾） */
  const handleWorkspaceMenu = (w: AgentWorkspace): MenuProps['onClick'] =>
    ({ key, domEvent }) => {
      // 菜单挂在会切换展开状态的行上：不拦住冒泡的话，点「重命名」会顺手把列表收起
      domEvent.stopPropagation()
      if (key === 'import') setImportTarget(w)
      else if (key === 'rename') setEdit({ id: w.id, name: w.name, path: w.path })
      else if (key === 'delete') setPendingDelete(w)
    }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center justify-between gap-1 px-3 py-1">
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
            空空如也。
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {workspaces.map((w) => {
              const isWsSelected = w.id === activeWorkspaceId
              const isExpanded = expanded.includes(w.id)
              const list = byWorkspace.active.get(w.id) ?? []
              const archivedList = byWorkspace.archived.get(w.id) ?? []
              /** 「已归档」分组的展开态独立于工作区本身（随会话列表一起收起/展开） */
              const isArchivesOpen = archivesExpanded.includes(w.id)
              /**
               * 工作区那枚「文件夹 / 运行中」图标的状态：该工作区下**只要有一条会话还在进行中**
               * 就换成会话用的图标，否则是安静的文件夹。
               *
               * 优先级与会话行一致：**等待处理 > 运行中 > 静止**（转圈会让人以为还在跑，
               * 而等着用户回答/确认的那一轮其实已经停下来了，见 verify-agent-status.mjs）。
               */
              const wsStatus = ((): RowStatus => {
                let running = false
                // 归档会话也一并算：它只是折起来了，仍在跑就该让工作区亮着
                for (const c of [...list, ...archivedList]) {
                  const st = statusByConversation.get(c.id)
                  if (st === 'ask' || st === 'confirm') return st
                  if (st === 'running') running = true
                }
                return running ? 'running' : null
              })()
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
                      // relative：行尾两个按钮要绝对定位在行右侧（见 SidebarRowActions）
                      'group relative flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm transition-colors',
                      isActiveWs
                        ? 'bg-primary/15 text-foreground'
                        : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                    )}
                    title={w.path}
                  >
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
                    {/*
                      工作区图标：**有会话在跑就换成会话的状态图标**（转圈 / 等待），
                      没有才显示安静的文件夹 —— 一眼能看出「这个项目下的 Agent 还活着吗」，
                      不用逐条会话去扫。槽宽固定 size-4，静止时也不塌，标题不会左右跳。
                    */}
                    <span
                      className="flex size-4 shrink-0 items-center justify-center"
                      title={
                        wsStatus === 'running'
                          ? '有会话正在运行'
                          : wsStatus
                            ? '有会话在等你回答 / 确认'
                            : undefined
                      }
                    >
                      {wsStatus === 'running' ? (
                        <Loader2 className="size-4 animate-spin text-primary" />
                      ) : wsStatus ? (
                        <CirclePause className="size-4 text-amber-500" />
                      ) : (
                        <Folder className="size-4" />
                      )}
                    </span>
                    {/*
                      名称 `flex-1` 吃掉余量，`min-w-0 truncate` 保证长名字不出省略号以外的溢出。
                      行尾按钮改成**绝对定位浮层**后，名称平时能吃满整行；只有 hover 时
                      `group-hover:pe-14` 才让出按钮那一段 —— 之前按钮留在 flex 流里，
                      即便 `opacity-0` 也照样占一格，工作区名全程被提前截断。
                    */}
                    <span className={SIDEBAR_ROW_NAME.two}>{w.name}</span>

                    {/*
                      行尾悬浮操作区（与 fishwork 侧栏同一套做法）：
                      「新建会话」常驻「更多」左边 —— 它是最高频动作，不该每次都展开菜单；
                      「更多」收低频项：导入会话 / 重命名 / 删除。
                    */}
                    <SidebarRowActions
                      hoverClass="group-hover:pointer-events-auto group-hover:opacity-100 max-md:pointer-events-auto max-md:opacity-100"
                    >
                      <button
                        type="button"
                        title={`在 ${w.name} 中新建会话`}
                        aria-label={`在 ${w.name} 中新建会话`}
                        onClick={(e) => {
                          e.stopPropagation()
                          createAgentConversation(w.id)
                          if (!isExpanded) toggleExpand(w.id)
                        }}
                        className={rowAction}
                      >
                        <MessageSquarePlus className="size-3.5" />
                      </button>
                      <Dropdown
                        trigger={['click']}
                        placement="bottomRight"
                        menu={{
                          items: workspaceMenuItems(),
                          onClick: handleWorkspaceMenu(w)
                        }}
                      >
                        <button
                          type="button"
                          title="更多操作"
                          aria-label={`${w.name} 的更多操作`}
                          onClick={(e) => e.stopPropagation()}
                          className={rowAction}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </button>
                      </Dropdown>
                    </SidebarRowActions>
                  </div>

                  {/* 会话列表：嵌在工作区下方，**只用缩进表示从属**（与 fishwork 侧栏一致，不画竖线/分隔符） */}
                  {isExpanded && (
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {/* 一条未归档会话都没有时才提示（下方可能还有「已归档」分组） */}
                      {list.length === 0 && archivedList.length === 0 && (
                        <div className="py-1.5 pl-7 text-xs text-muted-foreground/60">
                          还没有会话：选好模型、发出第一条消息后，它会出现在这里
                        </div>
                      )}
                      {list.map((c) => (
                        <ConversationRow
                          key={c.id}
                          meta={c}
                          workspaceId={w.id}
                          status={statusByConversation.get(c.id) ?? null}
                          // 会话行高亮只看「是不是当前激活会话」（它所在的工作区行已让位不高亮）
                          isActive={c.id === activeConversationId && isWsSelected}
                          onOpen={openConversation}
                          onRename={startConvRename}
                          onDelete={startConvDelete}
                          onToggleArchive={toggleConvArchive}
                        />
                      ))}

                      {/* 已归档：默认收起的分组（会话只是被折起来，内容一个字节都没动） */}
                      {archivedList.length > 0 && (
                        <div className="mt-1">
                          <button
                            type="button"
                            title={`已归档的 ${archivedList.length} 个会话`}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleArchivesExpanded(w.id)
                            }}
                            className="flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pl-7 pr-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                          >
                            <ChevronRight
                              className={cn(
                                'size-3.5 transition-transform duration-200',
                                isArchivesOpen && 'rotate-90'
                              )}
                            />
                            <Archive className="size-3" />
                            <span className="truncate">已归档 ({archivedList.length})</span>
                          </button>
                          {isArchivesOpen && (
                            <div className="mt-0.5 flex flex-col gap-0.5">
                              {archivedList.map((c) => (
                                <ConversationRow
                                  key={c.id}
                                  meta={c}
                                  workspaceId={w.id}
                                  status={statusByConversation.get(c.id) ?? null}
                                  isActive={c.id === activeConversationId && isWsSelected}
                                  onOpen={openConversation}
                                  onRename={startConvRename}
                                  onDelete={startConvDelete}
                                  onToggleArchive={toggleConvArchive}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
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
        onCancel={() => {
          setPendingConvDelete(null)
          setDeleteRemoteSession(false)
        }}
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
          {pendingConvDelete?.kind === 'acp'
            ? `将从应用里移除「${pendingConvDelete.title}」这条会话记录；它的消息由 ACP agent 自己保存，不受影响。`
            : `「${pendingConvDelete?.title}」的对话记录将被删除，该操作不可撤销。`}
        </p>
        {/* ACP 会话：可选把 agent 侧的会话也删掉（默认不删 —— 删了就拉不回来了） */}
        {pendingConvDelete?.kind === 'acp' && pendingConvDelete.acpSessionId && (
          <Checkbox
            className="mt-3"
            checked={deleteRemoteSession}
            onChange={(e) => setDeleteRemoteSession(e.target.checked)}
          >
            <span className="text-xs">同时删除 ACP agent 侧的会话（不可撤销）</span>
          </Checkbox>
        )}
      </Modal>

      {/* 导入会话：按工作区打开，选中 agent 后可拉取已有会话或新建会话 */}
      {importTarget && (
        <AcpImportDialog
          workspace={importTarget}
          open
          onClose={() => setImportTarget(null)}
        />
      )}

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
