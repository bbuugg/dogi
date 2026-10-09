import { conversationKind, useAppStore } from '@/stores/app-store'
import {
  selectConversationListMeta,
  type ConversationListMeta
} from '@/features/agent/conversation-list-meta'
import { AcpImportDialog } from '@/features/agent/AcpImportDialog'
import { AgentUsageDrawer } from '@/features/agent/AgentUsageDrawer'
import { GitCloneDialog } from '@/features/agent/GitCloneDialog'
import type { AgentWorkspace } from '@shared/types'
import { Button, Checkbox, Dropdown, Input, Modal, Tooltip, message } from 'antd'
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
  BarChart3,
  Bot,
  Check,
  ChevronRight,
  CirclePause,
  FileDown,
  Folder,
  FolderPlus,
  GitBranch,
  Import,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Trash2
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { revealTruncatedName, resetTruncatedName } from '@/shared/lib/hover-reveal'

/** 「没登记任何 ACP agent」时的稳定空数组：selector 必须每次返回同一引用（见 zustand 快照比较） */
const EMPTY_ACP_AGENTS: { id: string; name: string }[] = []

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
  onToggleArchive,
  onExport
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
  /** 导出成 JSON 文件（带走 / 分享 / 当模板） */
  onExport: (meta: ConversationListMeta) => void
}) {
  const { id, title } = meta
  /** 有效形态：走 `conversationKind` 兼容缺 `kind` 的老存档（别各处自己判 kind） */
  const kind = conversationKind(meta)
  /** 外部 ACP agent 管理的会话（行首图标、行尾菜单都按它分叉） */
  const isAcp = kind === 'acp'
  /**
   * 「更多」下拉里的动作：**导出**（低频）+ **删除**（收在菜单最下方，危险色）。
   * 归档 / 重命名仍然常驻行尾 —— 它们是高频轻动作，藏进菜单反而多一次点击。
   *
   * 「从此签出」**不在这里**：签出是「从会话里某条消息分出一条新会话」，
   * 入口挂在那条消息的 hover 操作行上（见 AgentPage 的消息级签出）。
   *
   * ⚠️ **ACP 会话没有「导出」**：它的消息在 agent 那边，本地一个字节都没有，
   * 导出只会得到一份空壳。但**删除照给** —— 那是每个会话都要有的动作，
   * 只是被收进了菜单，不能因为类型不同就整个菜单都不给。
   */
  const canExport = kind !== 'acp'
  /**
   * 归档的**就地二次确认**（对齐 fishwork）：第一次点只把按钮变成「确认归档」的勾
   * （amber 高亮，提示「再点一次才生效」），再点才真归档；鼠标移开该行即反悔。
   *
   * 为什么不用弹窗：归档完全可逆（恢复按钮就在同一个位置），弹窗把一个轻动作做重了；
   * 也为什么「恢复」不走这套 —— 取回本来就是一键直达，再拦一道是添乱。
   */
  const [confirmingArchive, setConfirmingArchive] = useState(false)
  const moreItems: MenuProps['items'] = canExport
    ? [
        { key: 'export', label: '导出会话…', icon: <FileDown className="size-3.5" /> },
        { type: 'divider' },
        { key: 'delete', label: '删除会话', icon: <Trash2 className="size-3.5" />, danger: true }
      ]
    : [{ key: 'delete', label: '删除会话', icon: <Trash2 className="size-3.5" />, danger: true }]
  return (
    <div
      /* data-conversation-id：探针用来数「列表里到底有几条会话」
         （草稿不进列表，光看 store 里的条数是看不出来的） */
      data-conversation-id={id}
      /* 形态：探针据此断言「行首那枚图标确实跟着形态变」（不必去猜图标是哪个组件） */
      data-conversation-kind={isAcp ? 'acp' : 'mastra'}
      onClick={() => onOpen(workspaceId, id)}
      className={cn(
        /**
         * ⚠️ 左边距**不能省、也不能算错**：工作区那一行是 [展开箭头][状态图标][名称] **三格**，
         * 会话行只有 [状态图标][标题] **两格**。会话行的左内边距必须等于工作区行「名称之前」
         * 的全部宽度，两列才对得上：
         *
         *   px-1.5 (6) + 箭头按钮 (p-0.5 + size-4 = 20) + gap-1.5 (6) = **32px**
         *
         * 补上之后：
         * ① 会话行的状态图标（转圈 / 等待 / 形态图标）与工作区那枚状态图标同列（32px）；
         * ② 标题与工作区名称同列（32 + 16 + 6 = 54px），不会因为当前有没有图标而左右跳。
         *
         * 漏掉这 32px 的症状：会话行整行贴到最左、比工作区名称左 26px，**层级看着是平的** ——
         * 完全读不出「这条会话属于上面那个工作区」。（`b238062` 给工作区行加状态图标槽时
         * 就是这么漏的：名称从 32px 被推到 54px，会话行没跟着补。）
         *
         * ⚠️ **别照抄 fishwork**：它的工作区行是 [图标][名称][箭头]（箭头在名称**右边**），
         * 两边都从 28px 起、天然对齐，所以那边**没有**这层缩进。dogi 把箭头挪到了左边，
         * 是刻意的分叉 —— 抄它的 `px-1.5` 会把缩进又弄丢。
         *
         * relative：行尾「重命名 / 删除」要绝对定位在行右侧
         */
        'group relative flex cursor-pointer items-center gap-1.5 rounded-md pr-1.5 pl-8 py-1.5 text-sm transition-colors',
        isActive
          ? 'bg-primary/15 text-foreground'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
      )}
      title={title}
      /* 名字被行尾浮层挤到截断时，hover 让它自己滑到行尾（见 shared/lib/hover-reveal.ts）：
         移开即复位。归档确认态也在这里一起反悔 —— 确认按钮本来就是 hover 浮层的一部分 */
      onMouseEnter={(e) => revealTruncatedName(e.currentTarget)}
      onMouseLeave={(e) => {
        resetTruncatedName(e.currentTarget)
        setConfirmingArchive(false)
      }}
    >
      {/*
        行首图标槽：**始终占位**（16px）—— 优先级与 fishwork 一致：
        **等你回答 / 确认 > 运行中 > 已归档 > ACP > 内置**。

        占位而不是「有图标才渲染」是为了两列对齐：
        槽左边 = 行的 pl-8（32px）、宽度 size-4，于是
          ① 运行中的转圈 / 等待图标与工作区那一行的**状态图标**同列
            （工作区那枚「文件夹 / 运行中」图标在展开箭头右边一格）；
          ② 标题从 32 + 16 + gap-1.5 = 54px 起，
            与工作区**名称同列**，也不会因为当前有没有图标而左右跳。

        停下来时这个槽显示**形态图标**：会话列表里内置 Mastra 会话与外部 ACP 会话混在一起，
        光看标题分不清点下去是谁在干活（ACP 的消息既不在本地、也不能签出 / 导出）。
        形态判定一律 `kind === 'acp'`，缺省 / 旧存档落进 else 分支即内置。
      */}
      <span
        className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
        title={
          status === 'ask'
            ? '等待你回答提问'
            : status === 'confirm'
              ? '等待你确认操作'
              : status === 'running'
                ? '正在运行'
                : meta.archived
                  ? '已归档会话'
                  : isAcp
                    ? '外部 ACP Agent 管理的会话'
                    : '内置 Agent 的会话'
        }
      >
        {status === 'ask' || status === 'confirm' ? (
          // 暂停（不是转圈）：这一轮已经停下来了，等的是你 —— 两个竖条比问号
          // 更贴「暂停中」，也顺手把审批卡（原来没有任何提示）覆盖了
          <CirclePause className="size-4 text-amber-500" />
        ) : status === 'running' ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : meta.archived ? (
          // 归档的会话在「已归档」分组里，行首也换一枚图标，扫一眼就知道这行是折起来的
          <Archive className="size-4" />
        ) : isAcp ? (
          <Bot className="size-4" />
        ) : (
          <MessageSquare className="size-4" />
        )}
      </span>
      {/* hover 时才把右侧让给「归档 / 重命名 / 更多」浮层（pe-* 按按钮个数取）。
          三种会话行都是三格（删除收进「更多」，不再单独占一格）。
          `data-name-text`：被挤成省略号时由 hover-reveal 滑到行尾（见行上的 onMouseEnter） */}
      <span data-name-text className={SIDEBAR_ROW_NAME.three}>
        {title}
      </span>
      <SidebarRowActions
        hoverClass="group-hover:pointer-events-auto group-hover:opacity-100 max-md:pointer-events-auto max-md:opacity-100"
      >
        <button
          type="button"
          title={
            meta.archived
              ? '恢复会话'
              : confirmingArchive
                ? `再点一次确认归档「${title}」`
                : '归档会话'
          }
          aria-label={
            meta.archived ? `恢复会话 ${title}` : confirmingArchive ? '确认归档' : `归档会话 ${title}`
          }
          onClick={(e) => {
            e.stopPropagation()
            // 归档走「点两次就地确认」：第一次点变成确认图标（勾），再点才真归档
            //（鼠标移开该行即反悔，见行上的 onMouseLeave）。恢复可逆，保持一键直达。
            if (meta.archived || confirmingArchive) {
              setConfirmingArchive(false)
              onToggleArchive(meta)
            } else {
              setConfirmingArchive(true)
            }
          }}
          className={cn(
            SIDEBAR_ROW_ACTION,
            confirmingArchive && 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
          )}
        >
          {meta.archived ? (
            <ArchiveRestore className="size-3.5" />
          ) : confirmingArchive ? (
            <Check className="size-3.5" />
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
        {/* 「更多」：低频动作（导出）+ 删除收在这里，行尾才不至于排满图标。
            ⚠️ 必须 stopPropagation —— 这一行整体可点（打开会话），
            不拦的话点菜单会顺手把会话也打开。 */}
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: moreItems,
            onClick: ({ key, domEvent }) => {
              domEvent.stopPropagation()
              if (key === 'export') onExport(meta)
              else if (key === 'delete') onDelete(meta)
            }
          }}
        >
          <button
            type="button"
            title="更多操作"
            aria-label={`更多操作 ${title}`}
            onClick={(e) => e.stopPropagation()}
            className={SIDEBAR_ROW_ACTION}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </Dropdown>
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
 * 工作区行可展开/收起，展开后列出该工作区的会话：点击即切换，
 * 行尾可归档 / 重命名，低频动作（导出、删除）收在「更多」菜单里。
 * 「从此签出」不在这一层 —— 它是对**某条消息**的动作，入口在对话流里。
 *
 * 布局与交互对齐「主机 / 脚本」侧边栏，但这里只有两层、不需要拖拽排序。
 */
export function AgentPanel() {
  const workspaces = useAppStore((s) => s.agentWorkspaces)
  /** 已登记的 ACP agent（「新建会话」时要选内置还是某个具体的 agent） */
  const acpAgents = useAppStore((s) => s.aiSettings.acpAgents ?? EMPTY_ACP_AGENTS)
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
  const exportAgentConversation = useAppStore((s) => s.exportAgentConversation)
  const importAgentConversation = useAppStore((s) => s.importAgentConversation)
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
  /** 「从 Git 克隆新工作区」弹窗 */
  const [cloning, setCloning] = useState(false)
  const [picking, setPicking] = useState(false)
  /** AI 用量统计抽屉（跨会话的 token 汇总） */
  const [usageOpen, setUsageOpen] = useState(false)

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
      // 草稿（还没发出首条消息）不进列表 —— 判据是显式标记，不是「有没有 kind」
      if (c.draft) continue
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
  /** 导出成 JSON 文件：从主进程读真源（渲染端这份可能正处在流式中途） */
  const exportConversation = useCallback(
    async (meta: ConversationListMeta) => {
      const result = await exportAgentConversation(meta.id)
      // 用户自己按的取消不算失败 —— 弹红字会让人以为哪里坏了
      if (result.canceled) return
      if (!result.ok) message.error(`导出失败：${result.reason ?? '未知原因'}`)
      else message.success(`已导出到 ${result.path}`)
    },
    [exportAgentConversation]
  )
  /** 从文件导入一条会话到某个工作区（导入即落盘，成功后自动选中） */
  const importConversationFile = useCallback(
    async (workspaceId: string) => {
      const result = await importAgentConversation(workspaceId)
      if (result.canceled) return
      if (!result.ok) message.error(`导入失败：${result.reason ?? '未知原因'}`)
      else message.success(`已导入会话「${result.conversation?.title ?? ''}」`)
    },
    [importAgentConversation]
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
   * 「新建会话」的形态选择：**内置 Agent** 或某个已登记的 **ACP agent**。
   *
   * 形态在创建时就定下来（不再由首条消息时选中的模型推断），所以这一步是显式的。
   * ACP 那一组按 agent 逐个列；一个都没登记时给一条指向设置的禁用提示（不给死路）。
   */
  const newConversationItems = (): MenuProps['items'] => [
    { key: 'mastra', label: '内置 Agent', icon: <Sparkles className="size-3.5" /> },
    ...(acpAgents.length > 0
      ? [
        { type: 'divider' as const },
        ...acpAgents.map((a) => ({
          key: `acp:${a.id}`,
          label: `ACP · ${a.name}`,
          icon: <Bot className="size-3.5" />
        }))
      ]
      : [
        {
          key: 'acp-hint',
          label: 'ACP Agent：先到「设置 → ACP agent」登记一个',
          disabled: true
        }
      ])
  ]

  /**
   * 工作区行的操作菜单。
   *
   * 「新建会话」**不在**这里 —— 它是本工作区最高频的动作，每次都要展开「更多」才碰得到，
   * 所以提到行尾常驻（见下面的悬浮操作区）。这里只留低频项：
   * 导入会话 / 重命名 / 删除（原先连重命名、删除也是平铺按钮，行一窄就把工作区名挤没了）。
   */
  const workspaceMenuItems = (): MenuProps['items'] => [
    // 两个「导入」是不同的东西，标签里必须写清：
    // - ACP 会话：从**外部 agent** 那边拉它自己的会话列表（session/list）回来绑定；
    // - 会话文件：读一份导出的 JSON（可以是从别的机器带过来的）。
    { key: 'import', label: '导入 ACP 会话…', icon: <Import className="size-3.5" /> },
    { key: 'importFile', label: '导入会话文件…', icon: <FileDown className="size-3.5" /> },
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
      else if (key === 'importFile') void importConversationFile(w.id)
      else if (key === 'rename') setEdit({ id: w.id, name: w.name, path: w.path })
      else if (key === 'delete') setPendingDelete(w)
    }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center justify-between gap-1 px-3 py-1">
        <span className="text-sm font-medium text-muted-foreground">
          工作区 ({workspaces.length})
        </span>
        {/* 右侧按钮组必须**收进一个子容器**：外层是 justify-between，三个直接子元素时
            中间那个会被摆到正中间 —— 用量按钮就因此浮在标题和加号之间（像孤儿）。
            包一层之后左侧只剩标题、右侧只剩按钮组，两边各归各位。 */}
        <div className="flex shrink-0 items-center gap-0.5">
          {/* 用量统计（跨会话）：放在工作区列表头上 —— 统计的数据源就是这些会话，
              从这里打开上下文是连贯的（看一眼总量 → 想看看哪条会话烧的 → 点进去）。
              与「新建工作区」加号同侧成组，都是这颗头上的全局动作 */}
          <Tooltip title="AI 用量统计">
            <Button
              type="text"
              size="small"
              className="px-0.5 text-muted-foreground"
              icon={<BarChart3 className="size-3.5" />}
              onClick={() => setUsageOpen(true)}
            />
          </Tooltip>
          {/* 新建工作区有两条路：选一个已有目录 / 从 Git 克隆一个出来（克隆完自动建好工作区） */}
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'pick', label: '选择已有目录…', icon: <Folder className="size-3.5" /> },
                { key: 'clone', label: '从 Git 克隆…', icon: <GitBranch className="size-3.5" /> }
              ],
              onClick: ({ key }) => {
                if (key === 'pick') setEdit({ name: '', path: '' })
                else setCloning(true)
              }
            }}
          >
            <Button
              type="text"
              size="small"
              className="px-0.5 text-muted-foreground"
              title="新建工作区"
              icon={<Plus className="size-3.5" />}
            />
          </Dropdown>
        </div>
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
              /**
               * 这个工作区的目录不在了（主进程巡检置位，见 `AgentWorkspace.dirMissing`）。
               *
               * 只影响**往这个目录里放东西**的动作（新建会话）：打开它已有的会话不拦 ——
               * 历史消息、diff、产物都还在本地，照样能看。
               *
               * ⚠️ 标记由主进程 30s 一轮的巡检给出，**可能慢半拍**（目录刚被删的那几秒里
               * 侧栏还是正常样子）。所以这里只是「体验层」的提示与禁用，**真拦在主进程**
               * （`chatWorkspace` / `acpAgentService.chat` 跑一轮之前会自己再 stat 一次）。
               */
              const wsMissing = !!w.dirMissing
              const missingHint = `工作区目录不存在：${w.path}（可能已被删除或移动）`
              /**
               * 行尾那枚「新建会话」按钮。**两种包装**（目录正常时包一层形态下拉、异常时裸按钮）
               * 共用这一个元素 —— 所以抽出来，别在 JSX 里写两遍（改文案时容易只改一处）。
               *
               * 目录不在了时**不包 Dropdown**：包着的话点下去照样弹出形态菜单，选了形态才失败，
               * 那还不如当场给一句人话。
               *
               * ⚠️ 用 `aria-disabled` 而不是 `disabled`：真 disabled 的按钮不派发指针事件，
               * hover 提示和「为什么点不动」就都看不到了（与会话行的删除按钮同一套取舍）。
               */
              const newConvButton = (
                <button
                  type="button"
                  title={wsMissing ? missingHint : `在 ${w.name} 中新建会话`}
                  aria-label={`在 ${w.name} 中新建会话`}
                  aria-disabled={wsMissing}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (wsMissing) message.error(missingHint)
                  }}
                  className={cn(rowAction, wsMissing && 'cursor-not-allowed text-muted-foreground/50')}
                >
                  <MessageSquarePlus className="size-3.5" />
                </button>
              )
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
                    title={wsMissing ? missingHint : w.path}
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

                      目录不在了时**保留图标形状**、只把颜色换成危险色 —— 而不是换个警告三角：
                      用户扫一眼就能对上是哪一个工作区（形状没变），只是它现在是红的。
                      排在「运行中 / 等待」之后：那两个是**瞬时活动态**，比「目录没了」更该抢眼
                      （正跑着的任务卡在等确认，才是此刻最要紧的事）。
                    */}
                    <span
                      className="flex size-4 shrink-0 items-center justify-center"
                      title={
                        wsStatus === 'running'
                          ? '有会话正在运行'
                          : wsStatus
                            ? '有会话在等你回答 / 确认'
                            : wsMissing
                              ? missingHint
                              : undefined
                      }
                    >
                      {wsStatus === 'running' ? (
                        <Loader2 className="size-4 animate-spin text-primary" />
                      ) : wsStatus ? (
                        <CirclePause className="size-4 text-amber-500" />
                      ) : wsMissing ? (
                        <Folder className="size-4 text-destructive" />
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
                      {/*
                        「新建会话」要先定形态（内置 / 某个 ACP agent），所以平时是个下拉而不是直点；
                        目录不在了就只渲染裸按钮（见上面 newConvButton 的注释）。
                      */}
                      {wsMissing ? (
                        newConvButton
                      ) : (
                        <Dropdown
                          trigger={['click']}
                          placement="bottomRight"
                          menu={{
                            items: newConversationItems(),
                            onClick: ({ key, domEvent }) => {
                              domEvent.stopPropagation()
                              const [backend, agentId] = String(key).split(':')
                              createAgentConversation(
                                w.id,
                                backend === 'acp' ? 'acp' : 'mastra',
                                agentId || undefined
                              )
                              if (!isExpanded) toggleExpand(w.id)
                            }
                          }}
                        >
                          {newConvButton}
                        </Dropdown>
                      )}
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
                      {/* 一条未归档会话都没有时才提示（下方可能还有「已归档」分组）。
                          缩进到会话**标题**那一列（54px = 32 + 16 + 6），与上面的会话行对齐 */}
                      {list.length === 0 && archivedList.length === 0 && (
                        <div className="py-1.5 pl-[54px] text-xs text-muted-foreground/60">
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
                          onExport={exportConversation}
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
                            // 缩进到会话**状态图标**那一列（32px = pl-8）：这枚折叠箭头
                            // 是这一组的把手，跟会话行的图标同列才读得出「它是这批会话的分组头」
                            className="flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pl-8 pr-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
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
                                  onExport={exportConversation}
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

      {cloning && <GitCloneDialog open onClose={() => setCloning(false)} />}

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

      {/* AI 用量统计：点某条会话直接跳过去（先切工作区再选会话，否则会话在别的
          工作区下会「选中了但侧边栏没展开」） */}
      <AgentUsageDrawer
        open={usageOpen}
        onClose={() => setUsageOpen(false)}
        onOpenConversation={(id, workspaceId) => {
          setUsageOpen(false)
          if (workspaceId) selectAgentWorkspace(workspaceId)
          selectAgentConversation(id)
        }}
      />
    </div>
  )
}
