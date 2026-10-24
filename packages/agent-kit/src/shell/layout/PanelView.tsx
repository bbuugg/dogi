"use client";

/**
 * 主区域的多标签面板：**可拖拽 / 分离 / 分组**（类 VS Code 的编辑器区）。
 *
 * ## 状态从哪来
 *
 * 布局与分组状态全在 `panel-store.ts`（模块级 + `useSyncExternalStore`），本文件只**读**
 * 它、把用户手势翻译成 store 的调用。组件里**不手改布局树** —— 所有结构变更都走
 * `lib/panel-groups.ts` 的纯函数（它们自带 `verifyLayout` 自检）。
 *
 * ## 三个概念的分工（这是与参考实现最本质的区别）
 *
 * - `layout`（`lib/pane-layout.ts`）：**纯几何**。一棵 N 叉树，叶子只记 `groupId`，
 *   分隔节点按 `sizes` 权重排布子节点。它回答「哪一块在哪、多大」，**不回答**「哪一块里有谁」。
 * - `groups`（`lib/panel-groups.ts`）：**内容归属**。`Record<groupId, {tabIds, activeTabId}>`。
 * - 标签集合 = 各 `groups` 里 `tabIds` 的并集。**没有第二份「打开的标签列表」**。
 *
 * 参考实现（dogi）把这三样拆成 `panelTabs[]` + `groups{}` + `layout` 三份数据，每次拖拽
 * 都要在三处各改一遍，于是逼出一堆记账（`leafId` 命中判定、`splitOff` 单列入口、`verify`
 * 安全网、`registerCloseHost` 确认总线）。这里只有一份状态，纯函数负责不变量。
 *
 * ## 拖拽落区（照搬 dogi 的模型，见 `lib/dnd-context.ts`）
 *
 * - **标签条上**：按指针在目标标签上的水平相对位置分三档 —— 两侧各 25% = 插到它前 / 后，
 *   中间 50% = 并入它所属的组。
 * - **组车身**：按指针在整组矩形里的相对位置分五档 —— 四边各 1/4 = 向那一侧分屏，
 *   中间 = 并入该组。
 *
 * ## 标签有两种（key 自带类型）
 *
 * - **对话标签**：key 就是会话 id（显式打开的新对话是 `__new__`），内容 `ConversationTab`；
 *   一个标签都没有时由 `PanelView` 补一张 `__new__` 草稿（落在「开始新对话」页）；
 * - **工具标签**：`host:<hostId>` 连某台 SSH 主机、`local:<n>` 一条本机终端。
 *   它们不对应任何会话 —— 点 / 关 / 拖它们都**不该**动 `activeConversationId`。
 *
 * 判定全在 `panel-tabs.ts`（纯函数）。之所以用「带前缀的 key」而不是给标签加 type 字段：
 * `panel-store` / `panel-groups` 那套状态机只认一个字符串，key 自带类型 = 状态机一行不改，
 * 类型只在渲染层解析一次。
 *
 * ## 内容一律常挂载
 *
 * 非活动标签用 `hidden` 藏起来而**不卸载** —— 终端的 xterm 实例 / scrollback、文件树的
 * 展开状态、编辑器里未保存的内容都只在组件内存里，卸载即灭（`TerminalPanel` 的 cleanup
 * 还会 kill 掉那条 PTY）。这与 `SidePanel` 是同一条约束。
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { useDrag, useDragLayer, useDrop } from 'react-dnd'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Cable,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  MessageSquare,
  MessageSquarePlus,
  Network,
  NotebookPen,
  Pencil,
  CalendarClock,
  Puzzle,
  RefreshCw,
  Rows2,
  ScrollText,
  Server,
  Split,
  SquareTerminal,
  X
} from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@fizz/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@fizz/ui/context-menu'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { t } from '@fizz/i18n'
import { useLanguage } from '@fizz/agent-kit/shared/lib/language'
import { conversationTitle } from '@fizz/agent-kit/shared/lib/conversation-title'
import { useDragResize } from '@fizz/agent-kit/shared/components/ResizeHandle'
import { PanelTab } from '@fizz/agent-kit/shared/components/PanelTab'
import { RowActionButton } from '@fizz/agent-kit/shared/components/RowAction'
import { useAppContext } from '@fizz/agent-kit/shared/hooks/use-app-context'
import { findShortcutByEvent, isShortcutRecording, useShortcuts } from '@fizz/agent-kit/shared/lib/shortcuts'
import { ConversationTab } from '@fizz/agent-kit/features/chat/ConversationTab'
import { ContainerTabGate } from '@fizz/agent-kit/features/projects/ContainerStartupView'
import { TerminalPanel } from '@fizz/agent-kit/features/terminal/TerminalPanel'
import { TerminalTabView } from '@fizz/agent-kit/features/terminal/TerminalTabView'
import { ApiPage } from '@fizz/agent-kit/features/api/ApiPage'
import { WsPage } from '@fizz/agent-kit/features/api/WsPage'
import { ScriptsPanel } from '@fizz/agent-kit/features/scripts/ScriptsPanel'
import { SftpPanel } from '@fizz/agent-kit/features/sftp/SftpPanel'
import { TunnelPanel } from '@fizz/agent-kit/features/tunnels/TunnelPanel'
import { LogsPanel } from '@fizz/agent-kit/features/logs/LogsPanel'
import { TriggersPanel } from '@fizz/agent-kit/features/tasks/TriggersPanel'
import { LocalFileTabContent } from '@fizz/agent-kit/features/local-file/LocalFileTabContent'
import { NoteTabContent } from '@fizz/agent-kit/features/notes/NoteTabContent'
import { PluginTabContent } from '@fizz/agent-kit/features/plugins/PluginTabContent'
import { usePluginSurfaces } from '@fizz/agent-kit/shared/lib/plugin-surfaces'
import { NEW_API_REQUEST_ID, NEW_WS_REQUEST_ID } from '@fizz/agent-kit/features/api/api-client'
import {
  apiRequestIdOfTabKey,
  hostIdOfTabKey,
  isApiTabKey,
  isConversationTabKey,
  isHostTabKey,
  isLocalTabKey,
  isLocalFileTabKey,
  isLogsTabKey,
  isNoteTabKey,
  isPluginTabKey,
  isScriptsTabKey,
  isSftpTabKey,
  isTriggersTabKey,
  isTunnelTabKey,
  NEW_TAB_KEY,
  sftpHostIdOfTabKey
} from '@fizz/agent-kit/shared/lib/panel-tabs'
import {
  getToolTab,
  getToolTabsVersion,
  pruneToolTabs,
  renameToolTab,
  subscribeToolTabs
} from '@fizz/agent-kit/shared/lib/tool-tabs'
import {
  pruneTabReloads,
  requestReloadTab,
  subscribeTabReloads,
  tabReloadsVersion,
  tabReloadGen
} from './tab-reload'
import {
  panelBodies,
  panelBodiesVersion,
  registerPanelBody,
  subscribePanelBodies
} from './panel-bodies'
import {
  groupZoneOf,
  horizontalRatio,
  PANEL_TAB_TYPE,
  useDndRef,
  zoneOf,
  type GroupDropZone,
  type PanelTabDragItem,
  type TabDropZone
} from '@fizz/agent-kit/shared/lib/dnd-context'
import { collectGroupIds, type PaneNode, type PaneSplit } from '@fizz/agent-kit/shared/lib/pane-layout'
import type { PanelState } from '@fizz/agent-kit/shared/lib/panel-groups'
import type { SshHostConfig } from '@fizz/contracts/types'
import {
  activateTab,
  activeTabKey,
  allTabKeys,
  closeTabs,
  ensureTab,
  getPanelState,
  moveGroup,
  moveTab,
  openTab,
  reorderTab,
  requestCloseGroup,
  requestCloseTabs,
  resizeSplit,
  setActiveGroup,
  splitTab,
  syncTabs,
  tabOwners,
  usePanelState
} from '@fizz/agent-kit/shared/lib/panel-store'

/**
 * 显式打开「新对话 / 初始页」时使用的标签 key。零标签时直接显示空态，不自动打开它。
 * 定义在 `panel-tabs.ts`，这里保留现有的导出。
 */
export { NEW_TAB_KEY }

/** 标签条高度（与 `SidePanel` 的标签条一致，两处看起来才是同一套控件） */
const STRIP_H = 'h-9'

/** 某标签在某组内的下标（找不到给 0）—— 把「插到目标前 / 后」翻译成下标用 */
function tabIndexIn(groupId: string, tabKey: string): number {
  const g = getPanelState().groups[groupId]
  const i = g ? g.tabIds.indexOf(tabKey) : -1
  return i < 0 ? 0 : i
}

/** 一个标签在标签条上的展示信息 */
interface TabMeta {
  /** 标签条上的短名 */
  label: string
  /** 悬停提示（更完整的描述） */
  title: string
  /** 类型图标：一列标签里混着「对话 / 主机 / 终端」三种东西，光看名字分不出来 */
  icon: ReactNode
}

/**
 * 标签的展示信息。
 *
 * 按 key 的类型分别取源：
 * - 对话标签 → 会话列表里的标题（会话被重命名 / 首条消息自动定标题都跟着走）；
 * - 主机标签 → **优先**读主机清单（改名能实时反映），清单里没有了（主机被删）就退回
 *   打开时记在登记表里的快照 —— 标签不会突然变成一串 uuid；
 * - 本机终端 → 登记表里的快照（`终端 N` / 目录）。
 */
function useTabMeta(): (key: string) => TabMeta {
  const language = useLanguage()
  const { app } = useAppContext()
  /** 插件界面清单：标签条上要显示插件声明的图标与名字（数据来自服务端，不在前端算） */
  const pluginSurfaces = usePluginSurfaces(app, app.activeWorkspaceId ?? undefined)
  // 笔记标签的名字**会变**：重命名后 `retargetNoteTab` 就地改登记表（key 是不透明的
  // `note:<n>`，名字只在表里），而登记表自己不发通知。不订阅这个版本号，标签条会一直
  // 停在旧文件名上，直到下一次由别的原因触发的重渲染 —— 用户看到的是「重命名没生效」。
  useSyncExternalStore(subscribeToolTabs, getToolTabsVersion, getToolTabsVersion)
  const baseMeta = useCallback(
    (key: string): TabMeta => {
      if (key === NEW_TAB_KEY) {
        return {
          label: t('新对话'),
          title: t('新对话（初始页）'),
          icon: <MessageSquarePlus className="size-3.5 shrink-0" />
        }
      }
      if (isHostTabKey(key)) {
        const hostId = hostIdOfTabKey(key)
        // 主机标签只由 SSH 主机开出来（本机终端走 `local:` 标签），按 kind 收窄
        const host = app.sshHosts.find(
          (h): h is SshHostConfig => h.kind !== 'local' && h.id === hostId
        )
        const snapshot = getToolTab(key)
        return {
          label: host?.name ?? snapshot?.label ?? t('主机'),
          title: host
            ? `SSH · ${host.username}@${host.host}:${host.port}`
            : (snapshot?.title ?? t('主机已从清单里删除')),
          icon: <Server className="size-3.5 shrink-0" />
        }
      }
      if (isSftpTabKey(key)) {
        // SFTP 标签：标签名与主机名同步（改名后已开的标签也跟着变），图标与主机区分开
        const hostId = sftpHostIdOfTabKey(key)
        const host = app.sshHosts.find(
          (h): h is SshHostConfig => h.kind !== 'local' && h.id === hostId
        )
        const snapshot = getToolTab(key)
        return {
          label: host ? `${host.name} ${t('文件')}` : (snapshot?.label ?? t('文件')),
          title: host
            ? `SFTP · ${host.username}@${host.host}:${host.port}`
            : (snapshot?.title ?? t('主机已从清单里删除')),
          icon: <FolderOpen className="size-3.5 shrink-0" />
        }
      }
      if (isLocalTabKey(key)) {
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? '终端',
          title: tool?.title ?? '本机终端',
          icon: <SquareTerminal className="size-3.5 shrink-0" />
        }
      }
      if (isTunnelTabKey(key)) {
        // 隧道面板是全局单例，标签名固定；悬停提示带上「绑在服务端那台机器上」的提醒
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('隧道'),
          title: tool?.title ?? t('SSH 隧道'),
          icon: <Network className="size-3.5 shrink-0" />
        }
      }
      if (isLogsTabKey(key)) {
        // 应用日志面板同样是全局单例（`logs:list`），内部用 Tab 切命名空间
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('日志'),
          title: tool?.title ?? t('应用日志'),
          icon: <ScrollText className="size-3.5 shrink-0" />
        }
      }
      if (isTriggersTabKey(key)) {
        // 定时任务面板也是全局单例（`triggers:list`），名字固定
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('定时任务'),
          title: tool?.title ?? t('定时任务'),
          icon: <CalendarClock className="size-3.5 shrink-0" />
        }
      }
      if (isScriptsTabKey(key)) {
        // 脚本管理面板同样是全局单例（`scripts:list`），名字固定。
        // 单个脚本的新建 / 编辑是模态框（`ScriptEditDialog`），不占标签。
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? t('脚本'),
          title: tool?.title ?? t('脚本'),
          icon: <FileCode2 className="size-3.5 shrink-0" />
        }
      }
      if (isNoteTabKey(key)) {
        // 笔记标签：名字与归属都在登记表里（key 是不透明的 `note:<n>`），重命名后就地改
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? '笔记',
          title: tool?.notePath ?? tool?.title ?? '笔记',
          icon: <NotebookPen className="size-3.5 shrink-0" />
        }
      }
      if (isLocalFileTabKey(key)) {
        // 本地文件标签：归属（绝对路径）同样只在登记表里，key 是不透明的 `file:<n>`
        const tool = getToolTab(key)
        return {
          label: tool?.label ?? 'Markdown',
          // 悬停给完整绝对路径 —— 一堆 README.md 时只看文件名分不清是哪一个
          title: tool?.externalPath ?? tool?.title ?? 'Markdown',
          icon: <FileText className="size-3.5 shrink-0" />
        }
      }
      if (isApiTabKey(key)) {
        const requestId = apiRequestIdOfTabKey(key)
        // WebSocket 草稿（哨兵）与已保存的 `protocol === 'ws'` 条目走另一套图标 / 提示
        if (requestId === NEW_WS_REQUEST_ID) {
          return {
            label: '新建连接',
            title: '新建 WebSocket 连接（未保存）',
            icon: <Cable className="size-3.5 shrink-0" />
          }
        }
        const request = app.apiRequests.find((r) => r.id === requestId)
        if (request?.protocol === 'ws') {
          return {
            label: request.name.trim() || request.url.trim() || 'WebSocket',
            title: `WS ${request.url || '（未填写地址）'}`,
            icon: <Cable className="size-3.5 shrink-0" />
          }
        }
        return {
          label: request?.name.trim() || request?.url.trim() || (requestId === NEW_API_REQUEST_ID ? '新请求' : '接口请求'),
          title: request
            ? `${request.method || 'GET'} ${request.url || '（未填写地址）'}`
            : '新建接口请求（未保存）',
          icon: <Globe className="size-3.5 shrink-0" />
        }
      }
      if (isPluginTabKey(key)) {
        const tool = getToolTab(key)
        // 图标优先用插件声明的那个（data URI 只能塞进 <img>，绝不拼进 DOM）
        const surface = pluginSurfaces.find(
          (s) => s.pluginId === tool?.pluginId && s.id === tool?.surfaceId
        )
        return {
          label: tool?.label || '插件',
          title: tool?.title || '插件界面',
          icon: surface?.icon ? (
            <img
              src={surface.icon}
              alt=""
              aria-hidden
              className="size-3.5 shrink-0 object-contain"
            />
          ) : (
            <Puzzle className="size-3.5 shrink-0" />
          )
        }
      }
      const conversation = app.conversations.find((c) => c.id === key)
      return {
        // 默认标题（`新会话`）按当前语言显示，用户起过的名字原样
        label: conversationTitle(conversation?.title) || t('对话'),
        title: conversationTitle(conversation?.title) || key,
        icon: <MessageSquare className="size-3.5 shrink-0" />
      }
    },
    [app.conversations, app.sshHosts, app.apiRequests, app.scripts, pluginSurfaces, language]
  )

  /**
   * 别名盖在**数据源算出来的名字**之上。
   *
   * 上面那份 `baseMeta` 全部按「数据源现在叫什么」算（主机清单 / 接口清单 / 脚本名 /
   * 会话标题），而用户就地改的名字只存在登记表的 `alias` 里（见 `renameToolTab`）——
   * 放在这里盖一层，就不用给那十几个分支各加一次 `alias ??`。
   *
   * ⚠️ 只盖 `label`，不动 `title`：悬停提示要继续说清「这是哪台主机 / 哪个请求」。
   */
  return useCallback(
    (key: string): TabMeta => {
      const meta = baseMeta(key)
      const alias = getToolTab(key)?.alias
      return alias ? { ...meta, label: alias } : meta
    },
    [baseMeta]
  )
}

// ---------------------------------------------------------------------------
// 分隔条
// ---------------------------------------------------------------------------

/**
 * 拖动分隔条改权重。
 *
 * ⚠️ `sizes` 会被**直接当 `flex-grow` 用**，所以总和必须保持 1（`pane-layout.ts` 的
 * `normalizeSizes` 负责兜住）：flexbox 在「flex-grow 之和 < 1」时只分配
 * 「剩余空间 × 总和」，会空出一截、露出容器底色。这里的增量按当前总和换算，
 * 写回时再由 `resizeSplit` → `normalizeSizes` 归一到 1。
 */
function Splitter({
  split,
  index,
  containerRef
}: {
  split: PaneSplit
  /** 边界位于 `children[index]` 与 `children[index + 1]` 之间 */
  index: number
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const horizontal = split.direction === 'row'

  /** 指针管线走 `useDragResize`（`touch-action` + 幂等收尾，见该 hook 的文件头） */
  const onPointerDown = useDragResize<{
    total: number
    totalWeight: number
    startSizes: number[]
    minWeight: number
  }>({
    axis: horizontal ? 'x' : 'y',
    onStart: () => {
      const container = containerRef.current
      if (!container) return null
      const rect = container.getBoundingClientRect()
      const total = horizontal ? rect.width : rect.height
      if (total <= 0) return null
      const totalWeight = split.sizes.reduce((a, b) => a + b, 0) || 1
      return {
        total,
        totalWeight,
        startSizes: [...split.sizes],
        /** 每一侧最少留 6% —— 别让用户把某一格拖到看不见（看不见就再也拖不回来） */
        minWeight: totalWeight * 0.06
      }
    },
    onMove: (delta, drag) => {
      const deltaWeight = (delta / drag.total) * drag.totalWeight
      const a = drag.startSizes[index] + deltaWeight
      const b = drag.startSizes[index + 1] - deltaWeight
      if (a < drag.minWeight || b < drag.minWeight) return
      const next = [...drag.startSizes]
      next[index] = a
      next[index + 1] = b
      resizeSplit(split.id, next)
    }
  })

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      className={cn(
        /*
         * 命中热区 8px（窄屏 16px），但用 -mx-* / -my-* 的负 margin 把**占位抵成 0** —— 两侧面板
         * 直接相邻，缝里只剩下面那一条 1px 的线（与 dogi 的 ViewPanel 同一套做法）。
         *
         * ⚠️ 负 margin 不能省：以前这里是裸的 `w-1`，那 4px 是**实打实占位**的。未激活组用
         * `bg-background/60`，容器底色从这 4px 里透出来，看起来就是「一道缝 + 一条线」。
         *
         * ⚠️ `touch-none` 也不能省：少了它手机上手指一动就被浏览器当成滚动手势抢走
         * （`pointercancel`），表现是「一次只能拖一点点」。
         */
        'group/split relative z-10 shrink-0 touch-none select-none [-webkit-touch-callout:none]',
        horizontal
          ? '-mx-2 w-4 cursor-col-resize sm:-mx-1 sm:w-2'
          : '-my-2 h-4 cursor-row-resize sm:-my-1 sm:h-2'
      )}
    >
      <div
        className={cn(
          'absolute bg-border transition-colors group-hover/split:bg-primary/60',
          horizontal
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
        )}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 标签条上的一个标签
// ---------------------------------------------------------------------------

function PanelTabItem({
  tabKey,
  groupId,
  groupTabIds,
  index,
  active,
  meta,
  canCloseGroup,
  onActivate,
  onClose,
  onCloseGroup,
  onRename,
  onReload
}: {
  tabKey: string
  groupId: string
  /** 本组的标签 key（顺序即标签条顺序）—— 右键的「关闭左侧 / 右侧 / 其他」按它算范围 */
  groupTabIds: string[]
  /** 本标签在组内的下标 */
  index: number
  active: boolean
  meta: TabMeta
  /**
   * 是否**多个分组**（由 `PanelGroupView` 按布局树的叶子数给出）。
   * 单组时「关闭整组」没有意义（关完只是留一个空组占位），所以右键里也不显示它。
   */
  canCloseGroup: boolean
  /** 点标签：切到它，并把「当前会话」同步过去（焦点标签 ≡ 当前会话；工具标签除外） */
  onActivate: (key: string) => void
  /** 关闭一批标签（一个 = 关自己，多个 = 右键的批量关闭） */
  onClose: (keys: string[]) => void
  /** 关闭本组全部标签（右键的「关闭整个组」）—— 也要同步「当前会话」，见 `closeGroupAndSync` */
  onCloseGroup: (groupId: string) => void
  /** 标签改名：对话标签改会话标题，工具标签只改显示名（两条路的语义见 `renameTab`） */
  onRename: (key: string, title: string) => void
  /** 刷新这个标签（对话标签 = 重新加载会话；工具标签 = 卸载重挂），见 `reloadTab` */
  onReload: (key: string) => void
}) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const [zone, setZone] = useState<TabDropZone | null>(null)
  /** 就地重命名：草稿跟着当前标题走，提交后交给 `onRename` */
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  /** 重命名输入框（菜单关完之后要靠它补一次焦点，见下面 `onCloseAutoFocus`） */
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const tabCount = groupTabIds.length
  /**
   * 除了「新对话」草稿标签（名字就是那个页面的语义，改了没意义），**所有标签都能改名**：
   * - **对话标签** → 改的是**会话标题**（落盘，侧栏同步）；
   * - **工具标签** → 只改主区域标签的**显示名**（内存里的一层别名，关掉重开恢复原名，
   *   不回写主机清单 / 接口清单，见 `renameToolTab`）。
   */
  const renamable = tabKey !== NEW_TAB_KEY

  /**
   * ⚠️ `useDrag` / `useDrop` **必须用「工厂函数 + deps 数组」形式**，不能直接传对象字面量。
   *
   * react-dnd 的 `useOptionalFactory(arg, deps)` 在 `deps == null` 且 `arg` 不是函数时，
   * 会把 **`arg` 对象本身**塞进 `useMemo` 的依赖里。传字面量 = 每次渲染都是新对象 =
   * `spec` 每次重算 → `handler` 每次重算 → `useRegisteredDragSource` 的
   * `useIsomorphicLayoutEffect(..., [manager, monitor, connector, handler, itemType])`
   * **每次渲染都重跑**：`unregister()` + `registerSource()` 换来一个新的 handlerId。
   * 拖拽中途任何一次重渲染（`isDragging` 翻转就会重渲染）都会让 handlerId 漂掉，
   * 于是拖拽目标再也匹配不上 —— 表现为「拖起来有 `dragstart`，但**永远不触发
   * `hover` / `canDrop` / `drop`**，落区高亮和分屏全都不出现」。
   *
   * 传工厂函数 + 显式 deps，spec 才在依赖不变时保持同一引用（与参考实现 dogi 同款写法）。
   */
  const [{ isDragging }, dragRef] = useDrag<PanelTabDragItem, void, { isDragging: boolean }>(
    () => ({
      type: PANEL_TAB_TYPE,
      item: { key: tabKey, fromGroupId: groupId },
      collect: (monitor) => ({ isDragging: monitor.isDragging() })
    }),
    [tabKey, groupId]
  )

  /** 把落区翻译成 store 调用（同组 = 重排、异组 = 移动）—— 逻辑内联进 spec，避免闭包过期 */
  const [{ isOver }, dropRef] = useDrop<PanelTabDragItem, void, { isOver: boolean }>(
    () => ({
      accept: PANEL_TAB_TYPE,
      drop: (item, monitor) => {
        // 落点已被更内层的目标处理过就别重复（标签条内部的标签互相之间会层层冒泡）
        if (monitor.didDrop()) return
        const target = zoneOf(horizontalRatio(monitor, elRef.current))
        setZone(null)
        if (item.key === tabKey) return
        if (target === 'inside') {
          // 并入本标签所在的组（追加到组尾），并切过去
          moveTab(item.key, groupId)
          activateTab(item.key)
          return
        }
        // 同组重排 / 跨组移动：目标下标 = 本标签下标（插到它前）或 +1（插到它后）
        const at = tabIndexIn(groupId, tabKey) + (target === 'after' ? 1 : 0)
        if (item.fromGroupId === groupId) reorderTab(groupId, item.key, at)
        else moveTab(item.key, groupId, at)
      },
      hover: (item, monitor) => {
        setZone(item.key === tabKey ? null : zoneOf(horizontalRatio(monitor, elRef.current)))
      },
      collect: (monitor) => ({ isOver: monitor.isOver() })
    }),
    [tabKey, groupId]
  )

  // 指针离开本标签时清掉落区高亮（`hover` 只在指针仍在本标签上时触发）
  useEffect(() => {
    if (!isOver) setZone(null)
  }, [isOver])

  // ⚠️ 必须 memo（见 `useDndRef` 的注释）：裸箭头函数每次渲染都是新 ref → 无限更新循环
  const setRef = useDndRef<HTMLDivElement>(dragRef, dropRef, (node) => {
    elRef.current = node
  })

  const startRename = (): void => {
    setDraft(meta.label)
    setRenaming(true)
  }

  const submitRename = (): void => {
    setRenaming(false)
    onRename(tabKey, draft.trim())
  }

  /** 右键「拆分」：把**本标签**拎到该方向的新组（组里只剩它一个时右键里根本没有这一项） */
  const split = (direction: 'up' | 'down' | 'left' | 'right'): void => {
    if (tabCount === 1) return
    splitTab(tabKey, groupId, direction)
  }

  /**
   * 「刷新」= 让**这一个标签的内容**重新加载。
   *
   * 两条路（由 `reloadTab` 按标签类型分派）：
   * - **对话标签** → 「重新加载这条会话」（等价于刷新页面后点开它：mastra 拉服务端权威
   *   历史、acp 走 `session/load` 回放）。刻意**不走卸载重挂** —— `ConversationTab` 重挂
   *   并不会重新拉消息（消息在 store 里），只会把右侧面板的终端 / 文件现场一起拆掉。
   * - **工具标签** → `requestReloadTab` 的卸载重挂（接口页重发请求、插件面重新 `render()`）。
   *
   * ⚠️ 两条路都要**先问标签自己的守卫**（`tab-close.ts` 的 `beforeReload`）：重挂是破坏性的
   * —— 终端里正在跑的进程会一起结束、接口页草稿会丢。
   */
  const reloadTab = (): void => {
    onReload(tabKey)
  }

  return (
    <ContextMenu>
      {/*
        ⚠️ 右键菜单挂在**标签本身**上（`asChild` 让 Radix 把 `onContextMenu` / `ref` 合并进来）。
        菜单内容 portal 到 body，所以不会被标签条的 `overflow-x-auto` 裁掉。
        参考实现（dogi）的标签右键菜单也是这一套（拆分 / 重命名 / 各种关闭）。
      */}
      <ContextMenuTrigger asChild>
        {/*
          标签本体是共享的 `shared/components/PanelTab`（与对话右侧的 SidePanel 同一颗）：
          图标 + 名字 + 行尾带渐变底的关闭 × 都在那里，两处标签条肉眼上才是同一套控件。
          这里只额外挂「主区域特有」的东西：拖拽源 ref（`setRef`）、右键菜单（`asChild` 让
          Radix 把 `onContextMenu` / `ref` 合并进来）、`data-tab-key`（供标签条把它滚进
          可视区）、重命名草稿，以及拖拽落区提示（走 children）。
        */}
        <PanelTab
          ref={setRef}
          data-tab-key={tabKey}
          active={active}
          label={meta.label}
          title={meta.title}
          icon={meta.icon}
          onActivate={() => onActivate(tabKey)}
          onClose={() => onClose([tabKey])}
          renaming={renaming}
          renameValue={draft}
          renameInputRef={renameInputRef}
          onRenameChange={setDraft}
          onRenameSubmit={submitRename}
          onRenameCancel={() => setRenaming(false)}
          // 高度（`h-7`）与图标尺寸已由 `PanelTab` 统一，这里只加主区域特有的：`max-w-52`
          // 是标签宽度的上限（主区域标签条要横向滚动），`min-w-28` 是**默认最小宽度**
          // （96px 时中文名字两个半字就被截成省略号、悬停才看得全，抬到 112px 更够用），
          // `shrink-0` 拒绝被压窄（侧栏那份要能挤）
          className={cn('max-w-52 min-w-28 shrink-0', isDragging && 'opacity-40')}
        >
          {/* 落区提示：一条竖线（插到前 / 后）或一圈描边（并入本组） */}
          {zone === 'inside' ? (
            <span className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-primary" />
          ) : zone ? (
            <span
              className={cn(
                'pointer-events-none absolute inset-y-0 w-0.5 bg-primary',
                zone === 'before' ? 'left-0' : 'right-0'
              )}
            />
          ) : null}
        </PanelTab>
      </ContextMenuTrigger>

      <ContextMenuContent
        className="w-52"
        /*
         * ⚠️ 这里干两件事：**别把焦点还给标签**（否则菜单关掉后标签上会亮一圈
         * `focus-visible` 边框），以及**把焦点补给重命名输入框**。
         *
         * 为什么非要在这一刻补：输入框挂出来时 `autoFocus` 抢不到焦点 —— Radix 模态菜单的
         * `FocusScope` 要等退场动画（内容上的 `duration-100`）跑完、内容真正卸载才撤掉，
         * 那 100ms 里任何外部 `focus()` 都会被它同步拽回菜单项。用户看到的就是「右键 →
         * 重命名 → 变成输入框了，但光标不在里面，敲字没反应」。这个回调正好在**内容卸载
         * 之后**才派发（`FocusScope` 的 unmount autofocus，见 `ui/src/focus-dismiss.ts`），
         * 是唯一能稳稳拿到焦点的那一刻。
         */
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const input = renameInputRef.current
          // 已经拿到了（没有退场动画 / 菜单非模态时 `autoFocus` 就能成）就别再碰它，
          // 免得搅掉用户这一拍里已经敲进去的字。不是重命名态（Esc / 点空白关的菜单）也没事：
          // 输入框没挂出来，ref 是 null。
          if (!input || document.activeElement === input) return
          input.focus()
        }}
      >
        {/*
          ⚠️ 只渲染**当下真的能用**的项：用不了的整条不出现，不是置灰。
          只留一个标签时没得拆、也没法「关闭其他」；已经在首 / 末位就没有左侧 / 右侧可关；
          只有一组时「关闭整个组」没意义（关完只是留一个空组占位）。免得到处是灰条、还得
          逐条去猜为什么点不动。
        */}
        {/* 拆分：把本标签拎到某个方向的新组（组里只剩它一个时无处可拆） */}
        {tabCount > 1 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Split className="size-4" />
              拆分
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => split('up')}>
                <ArrowUp className="size-4" />
                向上拆分
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => split('down')}>
                <ArrowDown className="size-4" />
                向下拆分
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => split('left')}>
                <ArrowLeft className="size-4" />
                向左拆分
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => split('right')}>
                <ArrowRight className="size-4" />
                向右拆分
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {renamable && (
          <ContextMenuItem onSelect={startRename}>
            <Pencil className="size-4" />
            重命名
          </ContextMenuItem>
        )}
        {/* 刷新：内容卸载重挂（会先过标签自己的守卫，见 `reloadTab`）。
            放在「重命名」之后、「关闭」一族之前 —— 前两条都是「改这一个标签」，后面是一族关闭 */}
        <ContextMenuItem onSelect={reloadTab}>
          <RefreshCw className="size-4" />
          刷新
        </ContextMenuItem>
        {/* 分隔线恒有：「刷新」与「关闭」一族之间一定要分开 */}
        <ContextMenuSeparator />
        {/*
          关闭方式**全部平铺在一级**：原先「关闭其他 / 左侧 / 右侧 / 整个组」收在一个也叫
          「关闭」的二级菜单里（与一级的「关闭」重名，还要多一层点击）。三种批量关闭都只
          作用于**本组**，且都保留当前这个标签。
        */}
        <ContextMenuItem onSelect={() => onClose([tabKey])}>
          <X className="size-4" />
          关闭
        </ContextMenuItem>
        {tabCount > 1 && (
          <ContextMenuItem onSelect={() => onClose(groupTabIds.filter((k) => k !== tabKey))}>
            关闭其他标签
          </ContextMenuItem>
        )}
        {index > 0 && (
          <ContextMenuItem onSelect={() => onClose(groupTabIds.slice(0, index))}>
            关闭左侧标签
          </ContextMenuItem>
        )}
        {index < tabCount - 1 && (
          <ContextMenuItem onSelect={() => onClose(groupTabIds.slice(index + 1))}>
            关闭右侧标签
          </ContextMenuItem>
        )}
        {canCloseGroup && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onCloseGroup(groupId)}>关闭整个组</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ---------------------------------------------------------------------------
// 组相关的用户手势动作
// ---------------------------------------------------------------------------

/** `useGroupActions` 的返回值：组外壳（标签条）与标签内容层共用这一份 */
interface GroupActions {
  /** 把这组设为焦点，并把「当前会话」对齐到它的活动标签 */
  focusGroup: (groupId: string) => void
  /** 点标签：切过去，再同步「当前会话」 */
  activateAndSync: (key: string) => void
  /** 关一批标签，再把「当前会话」对齐到焦点组顺移后的活动标签 */
  closeAndSync: (keys: string[]) => void
  /** 关掉整组（组里全部标签），再把「当前会话」对齐到焦点组顺移后的活动标签 */
  closeGroupAndSync: (groupId: string) => void
  /** 重命名对话标签 / 改工具标签的显示名（两条路的语义见 `renameTab`） */
  renameTab: (key: string, title: string) => void
  /**
   * 刷新标签：**对话标签** = 重新加载这条会话（等同刷新页面后点开它）；
   * **工具标签** = 卸载重挂（接口页重发请求 / 插件面重 render）。
   */
  reloadTab: (key: string) => void
}

/**
 * 组相关的用户手势动作。
 *
 * ## 为什么抽成 hook
 *
 * 「标签内容」与「组外壳」现在是**两棵子树**：内容在 `PanelContentLayer`（挂在
 * `PanelView` 根部，为的是不换 React 父节点），外壳（标签条 / 空态 / 落区）在布局树里。
 * 两边都要「点一下把这组设为焦点 + 把当前会话切过去」，逻辑必须只有一份。
 *
 * ## ⚠️ 同步「当前会话」必须由**用户手势**直接触发
 *
 * 不能放进「观察面板状态」的 effect 里：`openTab` 写的是外部 store，effect 在同一次提交里
 * 读到的是**上一帧**的 state，于是「按旧 state 纠正会话」和「按新会话开标签」会来回打架
 * —— 实测会直接触发 React 的 `Maximum update depth exceeded`。
 *
 * ## ⚠️ 工具标签不参与
 *
 * 主机 / 本机终端跟哪个会话都没关系，点一下就把当前会话换掉的话，顶栏与侧栏会跟着高亮到
 * 一个毫不相干的会话上。「已经是它」时也直接返回：`openConversation` 会再走一遍
 * `selectWorkspace` + `loadMessages`，重复打开等于白拉一次历史。
 */
function useGroupActions(): GroupActions {
  const { app, openConversation } = useAppContext()

  const syncConversation = useCallback(
    (key: string): void => {
      if (!isConversationTabKey(key)) return
      if (key === NEW_TAB_KEY) {
        if (app.activeConversationId === null) return
        app.openConversation(null)
        return
      }
      if (key === app.activeConversationId) return
      openConversation(key)
    },
    [app, openConversation]
  )

  /**
   * ⚠️ 这里读的是 `getPanelState()`（调用那一刻的现值），不是渲染时闭包里的 `group`。
   * 内容层的 pointerdown 与标签条的点击都可能发生在「上一次渲染之后」，读闭包会拿到
   * 过期的活动标签。
   */
  const focusGroup = useCallback(
    (groupId: string): void => {
      const s = getPanelState()
      if (s.activeGroupId === groupId) return
      setActiveGroup(groupId)
      const key = s.groups[groupId]?.activeTabId ?? null
      if (key) syncConversation(key)
    },
    [syncConversation]
  )

  const activateAndSync = useCallback(
    (key: string): void => {
      activateTab(key)
      syncConversation(key)
    },
    [syncConversation]
  )

  /**
   * 关标签（一个 = 关自己，多个 = 右键的批量关闭）：先过每个标签的守卫
   * （守卫可以弹确认 / 先停会话），**真关掉了**才把「当前会话」对齐到**焦点组**顺移后的
   * 活动标签（用户取消时绝不能动当前会话）。
   *
   * ⚠️ 对齐读的是 `activeTabKey()`（焦点组），不是「我们操作的那个组」：关掉本组最后一个
   * 标签时整组连同它的格子会被摘掉，焦点会落到别的组上 —— 只看本组的话读到的永远是
   * `undefined`，界面就会停在「侧栏高亮 A、面板显示 B」的错位上。
   * 整块面板被关空的情况由 `PanelView` 的兜底 effect 处理。
   */
  const closeAndSync = useCallback(
    (keys: string[]): void => {
      if (keys.length === 0) return
      void requestCloseTabs(keys).then((closed) => {
        if (!closed) return
        // store 是同步的：关完立刻读，拿到顺移后的活动标签
        const nextKey = activeTabKey()
        if (nextKey) syncConversation(nextKey)
      })
    },
    [syncConversation]
  )

  /**
   * 标签改名，两条完全不同的路：
   *
   * - **对话标签** → 改的是**那个会话的标题**（`renameConversation`）：落盘、侧栏同步、
   *   重开还是新名字。标题是会话自己的数据，不是这层壳的显示细节。
   * - **工具标签** → 只是主区域标签的**显示名**（`renameToolTab`）：内存里的一层别名，
   *   不回写主机清单 / 接口清单 / 脚本名，**标签关掉就恢复原名**（登记表条目被回收）。
   *   这些标签的名字本来就来自各自功能区的数据，标签条上的改动不该反向污染它们。
   *
   * 「新对话」草稿标签没有名字可改（它就是那个页面的语义）。
   */
  const renameTab = useCallback(
    (key: string, title: string): void => {
      if (key === NEW_TAB_KEY) return
      if (isConversationTabKey(key)) {
        void app.renameConversation(key, title)
        return
      }
      renameToolTab(key, title)
    },
    [app]
  )

  /**
   * 标签右键的「刷新」。按标签类型分派 —— 两者是**完全不同**的动作，别合并：
   *
   * - **对话标签** → `reloadConversation`：等价于「刷新页面 → 点开这个会话」，
   *   mastra 拉服务端权威历史、acp 走 `session/load` 回放。**不卸载重挂**：
   *   `ConversationTab` 重挂不会重新拉消息（消息在 store 里），只会把右侧面板的终端 /
   *   文件现场一起拆掉。
   * - **工具标签** → `requestReloadTab` 的卸载重挂（接口页重发请求、插件面重新 `render()`）。
   *   这条路会先问标签自己的 `beforeReload` 守卫。
   *
   * 「新对话」草稿标签没有会话可加载，走工具标签那条（重挂一次，等于清掉面板现场）。
   */
  const reloadTab = useCallback(
    (key: string): void => {
      if (key !== NEW_TAB_KEY && isConversationTabKey(key)) {
        // 正在生成时 store 会拒绝（权威历史会把流式现场整段盖掉）—— 这里先说清为什么没反应
        if (app.runningConversations[key]) {
          toast('这一轮还在生成，先停止再刷新')
          return
        }
        void app.reloadConversation(key)
        return
      }
      void requestReloadTab(key)
    },
    [app]
  )

  /**
   * 关掉**整组**（标签条行尾那颗 ×，以及右键菜单的「关闭整个组」）。
   *
   * 复用 `requestCloseGroup` 而不是 `requestCloseTabs(group.tabIds)`：读的是 store 里的现值，
   * 不依赖调用方渲染时的那份 `group`（标签条上的点击可能发生在「上一次渲染之后」）。
   *
   * ⚠️ 与 `closeAndSync` 同一条规矩：先过守卫、**真关掉了**才对齐，且对齐必须在 store
   * 写入**之后**读 `activeTabKey()`（焦点组）。关掉整组时焦点组自己会被摘空，读本组只会
   * 拿到 `undefined`。把最后一块面板也关空的情况由 `PanelView` 的兜底 effect 处理。
   */
  const closeGroupAndSync = useCallback(
    (groupId: string): void => {
      void requestCloseGroup(groupId).then((closed) => {
        if (!closed) return
        const nextKey = activeTabKey()
        if (nextKey) syncConversation(nextKey)
      })
    },
    [syncConversation]
  )

  return { focusGroup, activateAndSync, closeAndSync, closeGroupAndSync, renameTab, reloadTab }
}

// ---------------------------------------------------------------------------
// 一个面板组
// ---------------------------------------------------------------------------

function PanelGroupView({ groupId }: { groupId: string }) {
  const state = usePanelState()
  const meta = useTabMeta()
  const { focusGroup, activateAndSync, closeAndSync, closeGroupAndSync, renameTab, reloadTab } =
    useGroupActions()
  const group = state.groups[groupId]
  const isActiveGroup = state.activeGroupId === groupId

  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** 标签条的横向滚动容器（活动标签要能被滚进来，见下面的 effect） */
  const tabsRef = useRef<HTMLDivElement | null>(null)
  const [groupZone, setGroupZone] = useState<GroupDropZone | null>(null)

  const tabIds = group?.tabIds ?? []
  const activeKey = group?.activeTabId ?? null
  /**
   * 是否**多个分组**（数布局树的叶子）。
   * 只有多组时「关闭整组」才算一个真动作；单组时关掉它等于把面板关空、只留一个空组占位，
   * 与逐个关标签没区别 —— 所以标签条行尾那颗 × 与右键里的「关闭整个组」都按它决定显不显示。
   */
  const canCloseGroup = collectGroupIds(state.layout).length > 1

  /**
   * 活动标签一变就把它滚进标签条的可视区。
   *
   * 标签条是 `overflow-x-auto`（标签多了要横向滚），于是点侧栏某个会话时，它的标签很可能
   * 正好落在可视区之外 —— 界面看起来像「点了没反应」。这里在活动标签落定后把对应那颗滚进来；
   * `inline: 'nearest'` 保证已经在可视区里的标签不会被无谓地挪动一下。
   */
  useEffect(() => {
    const container = tabsRef.current
    if (!container || !activeKey) return
    const el = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-key]')).find(
      (node) => node.dataset.tabKey === activeKey
    )
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }, [activeKey])

  /**
   * 组车身落区：四边 = 分屏方向，中间 = 并入本组。
   * 指针在组矩形里的相对位置决定一切（见 `groupZoneOf`）。
   *
   * ⚠️ 与上面 `PanelTabItem` 同理，必须用「工厂函数 + deps」形式（原因见那里的长注释）。
   */
  const [{ isOver }, bodyDropRef] = useDrop<PanelTabDragItem, void, { isOver: boolean }>(
    () => ({
      accept: PANEL_TAB_TYPE,
      drop: (item, monitor) => {
        // 落在标签 / 标签条上时已由更内层的目标处理，避免重复
        if (monitor.didDrop()) return
        const rect = bodyRef.current?.getBoundingClientRect()
        const offset = monitor.getClientOffset()
        setGroupZone(null)
        if (!rect || !offset) return
        const zone = groupZoneOf(rect, offset.x, offset.y)
        if (item.groupId) {
          // 拖的是**整组**：center = 并入本组，四边 = 整组搬到那一侧
          moveGroup(item.groupId, groupId, zone)
          return
        }
        if (zone === 'center') {
          moveTab(item.key, groupId)
          activateTab(item.key)
          return
        }
        splitTab(item.key, groupId, zone)
      },
      hover: (item, monitor) => {
        // 拖自己所在的组（整组搬家）没有意义，不提示
        if (item.groupId === groupId) {
          setGroupZone(null)
          return
        }
        const rect = bodyRef.current?.getBoundingClientRect()
        const offset = monitor.getClientOffset()
        if (!rect || !offset) return
        setGroupZone(groupZoneOf(rect, offset.x, offset.y))
      },
      collect: (monitor) => ({ isOver: monitor.isOver() })
    }),
    [groupId]
  )

  useEffect(() => {
    if (!isOver) setGroupZone(null)
  }, [isOver])

  /**
   * 标签条拖起**整组**（落点见内容区 drop 的 `item.groupId` 分支）。
   *
   * 以前这是一根显式的抓手（标签条最左那条竖杠）。现在抓手去掉，改成**标签条空白区**即
   * 拖拽源：把拖拽源挂在标签条自身的容器上，而每颗标签自己也是拖拽源 —— 原生 HTML5
   * 拖拽取的是**离指针最近的那个可拖祖先**，于是「按在标签上 = 拖那颗标签、按在标签之间
   * 的空白处 = 拖整组」，同一个容器就分出了两种语义，不需要额外判定指针落在哪。
   */
  const [, groupDragRef] = useDrag<PanelTabDragItem, void>(
    () => ({
      type: PANEL_TAB_TYPE,
      item: { key: tabIds[0] ?? '', fromGroupId: groupId, groupId },
      canDrag: tabIds.length > 0
    }),
    [groupId, tabIds[0], tabIds.length]
  )

  // ⚠️ 必须 memo（见 `useDndRef` 的注释）：裸箭头函数每次渲染都是新 ref → 无限更新循环
  const tabsSetRef = useDndRef<HTMLDivElement>(groupDragRef, (node) => {
    tabsRef.current = node
  })
  /*
   * 车身元素一次干两件事：给落区判定当量尺（`bodyRef`），以及登记给内容层摆位用
   * （`registerPanelBody`）。React 卸载时会以 `null` 调这个回调，正好把登记注销掉。
   */
  const bodySetRef = useDndRef<HTMLDivElement>(bodyDropRef, (node) => {
    bodyRef.current = node
    registerPanelBody(groupId, node)
  })

  return (
    <div
      // 焦点组底色更实：一眼看出「拖拽会落到哪一组」
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
        isActiveGroup ? 'bg-background' : 'bg-background/60'
      )}
      // 点标签条 / 空态 / 落区浮层 → 把这组设为焦点。⚠️ 标签**内容**不在这棵子树里
      // （见 `PanelContentLayer`），它的事件按 React 树冒泡、不经过这里，那边另挂了一份。
      onPointerDownCapture={() => focusGroup(groupId)}
    >
      {/*
        标签条：各标签 + 「全部标签」溢出菜单 + 关闭整组。
        ⚠️ `relative z-10` 是必需的：标签内容层是 PanelView 根部的 `absolute z-0`，
        按绘制顺序它会盖住所有**普通流内**的内容（见 `PanelContentLayer` 的注释）。

        这里**没有**「新建对话」：标签不在这条标签条上创建（空态里那颗按钮才是入口），
        把 + 摆在这儿只会让人以为「新标签从这里长出来」。行尾留给「关闭整组」——
        与参考实现（dogi）一致：分组之后的整组退出入口在标签条上，而不是只藏在右键菜单里。
      */}
      <div className={cn('relative z-10 flex shrink-0 items-center gap-1 px-1', STRIP_H)}>
        {/*
          标签容器同时是**整组拖拽源**：按在标签上拖 = 拖那颗标签，按在标签之间的空白处拖 =
          拖整组（原生拖拽取离指针最近的可拖祖先，见上面 useDrag 的注释）。原先的显式抓手
          因此去掉 —— 少一件常驻装饰，拖拽入口反而更大（整条空白区）。
        */}
        <div ref={tabsSetRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
          {tabIds.map((key, index) => (
            <PanelTabItem
              key={key}
              tabKey={key}
              groupId={groupId}
              groupTabIds={tabIds}
              index={index}
              active={key === activeKey}
              meta={meta(key)}
              canCloseGroup={canCloseGroup}
              onActivate={activateAndSync}
              onClose={closeAndSync}
              onCloseGroup={closeGroupAndSync}
              onRename={renameTab}
              onReload={reloadTab}
            />
          ))}
        </div>
        {tabIds.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 text-muted-foreground"
                aria-label="全部标签"
                title="全部标签"
              >
                <Rows2 className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-xs text-muted-foreground">本组标签</DropdownMenuLabel>
              {tabIds.map((key) => (
                <DropdownMenuItem key={key} onSelect={() => activateAndSync(key)}>
                  <span className="truncate">{meta(key).label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/*
          关闭整组：把这组里的标签全关掉。
          ⚠️ **只有多个分组时才渲染**：单组时关掉整组只是把唯一的面板关空、留一个空组占位，
          与「逐个关标签」没有区别，摆一颗 × 反而让人以为关掉后面板会消失。多组时它是
          「退出这一格」的快捷入口（右键里的「关闭整个组」是同一个动作，也跟着这个条件走）。

          ⚠️ 关掉后**这一格不会消失**：`panel-groups` 的 `alignToTabs` 会保留一个空组占位
          （布局树不能是 `null`），组里那句「没有打开的标签」就是这个状态。把**最后一块**
          面板也关空时，`PanelView` 会补一张「新对话」草稿标签（会话同时退回空态）。
        */}
        {tabIds.length > 0 && canCloseGroup && (
          <RowActionButton
            className="flex size-6 shrink-0 items-center justify-center hover:text-destructive"
            aria-label="关闭整个组"
            title="关闭整个组"
            onClick={() => closeGroupAndSync(groupId)}
          >
            <X className="size-4" />
          </RowActionButton>
        )}
      </div>

      {/*
        车身：**只留一个洞**。标签内容不在这里渲染 —— 它由 `PanelContentLayer` 在
        `PanelView` 根部渲染一次，再按这个 div 的矩形摆过来（见 `panel-bodies.ts` 的文件头）。
        组里自己渲染内容的话，标签换组就会换 React 父节点、实例被卸载重挂，
        终端的 xterm 与 PTY 一起没。
        空态与落区浮层仍留在组里：它们不是「标签内容」，而且要压在内容之上。
      */}
      <div
        ref={bodySetRef}
        /*
         * `data-panel-body` 只为一件事存在：让验证脚本能**定位到某个组的车身**，
         * 从而真的把标签拖到它身上（`scripts/verify-panel-dnd.mjs`）。落区判定用的
         * `groupZoneOf` 读的就是这个 div 的矩形，脚本要打的也是同一个目标。
         */
        data-panel-body={groupId}
        className="relative min-h-0 flex-1"
      >
        {tabIds.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-sm text-muted-foreground">
            <span>没有打开的标签</span>
          </div>
        )}

        {/* 落区提示：四边分屏 = 半个高亮块；中间 = 整块描边（`z-20` 要压过内容层的 `z-0`） */}
        {groupZone && (
          <div className="pointer-events-none absolute inset-0 z-20">
            {groupZone === 'center' ? (
              <div className="absolute inset-0 rounded-lg ring-2 ring-primary ring-inset" />
            ) : (
              <div
                className={cn(
                  'absolute rounded-lg bg-primary/20 ring-2 ring-primary ring-inset',
                  groupZone === 'left' && 'inset-y-0 left-0 w-1/2',
                  groupZone === 'right' && 'inset-y-0 right-0 w-1/2',
                  groupZone === 'up' && 'inset-x-0 top-0 h-1/2',
                  groupZone === 'down' && 'inset-x-0 bottom-0 h-1/2'
                )}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 一个标签的内容
// ---------------------------------------------------------------------------

/**
 * SFTP 文件管理标签的内容：按 key 里的 hostId 去主机清单里取配置。
 *
 * 取不到（主机被删）时给一句明确的话，而不是渲染一个空壳页面 —— 与终端标签
 * 「数据已失效」同一套处理。主机配置只读（`SshHostConfig` 里没有明文凭据），
 * 真正的连接凭据在服务端解密，这一路只用到 `username@host:port` 与 id。
 */
function SftpTabContent({ hostId }: { hostId: string }): ReactNode {
  const { app } = useAppContext()
  const host = app.sshHosts.find(
    (h): h is SshHostConfig => h.kind !== 'local' && h.id === hostId
  )
  if (!host) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        这台主机已不存在，关闭标签后重新打开即可。
      </div>
    )
  }
  return <SftpPanel host={host} />
}

/**
 * 接口请求标签的内容：按 `protocol` 分发到 HTTP 编辑页（`ApiPage`）或 WebSocket 调试页
 * （`WsPage`）。草稿（哨兵 `NEW_WS_REQUEST_ID`）还没落盘、不在清单里，直接判定走 WS 页；
 * 已保存条目读它的 `protocol`（undefined = http，兼容历史数据）。
 */
function ApiTabContent({ requestId }: { requestId: string }): ReactNode {
  const { app } = useAppContext()
  const request = app.apiRequests.find((r) => r.id === requestId) ?? null
  if (requestId === NEW_WS_REQUEST_ID || request?.protocol === 'ws') {
    return <WsPage requestId={requestId} />
  }
  return <ApiPage requestId={requestId} />
}

/**
 * 终端标签的内容：登记表元数据 → 一条终端。
 *
 * ⚠️ **主区域的终端标签恒是「宿主本机」终端，不做任何容器判定。**
 * 以前这里会拿 `tool.workspaceId` 去 `containerProjects` 快照里查，命中容器型项目就把
 * `containerWorkspaceId` 交给 `TerminalPanel`（服务端换成 `docker exec`）—— 于是「主机与
 * 终端」里配的那条**本机终端**，只要当前项目是容器型，就变成了容器内 shell（用户报过）。
 * 「主机与终端」是**独立功能**，它开出来的东西与任何会话 / 项目都无关；容器终端只存在于
 * **会话自己的侧栏面板**里，那条路由 `openTerminalTabOf` 显式带 `containerWorkspaceId`
 * （见 `features/chat/ConversationTab.tsx`），不靠这里推断。
 */
function TerminalTabContent({ tabKey, active }: { tabKey: string; active: boolean }): ReactNode {
  const tool = getToolTab(tabKey)
  if (!tool) {
    /*
     * 登记表里没有它 —— 理论上不该发生（条目与标签同生共死：`openXxxTab` 先写表再开标签，
     * 标签关掉后由 `PanelView` 的 effect 回收）。真出现了就明说，别渲染一片空白让人以为
     * 是终端挂了。
     */
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        这个标签的数据已失效，关闭后重新打开即可。
      </div>
    )
  }
  return (
    <TerminalTabView tabKey={tabKey}>
      <TerminalPanel
        // 本机终端的工作目录（主机终端不用它，走 `sshHostId`）
        cwd={tool.cwd}
        // 不是正被看着的那个就别抢输入焦点（收起 / 切走的标签仍常挂载）
        visible={active}
        shellId={tool.shellId ?? null}
        // 命令历史 / 预测的作用域：SSH 主机终端一份（全局）、宿主本机终端一份（全局，
        // 不挂项目，见 `localHistory`）。**这里不传 workspaceId** —— 主区域的终端与项目无关。
        localHistory={tool.kind === 'local'}
        sshHostId={tool.sshHostId}
        // 本机终端的额外启动参数 / 启动后自动命令（主机终端不适用，TerminalPanel 里只在
        // 非 ssh 分支使用）
        args={tool.kind === 'local' ? tool.args : undefined}
        autoCommand={tool.kind === 'local' ? tool.autoCommand : undefined}
        // 运行脚本时终端就绪后写入一次（SSH 与本机终端都适用，见 TerminalPanel.scriptInput）
        scriptInput={tool.scriptInput}
        // 主区域的工具标签带 tabKey → 终端按它登记关闭守卫（进程还活着时关标签要确认），
        // 也按它登记到终端登记表（供内嵌 AI 助手操作这个终端）。
        tabKey={tabKey}
      />
    </TerminalTabView>
  )
}

/**
 * 按标签 key 的类型分发内容：对话标签 → `ConversationTab`；工具标签 → 一条终端。
 *
 * ⚠️ 这个分发点**只有一处**（`PanelContentLayer` 里按标签平铺时调它）。标签内容绝不能在
 * 递归的布局骨架上、或在组里再渲染一份 —— 标签换组时那会换掉它的父节点，React 卸载重挂，
 * 终端 xterm 重建、PTY 被 kill、未保存内容全丢（见 `docs/lessons/ui.md` §59）。
 */
function PanelTabContent({ tabKey, active }: { tabKey: string; active: boolean }): ReactNode {
  if (isConversationTabKey(tabKey)) {
    return (
      <ConversationTab
        conversationId={tabKey === NEW_TAB_KEY ? null : tabKey}
        // 守卫表按**标签 key** 索引（关闭 / 刷新都问它），而「新对话」占位标签的 key 是
        // `__new__`、会话 id 为空 —— 只传 conversationId 的话，草稿标签就登记不上守卫。
        hostTabKey={tabKey}
      />
    )
  }

  // 接口请求标签：草稿是哨兵 requestId，按 protocol 分发到 HTTP 页 / WebSocket 页。
  // 非活动标签由内容层 `hidden` 藏而不卸 —— 编辑到一半的方法 / 地址 / 响应都留在内存里。
  if (isApiTabKey(tabKey)) {
    return <ApiTabContent requestId={apiRequestIdOfTabKey(tabKey) ?? NEW_API_REQUEST_ID} />
  }

  // SFTP 文件管理标签：一台主机 = 一条（key 里带 hostId）。主机配置在
  // `useAppContext` 的清单里现取 —— 主机被删则渲染一句「数据已失效」，不炸。
  if (isSftpTabKey(tabKey)) {
    return <SftpTabContent hostId={sftpHostIdOfTabKey(tabKey) ?? ''} />
  }

  // 隧道标签：全局单例面板（`tunnel:list`）。它自己从 store 读 `sshTunnels` / `tunnelRuntimes`
  // 并订阅 WS 推送，不需要在这里传数据；「从主机右键进来」的预选主机在登记表里（`getToolTab`）。
  if (isTunnelTabKey(tabKey)) {
    return <TunnelPanel tabKey={tabKey} />
  }

  // 应用日志标签：全局单例面板（`logs:list`）。它自己拉全量 + 订阅 SSE（见 features/logs
  // 的 logs-store），这里同样不需要传数据；命名空间 Tab 列表也来自服务端应答。
  if (isLogsTabKey(tabKey)) {
    return <LogsPanel />
  }

  // 定时任务标签：全局单例管理面板（`triggers:list`）。数据走 `useAppContext().triggers`
  // （与侧栏那块看板同一份），这里不需要传任何东西。
  if (isTriggersTabKey(tabKey)) {
    return <TriggersPanel />
  }

  // 脚本管理面板：全局单例（`scripts:list`）。清单走 `useAppContext().app.scripts`
  // （与脚本编辑页 / 侧栏同一份），这里不需要传任何东西。
  if (isScriptsTabKey(tabKey)) {
    return <ScriptsPanel />
  }

  // 插件界面标签：内容由**服务端**的 render() 产出（插件不写 React，见 PluginSurfaceBody）。
  // 归属（哪个插件 / 哪个面）在 `tool-tabs` 的登记表里，key 只是不透明的 `plugin:<n>`。
  if (isPluginTabKey(tabKey)) {
    return <PluginTabContent tabKey={tabKey} />
  }

  // 笔记标签：归属（哪个根 + 哪篇）在 `tool-tabs` 的登记表里，key 只是不透明的 `note:<n>`。
  // `active` 必须传下去 —— 所有标签都常挂载，`Ctrl/Cmd+S` 只有**正被看着的那篇**该响应。
  if (isNoteTabKey(tabKey)) {
    return <NoteTabContent tabKey={tabKey} active={active} />
  }

  // 本地文件标签：用本应用打开的一篇**本机** Markdown（绝对路径，读写走主进程 fs）。
  // 与上面的笔记标签是两条独立通路，见 `features/local-file/LocalFileTabContent.tsx` 的对照表。
  if (isLocalFileTabKey(tabKey)) {
    return <LocalFileTabContent tabKey={tabKey} active={active} />
  }

  // 剩下的就是终端标签（`host:<id>` / `local:<n>`）：元数据在登记表里，而「这个工作区
  // 是不是容器型项目」要读 state ws 的快照 —— 读快照得挂 hook，故内容拆到独立组件里。
  return <TerminalTabContent tabKey={tabKey} active={active} />
}

// ---------------------------------------------------------------------------
// 内容层：全部标签在 PanelView 根部渲染，再按各组车身矩形摆过去
// ---------------------------------------------------------------------------

/** 一个标签内容在屏幕上的落位（相对内容层左上角；单位 px，就是量出来的值） */
interface TabSlot {
  left: number
  top: number
  width: number
  height: number
}

/** 两组落位是否逐项相同（相同就保持原引用，免得白白多渲染一轮） */
function sameSlots(a: Record<string, TabSlot>, b: Record<string, TabSlot>): boolean {
  const keys = Object.keys(b)
  if (Object.keys(a).length !== keys.length) return false
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (!x) return false
    if (x.left !== y.left || x.top !== y.top || x.width !== y.width || x.height !== y.height) {
      return false
    }
  }
  return true
}

/**
 * 标签**内容层**：主区域所有标签的内容在这里（`PanelView` 根部）平铺渲染一次，
 * 每个标签绝对定位到它所属组的车身矩形上。
 *
 * ## 为什么不在组里渲染
 *
 * 用户报的 bug：在同一个组里开两条终端，把其中一条拆到旁边 —— 两条终端都重开了一遍，
 * 输出清空、正在跑的程序被杀。根因不是「拆分」这个动作，而是**内容换了 React 父节点**：
 * 内容原来由 `PanelGroupView` 渲染，标签一旦换组（被拆走 / 拖到别的组），
 * 父节点就从「A 组」变成「B 组」，React 卸载重挂 —— `TerminalPanel` 的 cleanup 会把
 * PTY kill 掉。
 *
 * 所以内容必须**始终待在同一个父节点下**，位置只靠坐标变化来表达。于是：
 * 内容全挂在 `PanelView` 根部（这个扁平列表），组的坐标由
 * `panel-bodies.ts` 登记的车身元素量出来。标签换组 = 换一组坐标，React 看到的是
 * 同一个 key、同一层级的同一个节点 ⇒ **实例原样保留**。
 *
 * ## 为什么不是 `createPortal(内容, 车身)`
 *
 * React 19 的 `updatePortal` 里有一句「容器变了就 `createFiberFromPortal` 建新 fiber」
 * 的判定（原文抄在 `panel-bodies.ts` 的文件头）—— 标签换组时容器**正是要变**，
 * 于是 portal 版会照样重挂，比现在更隐蔽。详见 `panel-bodies.ts`。
 *
 * ## 四条必须守住的细节
 *
 * 1. **落位是量出来的，不是算出来的。** 布局树只有 `sizes` 权重，换算成像素要重做一遍
 *    flex 布局（还得算上分隔条宽度），迟早对不上。这里直接读车身的
 *    `getBoundingClientRect()`，相对内容层原点换算。
 * 2. **落位按「标签」缓存，量不到新组的车身时沿用上一次的位置。**
 *    拆分那一拍，新组的车身是**这次提交才挂出来**的 —— 提交前那次渲染里还没有它的矩形。
 *    若这时因为「查不到落位」就不渲染这个标签，React 会把它的内容卸载掉，正好又踩回
 *    要修的 bug（PTY 被杀）。所以量不到就退回上一次的落位，撑过这一帧；下一帧量到新矩形
 *    再挪过去（视觉上只是原地停一帧）。
 * 3. **拖动面板标签时必须把内容层让开（`pointer-events: none`）。**
 *    react-dnd 的 HTML5 后端是把 `dragenter/dragover/drop` 监听**挂在落区节点自己身上**的
 *    （`connectDropTarget` 里 `node.addEventListener(...)`），靠原生冒泡到达。内容层压在
 *    车身之上，如果它成了指针下的命中目标，那些事件就再也冒泡不到车身 —— 落区高亮与
 *    分屏全都失灵。让开之后指针下就是车身本身，与「内容不在这一层」时完全一致。
 * 4. **点内容区要能把这组设为焦点。** 内容层在 DOM 上落在车身里，但 React 树上是
 *    `PanelView` 的子节点 —— 事件按 **React 树**冒泡，不经过组的根节点，所以
 *    `PanelGroupView` 上那个 `onPointerDownCapture` 收不到。这里补一份。
 * 5. **容器型项目的「容器状态」卡片包在标签内容上（`ContainerTabGate`），不套在面板外面。**
 *    主区域是多标签的：门一旦套在 `PanelView` 外，容器一停（启动中 / 停止中 / 失败同理）
 *    就整块面板连标签条一起换成卡片，用户看不到也切不了别的标签（用户报过）。放在这里，
 *    标签条、拖拽、分屏、关闭全部照常，只有属于那个容器项目的标签内容换成卡片。
 */
function PanelContentLayer({ state }: { state: PanelState }): ReactNode {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const { focusGroup } = useGroupActions()
  const version = useSyncExternalStore(
    subscribePanelBodies,
    panelBodiesVersion,
    panelBodiesVersion
  )
  /** `标签 key → 落位`（不是按组存：换组时那条缓存正是要跨过去的，见上面第 2 条） */
  const [slots, setSlots] = useState<Record<string, TabSlot>>({})

  /** `measure` 要保持引用稳定（它是下面 effect 的依赖），又要读到最新的分组状态 —— 走 ref */
  const stateRef = useRef(state)
  stateRef.current = state

  /** 量一遍所有已登记的车身，换算成相对内容层的坐标，再落到每个标签头上 */
  const measure = useCallback((): void => {
    const layer = layerRef.current
    if (!layer) return
    const base = layer.getBoundingClientRect()
    const bodies = panelBodies()
    setSlots((prev) => {
      const next: Record<string, TabSlot> = {}
      for (const [tabKey, owner] of tabOwners(stateRef.current)) {
        const rect = bodies.get(owner.groupId)?.getBoundingClientRect()
        if (rect && rect.width > 0 && rect.height > 0) {
          next[tabKey] = {
            left: rect.left - base.left,
            top: rect.top - base.top,
            width: rect.width,
            height: rect.height
          }
        } else if (prev[tabKey]) {
          // 车身这一拍还没量到（刚挂出来 / 被折叠成 0 尺寸）：沿用上一次的落位（第 2 条）
          next[tabKey] = prev[tabKey]
        }
      }
      return sameSlots(prev, next) ? prev : next
    })
  }, [])

  /*
   * ⚠️ 每次提交后都重量一遍（无依赖）。会改布局的东西太多 —— 拖分隔条（走 panel-store
   * 的每帧更新）、开关侧栏、字体加载完成、窗口缩放…与其把触发源枚举全，不如「渲染完就量」：
   * 矩形没变时 `setSlots` 返回原引用，React 直接 bail out，不会多出一轮渲染。
   */
  useLayoutEffect(measure)

  /*
   * 车身集合变了（组新增 / 移除 / 换了 DOM 元素）→ 重挂 ResizeObserver 并立刻重量。
   * 「侧栏拖宽」这类**不经过 React 渲染**的尺寸变化，只有 ResizeObserver 接得住。
   */
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => measure())
    for (const el of panelBodies().values()) observer.observe(el)
    const onWindowResize = (): void => measure()
    window.addEventListener('resize', onWindowResize)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
    }
  }, [measure, version])

  /**
   * 标签「刷新」代号变更的信号（`tab-reload.ts`）。代号本身按标签在下面 map 里读 ——
   * 不能在这里给每个标签挂一个 hook（map 里调 hook 不合法）。
   */
  useSyncExternalStore(subscribeTabReloads, tabReloadsVersion, tabReloadsVersion)

  /*
   * 面板标签拖拽中：把内容层让开，让原生 drag* 事件落到车身身上（见上面第 3 条）。
   * `useDragLayer` 读的是全局 monitor，与具体是哪个标签 / 哪组在拖无关。
   */
  const draggingTab = useDragLayer(
    (monitor) => monitor.isDragging() && monitor.getItemType() === PANEL_TAB_TYPE
  )

  const owners = tabOwners(state)

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-0">
      {allTabKeys(state).map((tabKey) => {
        const owner = owners.get(tabKey)
        const slot = slots[tabKey]
        // 从没量到过落位（刚开出来的新标签，首帧）：先不挂内容，免得 xterm 按 0×0 去 fit
        if (!owner || !slot) return null
        return (
          <div
            key={`${tabKey}#${tabReloadGen(tabKey)}`}
            /*
             * ⚠️ 这里是标签内容的宿主。key = 标签 key（**加刷新代号**），层级恒定 ——
             * 标签换组只改下面这组坐标，React 对账看到的是同一个节点，实例复用、不重挂；
             * 只有用户点了那颗「刷新」才换 key，强制这一个标签的内容卸载重挂（见 `tab-reload.ts`）。
             */
            style={{ left: slot.left, top: slot.top, width: slot.width, height: slot.height }}
            className={cn(
              'absolute overflow-hidden',
              // 拖拽中让开指针（见上面第 3 条）；用三元而不是叠加类名，避免优先级歧义
              draggingTab ? 'pointer-events-none' : 'pointer-events-auto',
              // 非活动标签 `hidden` 而**不卸载**：xterm 实例 / scrollback / 未保存内容只在内存里
              !owner.active && 'hidden'
            )}
            onPointerDownCapture={() => focusGroup(owner.groupId)}
          >
            {/*
              ⚠️ 内容宿主**必须是 flex 列**：`ConversationTab` 的根用 `flex-1`，
              只有父级是 flex 容器时它才有「确定的高度」可言。宿主若只是个块级
              `h-full`，`flex-1` 会被忽略、子级高度退化成 `auto` → 一路撑到内容高度，
              里面那些 `overflow-y-auto` 的滚动容器**永远不会触发滚动**。
              （与 dogi `PanelView` 的注释同一条约束，踩过两次了。）
            */}
            <div className="flex h-full flex-col">
              {/*
                ⚠️ 容器门（`ContainerTabGate`）必须在**这里**（每个标签内容各包一层），
                不能套在整个 `PanelView` 外面：容器一停就把标签条一起顶掉，用户看不到也
                切不了别的标签。门只拦「属于那个容器项目」的标签，见它的文件头。
              */}
              <ContainerTabGate tabKey={tabKey}>
                <PanelTabContent tabKey={tabKey} active={owner.active} />
              </ContainerTabGate>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 布局树递归
// ---------------------------------------------------------------------------

/**
 * 布局树递归。
 *
 * ## ⚠️ 叶子与分隔节点必须渲染**同构**结构（否则拆分会把整组终端拆没）
 *
 * 一个叶子和一个分隔节点，渲染出来都是「同一个外层 flex 容器 + 若干个
 * `Fragment key=<子节点 id>`」，**区别只在 children 是 `[自己]` 还是 `node.children`**：
 *
 * ```text
 * 叶子 A          →  <div class="flex flex-col">
 *                      <Fragment key=A><div>{PanelGroupView A}</div></Fragment>
 *                    </div>
 * A 拆出 B 之后    →  <div class="flex flex-row">
 *                      <Fragment key=A><div>{PanelGroupView A}</div></Fragment>
 *                      <Fragment key=B><div>{PanelGroupView B}</div></Fragment>
 *                    </div>
 * ```
 *
 * 这样 React 在结构切换时能**按 key 命中原有子树**（外层 div 类型不变 → 就地更新；
 * `Fragment key=A` 命中 → 里面的 `PanelGroupView A` 同类型同 props → **复用实例，不卸载**）。
 * 于是 A 组里的终端、xterm 滚动缓冲、正在跑的程序全都留着 —— 拆分只影响被搬走的那一个标签。
 *
 * 反面教材（本次修掉的写法）：叶子直接 `return <PanelGroupView/>`、分隔节点才包一层 `div`。
 * 那样 leaf → split 时，根元素类型从 `PanelGroupView` 变成 `div`，React **整棵子树卸载重建**
 * ⇒ 组里每一条终端都被 kill 掉、输出清空（`TerminalPanel` 的 cleanup 会杀 PTY）。
 *
 * 还有一条同样致命、但不显眼的约束：**内容 div 必须排在 `Splitter` 前面**。
 * Fragment 内部的子节点是按**位置**（无 key）对账的 —— 把 Splitter 写在前面的话，
 * 一个孩子从「末位」变成「非末位」时，位置 0 会从内容 div 变成 Splitter（类型不同）
 * ⇒ 内容照样被卸载。内容 div 固定在位置 0，才是真的稳。
 *
 * （参考实现 dogi 的 `PaneTree` 就是这么写的，注释里明说「leaf → split 结构切换时
 * React 按 key 命中原有子树，既有组/终端不会卸载」。）
 */
function PaneNodeView({ node }: { node: PaneNode }): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)

  const split = node.type === 'split' ? node : null
  const children: PaneNode[] = split ? split.children : [node]

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 overflow-hidden',
        split && split.direction === 'row' ? 'flex-row' : 'flex-col'
      )}
    >
      {children.map((child, i) => (
        <Fragment key={child.id}>
          {/* 内容 div 恒在位置 0（见上面第 3 段注释：位置一变，React 就会重建内容） */}
          {/*
            权重直接当 `flex-grow` 用 ⇒ **必须由 `pane-layout` 保证总和为 1**
            （`normalizeSizes`）。flexbox 对「flex-grow 之和 < 1」只分配
            「剩余空间 × 总和」，剩下的会空出来透出容器底色 —— 这正是「关掉最右栏后
            右边一片灰、左边内容也不变宽」那个 bug 的成因，别在这里再改回裸比例。
          */}
          <div
            style={{ flexGrow: split ? (split.sizes[i] ?? 1) : 1, flexBasis: 0 }}
            className="flex min-h-0 min-w-0"
          >
            {child.type === 'leaf' ? (
              <PanelGroupView groupId={child.groupId} />
            ) : (
              <PaneNodeView node={child} />
            )}
          </div>
          {/* 分隔条排在内容**后面**：`index` 的语义仍是「children[index] 与 [index+1] 之间」 */}
          {split && i < children.length - 1 && (
            <Splitter split={split} index={i} containerRef={containerRef} />
          )}
        </Fragment>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 根
// ---------------------------------------------------------------------------

export function PanelView() {
  const state = usePanelState()
  const { app, adoptDraftPanel } = useAppContext()
  const { closeAndSync } = useGroupActions()

  const activeConversationId = app.activeConversationId

  /**
   * `app` 是 `agentAppFrom()` 每次渲染现造的、context 的 value 也是现造的 —— 把这类
   * 「每次渲染都换引用」的东西收进 ref，让下面那些兜底 effect 只由「当前会话 / 面板状态 /
   * 会话清单」变了触发，而不是每次无关重渲染都重跑。
   */
  const actionsRef = useRef({ app, adoptDraftPanel })
  actionsRef.current = { app, adoptDraftPanel }

  /**
   * 零标签 → 补一张「新对话」草稿标签（与手机端 `apps/mobile/.../PanelView.tsx` 同一套做法）。
   *
   * 「一个标签都没有」不是一个该被展示的状态：关光所有标签的本意就是收起手头的事，
   * 而空白页上什么也做不了。补一张 `__new__` 草稿标签后，主区域直接落在「开始新对话」页
   * （还没有项目时是引导页，见 `ChatPanel`）。
   *
   * `useLayoutEffect`：在浏览器绘制前补上，不先闪一帧空白。
   *
   * ⚠️ **有待恢复的会话时不要补**：刷新 / 冷启动会经 `useAgentApp` 恢复上次的会话，
   * 那一刻先塞草稿的话，下面那个 effect 开完真实会话就会并排多出一张「新对话」。
   *
   * ⚠️ 补的是草稿标签，不是给 `activeConversationId` 找一条会话：启动恢复仍是
   * `useAgentApp` 的事，恢复到位后草稿会被下面的 effect **就地替换**（`syncTabs`）。
   */
  useLayoutEffect(() => {
    if (allTabKeys(state).length > 0) return
    if (activeConversationId) return
    openTab(NEW_TAB_KEY)
  }, [state, activeConversationId])

  /**
   * 「选中**具体会话** → 焦点标签」：侧栏选中一条会话 / 启动恢复时同步标签。
   * `null` 不代表「自动打开新对话」：它也意味着刚关完所有标签。冷启动和刷新时若
   * 因为会话尚未恢复就给这个 `null` 自动找一条会话，用户关光的会话会凭空长回来。
   * **显式**新建仍由侧栏动作打开 `NEW_TAB_KEY`；零标签的情况另有一支（见上面那句
   * `useLayoutEffect`）—— 补的是一张草稿，不指向任何会话。
   *
   * 首次挂载时如果已有主机/终端标签，只补会话、不抢焦点；若显式新建占位标签
   * 已经是唯一标签，第一条消息建出的真实会话会把它就地替换，不产生并排的两张
   * —— 那一支还要把草稿的面板现场**交给**新会话（`adoptDraftPanel`），
   * 否则用户在新对话标签里开着的终端会随着标签被替换一起消失。
   */
  const mountedRef = useRef(false)
  useEffect(() => {
    const key = activeConversationId
    if (!mountedRef.current) {
      mountedRef.current = true
      if (!key) return
      if (activeTabKey() !== null) {
        ensureTab(key)
        return
      }
    }
    if (!key) return
    const open = allTabKeys()
    if (open.length === 1 && open[0] === NEW_TAB_KEY) {
      // 占位标签被**就地替换**：先把草稿那份面板现场交给新会话（终端 / 文件现场不丢），
      // 再换标签 —— 换完草稿 key 就没人认领了（回收 effect 会把它当成「标签已关」清掉）。
      // ⚠️ 只在这一支做。别的分支（标签不止一个 → 新会话开成**新标签**、或用户点的是既有
      // 会话）都不该动草稿现场：那会让「新对话」标签开着的东西凭空跑到别的会话上去。
      actionsRef.current.adoptDraftPanel(key)
      syncTabs([key])
      return
    }
    openTab(key)
  }, [activeConversationId])

  /**
   * 「会话被**删除 / 归档** → 它的标签跟着消失」。
   *
   * 标签集合是**会话清单的视图**，但以前只有「当前会话 → 焦点标签」这一条同步线
   * （上面那个 effect 只认 `activeConversationId` 的**变化**）。于是：
   * - 删掉 / 归档一条**没在看的**会话，它的标签原封不动留在标签条上（标题退化成
   *   「对话」，点进去是一条空会话）；
   * - 删掉正在看的那条，store 会把当前会话切到邻居，但**旧标签照样留着**；
   * - 另一台客户端删 / 归档的（状态 WS 推来新清单）本地同样不处理。
   * 所以这里按**清单**对一次表：清单里没有、或已归档的会话标签，直接裸关。
   *
   * ⚠️ 四个前提，缺一个就会误关：
   * 1. `conversationsLoaded`：首屏清单还没落地时，空清单会把所有对话标签判成「已消失」；
   * 2. 跳过 `NEW_TAB_KEY`：草稿标签不是会话（`isConversationTabKey` 只按「不是工具标签」
   *    判，草稿 key 会漏进来）；
   * 3. 裸关（`closeTabs`，不过守卫）：会话都没了，再问一句「确定关掉吗」没有意义；
   * 4. 关完要把「当前会话」对齐到焦点组现在的活动标签 —— 归档的正是当前会话时，
   *    `activeConversationId` 还指着那条（已归档的）会话，而上面那个 effect 只认
   *    「变化」不会自己纠；更糟的是「零标签补草稿」那条会因为「有 active」而不补，
   *    面板就空在那儿。
   *
   * 依赖只给清单：`app` 每次渲染都换引用，走 `actionsRef` 读现值。
   */
  useEffect(() => {
    if (!app.conversationsLoaded) return
    // 活着的 = 还在清单里、且没被归档（归档的会话仍留在清单里，靠 `archivedAt` 区分）
    const alive = new Set(
      app.conversations.filter((c) => !c.archivedAt).map((c) => c.id)
    )
    const stale = allTabKeys().filter(
      (k) => k !== NEW_TAB_KEY && isConversationTabKey(k) && !alive.has(k)
    )
    if (stale.length) closeTabs(stale)

    const current = actionsRef.current.app.activeConversationId
    if (!current || alive.has(current)) return
    const nextKey = activeTabKey()
    if (nextKey && nextKey !== NEW_TAB_KEY && isConversationTabKey(nextKey)) {
      // 面板上还剩别的**会话**标签（关掉那个之后焦点组顺移到了它）→ 当前会话跟着它走。
      // 用 store 的 `openConversation` 而不是 context 那个：这里只是纠状态，不该顺手
      // 再 `openTab` 一遍、更不该替用户切视图。
      actionsRef.current.app.openConversation(nextKey)
      return
    }
    // 面板上剩下的不是会话标签（工具标签 / 空）→ 退回空态；零标签时由上面那条
    // `useLayoutEffect` 补一张草稿标签
    actionsRef.current.app.openConversation(null)
  }, [app.conversations, app.conversationsLoaded])

  /**
   * 面板级快捷键「关闭当前标签」（默认 Ctrl / ⌘ + W，可在「设置 → 快捷键」里改）。
   *
   * ## 为什么挂在 `PanelView` 上，而不是 app-shell 的全局分发器
   *
   * 关标签是**面板自己**的事（要读焦点组的活动标签、还要把「当前会话」对齐过去），而
   * app-shell 拿不到这些。`shortcuts.ts` 的 `PANEL_SCOPED_SHORTCUT_ACTIONS` 正是为这种
   * 动作准备的：全局分发器遇到它**直接放行、不拦截**（否则会先在捕获阶段把按键吃掉，这里
   * 永远收不到），由面板自己挂的 window 监听处理。副作用正好是想要的 —— 面板没挂出来时
   * 这组按键完全不被应用占用。
   *
   * ## 挂在 window 而不是面板根节点上
   *
   * 跟 `GitPanel` 的推送快捷键同一套理由：不要求标签条先聚焦 —— 焦点在内容区（会话正文 /
   * 终端）里也该关得掉当前标签。副作用是要自己多判两件事：
   * - 输入法组合中 / 长按重复不触发（与全局分发同一套判断）；
   * - 设置页正在**录制**快捷键时让路，否则在设置里录 `Ctrl+W` 会顺手把标签关掉
   *   （`isShortcutRecording`，app-shell 通过 `setShortcutRecording` 广播过来）。
   */
  const shortcuts = useShortcuts()
  const closeRef = useRef(closeAndSync)
  closeRef.current = closeAndSync
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.repeat) return
      if (isShortcutRecording()) return
      const hit = findShortcutByEvent(shortcuts, e)
      if (!hit || hit.action !== 'close-tab') return
      e.preventDefault()
      e.stopPropagation()
      // 面板空着时没有「当前标签」可关 —— 什么也不做，也不吞按键
      const key = activeTabKey()
      if (key) closeRef.current([key])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [shortcuts])

  /**
   * 回收工具标签的登记条目（`tool-tabs.ts`）：标签被关掉 / 被 `alignToTabs` 摘掉之后，
   * 那条元数据（工作目录、shell…）就该跟着没了。
   *
   * 集中在这里做，是因为「关标签」的路径不止一条（标签上的 ×、右键的关闭其他 / 左侧 /
   * 右侧 / 整个组、`alignToTabs` 的批量对齐）—— 每条都记得顺手清一次迟早会漏。
   */
  useEffect(() => {
    pruneToolTabs(allTabKeys(state))
    // 同一次回收里带上「刷新代号」：已关闭标签的代号留着也只是几个 map 条目，但重开同名
    // 标签（`local:1` / `api:<requestId>` 都可能复用 key）会莫名继承上一次的刷新状态
    pruneTabReloads(allTabKeys(state))
  }, [state])

  /**
   * 标签被关光 → **当前会话**退回空态（主区域由上面那个 `useLayoutEffect` 补一张草稿标签，
   * 所以这里不再产出「空态页面」，只负责选中态与落盘意图）。
   *
   * 关掉最后一个标签时 `panel-store` 会保留一个空组占位（布局树不能是 `null`），
   * 而「当前会话」还停在那条已经不存在的会话上。这里把它退回空态并持久化
   * `blankIntent`，刷新后不恢复旧会话。
   *
   * ⚠️ `hadTabsRef` 是必需的：挂载首帧的面板状态本来就是空的（`openTab` 的写入要到
   * 下一帧才可见），若不加这道闸，首次挂载（含 web 刷新进 `activeConversationId` 有值
   * 的情况）会被误判成「标签被关光了」而立刻把当前会话清掉。只有「**曾经有过标签**、
   * 现在没了」才算真的关光。
   */
  const hadTabsRef = useRef(false)
  useEffect(() => {
    const { app: a } = actionsRef.current
    if (allTabKeys(state).length > 0) {
      hadTabsRef.current = true
      return
    }
    if (!hadTabsRef.current) return
    if (activeConversationId === null) return
    a.openConversation(null)
  }, [state, activeConversationId])

  return (
    /*
     * `relative` 是内容层的定位基准：内容层 `absolute inset-0` 要正好盖住整个面板区，
     * 而每个标签的落位坐标是相对它的原点算的。
     */
    <div className="relative flex min-h-0 flex-1 flex-col rounded-lg overflow-hidden">
      {/* 布局骨架：只画组外壳（标签条 / 空态 / 落区），车身留成洞 */}
      <PaneNodeView node={state.layout} />
      {/* 内容层：全部标签在根部渲染一次，再摆到各自组的车身上（见组件注释） */}
      <PanelContentLayer state={state} />
    </div>
  )
}
