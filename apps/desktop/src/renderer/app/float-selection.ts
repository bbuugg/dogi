/**
 * 浮窗的选中态与内容判定 —— 纯逻辑，无 React / Electron 依赖，可单测。
 *
 * 浮窗展示「一条会话」或「某个项目的新建会话页（草稿）」二选一：
 * `conversationId === null` 即草稿页（对应主界面的「新对话」标签）。
 */

/** 当前浮窗选中的内容：某项目下的某条会话，或该项目的草稿页（conversationId === null） */
export type FloatSelection = {
  projectId: string | null
  conversationId: string | null
}

/** 内容区该渲染什么 */
export type FloatContentKind = 'loading' | 'empty' | 'missing' | 'conversation' | 'draft'

/**
 * 首次打开时的初始选中：
 * - 有种子会话 → 选中它（项目取它会话自己的 workspace；会话列表还没加载时兜底用 activeWorkspaceId）；
 * - 没有种子 → 落在 activeWorkspaceId 的草稿页（新对话）。
 */
export function initialSelection(
  initialConversationId: string | undefined,
  conversations: ReadonlyArray<{ id: string; workspaceId: string }>,
  activeWorkspaceId: string | null
): FloatSelection {
  if (!initialConversationId) return { projectId: activeWorkspaceId, conversationId: null }
  const seed = conversations.find((c) => c.id === initialConversationId)
  return {
    projectId: seed?.workspaceId ?? activeWorkspaceId,
    conversationId: initialConversationId
  }
}

/** 选中一条会话（项目跟着它走） */
export function selectConversation(
  _sel: FloatSelection,
  conversationId: string,
  workspaceId: string
): FloatSelection {
  return { projectId: workspaceId, conversationId }
}

/** 选中一个项目 → 进它的草稿页（新对话） */
export function selectProject(_sel: FloatSelection, projectId: string): FloatSelection {
  return { projectId, conversationId: null }
}

/**
 * 草稿页发出第一条消息后，浮窗要不要跟过去。
 *
 * 主界面那层由 `PanelView` 监听**真实**的 `activeConversationId`、把「新对话」占位标签
 * 就地替换成新会话来完成切换；浮窗没有标签层，草稿态传进 `useAgentAppView` 的恒是 `null`，
 * 不主动跟过去就会一直停在「新建会话」页 —— 现象就是「消息发出去了却没切过去」。
 *
 * 只在**当前是草稿**（`conversationId === null`）时跟随：已经在看某条会话时，
 * 活跃会话的变化不该把它顶走。返回 `null` = 不切。
 */
export function adoptSentConversation(
  sel: FloatSelection,
  activeConversationId: string | null,
  conversations: ReadonlyArray<{ id: string; workspaceId: string }>
): FloatSelection | null {
  if (sel.conversationId !== null || !activeConversationId) return null
  const conv = conversations.find((c) => c.id === activeConversationId)
  // 会话清单理论上已含它（`newConversation` 同一次 set 里就插进去了）；万一还没到，
  // 项目先沿用草稿那份，会话 id 照样跟过去。
  return { projectId: conv?.workspaceId ?? sel.projectId, conversationId: activeConversationId }
}

/**
 * 内容区判定。顺序即优先级：
 * 列表没加载完 → loading（**绝不**提前判 missing，否则会闪一下「已不存在」）；
 * 没有项目 → empty；没选会话 → draft；选中的会话已不在 → missing；否则 conversation。
 */
export function resolveContentKind(
  sel: FloatSelection,
  env: { conversationsLoaded: boolean; hasProjects: boolean; conversationExists: boolean }
): FloatContentKind {
  if (!env.conversationsLoaded) return 'loading'
  if (!env.hasProjects) return 'empty'
  if (sel.conversationId === null) return 'draft'
  if (!env.conversationExists) return 'missing'
  return 'conversation'
}

/** 列表里的一条会话（只取展示需要的字段） */
export type FloatConversation = {
  id: string
  title: string
  workspaceId: string
  /** 归档时间（epoch 毫秒，与 `AgentConversation.archivedAt` 同口径）；有值 = 已归档，不进浮窗列表（浮窗没有「已归档」分区可放） */
  archivedAt?: number
}
/** 列表里的一个项目（`path` 缺席 = 任务 / 项目助手那类虚拟工作区，不列出来） */
export type FloatWorkspace = { id: string; name: string; path?: string; scratch?: boolean }
/** 列表里的一组：一个项目 + 它的会话（合成组 = 临时会话） */
export type FloatProjectGroup = {
  id: string
  name: string
  synthetic: boolean
  conversations: FloatConversation[]
}

/** 合成组的 id：临时会话不属于任何**项目**，但仍要有地方挂（不是真实工作区 id） */
const SCRATCH_GROUP_ID = '__scratch__'
const SCRATCH_LABEL = '临时会话'

/**
 * 把工作区 / 会话整理成列表分组，口径与 `AgentSidebar` 一致：
 * - **丢掉没有 `path` 的虚拟工作区**（「任务」「项目助手」—— 别的选择器都不列它们，
 *   列出来点进去会进一个没有目录的草稿）；
 * - **丢掉临时工作区**（`scratch`：没选项目发消息时自动建的 `conversations/<会话 id>`），
 *   它们的会话改收进末尾那个合成的「临时会话」组 —— 一条会话一个 uuid 目录，
 *   摆成项目行会把列表淹掉；
 * - **丢掉已归档的会话**：浮窗没有「已归档」分区，留着的话刚点完「归档」那行还在，
 *   看着像没生效（主侧栏那边是收进「已归档」区）。
 */
export function floatProjectGroups(
  workspaces: ReadonlyArray<FloatWorkspace>,
  conversations: ReadonlyArray<FloatConversation>
): FloatProjectGroup[] {
  const groups: FloatProjectGroup[] = workspaces
    .filter((w) => !!w.path && !w.scratch)
    .map((w) => ({
      id: w.id,
      name: w.name,
      synthetic: false,
      conversations: conversations.filter((c) => c.workspaceId === w.id && !c.archivedAt)
    }))
  const scratchIds = new Set(workspaces.filter((w) => w.scratch).map((w) => w.id))
  const scratch = conversations.filter((c) => scratchIds.has(c.workspaceId) && !c.archivedAt)
  if (scratch.length > 0) {
    groups.push({
      id: SCRATCH_GROUP_ID,
      name: SCRATCH_LABEL,
      synthetic: true,
      conversations: scratch
    })
  }
  return groups
}

/** 顶部中央的项目名：命中项目取名字；临时会话组取固定文案；都没选 → 提示选项目 */
export function projectDisplayName(
  workspaces: ReadonlyArray<FloatWorkspace>,
  projectId: string | null
): string {
  if (projectId === SCRATCH_GROUP_ID) return SCRATCH_LABEL
  const ws = workspaces.find((w) => w.id === projectId)
  // 临时工作区（不选项目发消息时自动建的，名字就是会话目录名）：顶栏显示「临时会话」，
  // 与列表里那个合成组同名，别把一串目录名顶在中间。
  if (ws?.scratch) return SCRATCH_LABEL
  return ws?.name ?? '选择项目'
}
