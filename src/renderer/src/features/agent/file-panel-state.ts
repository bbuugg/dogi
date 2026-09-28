/**
 * 文件面板的**按工作区**状态：打开着哪些文件标签、当前是哪一个。
 *
 * 为什么需要这一层：面板挂在 AgentPage 里，而 `workspaceId` 会随侧边栏选中的工作区变化 ——
 * 状态若只存在组件里，切走再切回来就全丢了（标签、未保存的改动一起没）。所以按工作区
 * 各留一份，切回来照旧。
 *
 * 为什么放**模块级 Map** 而不是 app-store：
 * - 它是纯界面的临时状态（「这个工作区开着哪些文件」），不值得落盘 —— 重启应用后从磁盘
 *   重开是合理行为；
 * - 模块级缓存还能扛住组件卸载：关掉会话标签再开回来，标签仍在。
 *
 * ⚠️ 每个快照**自带 `workspaceId`**。切换工作区时 props 先变、state 后跟，中间那一帧是
 * 「B 的工作区 + A 的标签」；快照带着自己的 id，就不可能把 A 的标签写进 B 名下
 * （写入一律用快照自己的 id 当 key，见 `writePanelState`）。
 */
import type { PreviewKind } from '@shared/workspace-media'

/**
 * 一个已打开的文件。**每个标签一份自己的状态**（内容 / 已落盘内容 / 形态 …），
 * 所以切换标签不会丢改动 —— 这也是文件面板从「单文件」改成「多标签」的关键：
 * 旧实现只有一个 `content/savedContent`，一换文件就得弹「改动会丢失」的确认框。
 */
export interface OpenFile {
  /** 相对工作区根的路径，同时是标签的 key */
  path: string
  /** 预览类型（null = 普通文本；见 @shared/workspace-media） */
  kind: PreviewKind | null
  /** 预览 / 编辑（只有 svg 两种都行，其余按类型固定） */
  mode: 'preview' | 'edit'
  content: string
  /** 上次落盘的内容：和 content 比对得出「未保存」 */
  savedContent: string
  /** 读文件失败的原因（太大 / 权限 / 其实是二进制），摆在编辑区里 */
  loadError: string | null
  /** 还在读：读完之前编辑区是只读的 */
  loading: boolean
}

/** 某个工作区的面板状态（自带 id，见文件头注释） */
export interface PanelState {
  workspaceId: string
  /** 已打开的文件（顺序即标签顺序，新开的排在末尾） */
  files: OpenFile[]
  /** 当前活动标签的路径（null = 一个都没打开） */
  activeFilePath: string | null
}

const cache = new Map<string, PanelState>()

/** 取某个工作区的快照；没有就返回一份空的（空快照**不写入**缓存 —— 写只发生在真改过之后） */
export function readPanelState(workspaceId: string): PanelState {
  return cache.get(workspaceId) ?? { workspaceId, files: [], activeFilePath: null }
}

/** 存回快照：key 一律用**快照自己的** workspaceId，避免张冠李戴 */
export function writePanelState(state: PanelState): void {
  cache.set(state.workspaceId, state)
}

/**
 * 交给 Monaco 的**虚拟路径**（不是真实文件系统路径）：`@monaco-editor/react` 按它给每个
 * 文件分配一个独立 model，于是撤销栈与光标 / 滚动位置在标签之间互不串台。
 *
 * 前缀带上 workspaceId：同一个相对路径在**另一个工作区**是完全不同的文件，若共用一个 URI，
 * Monaco 会复用同一个 model（撤销栈里留着别的项目的编辑）。
 */
export function modelUri(workspaceId: string, path: string): string {
  return `${modelUriPrefix(workspaceId)}${path}`
}

/** 上面那批 model 的统一前缀（回收时按它筛出「属于这个工作区」的 model） */
export function modelUriPrefix(workspaceId: string): string {
  return `file:///${workspaceId}/`
}

/**
 * `modelUri` 的逆运算：从 Monaco 内容事件带回来的 URI 取回相对路径。
 *
 * 用途见 `AgentFilesPanel`：切换文件时内容事件可能由**上一次订阅**的闭包送回来（见
 * `MonacoEditor` 的 `handleEditorChange`），目标必须以事件自带的 URI 为准 —— 它才是
 * 「这次改动属于哪个文件」的唯一身份。不属于这个工作区的 model（或没拿到 URI）返回 null。
 */
export function pathFromModelUri(workspaceId: string, uri: string | undefined): string | null {
  if (!uri) return null
  const prefix = modelUriPrefix(workspaceId)
  return uri.startsWith(prefix) ? uri.slice(prefix.length) : null
}
