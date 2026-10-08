/**
 * 「这个工作区的文件被应用自己改动了」这条**进程内**通知。
 *
 * 移植自 fishwork 的 `packages/agent-ui/src/lib/fs-changed.ts`。
 *
 * ## 为什么要有它
 *
 * git 面板的改动列表的触发点只有三处：工作区变化、面板自己的写操作跑完、Agent 跑完一轮。
 * 但**文件面板**那一侧能做的事远不止保存 —— 保存、复制、剪切 / 移动、新建文件、
 * 新建文件夹、删除，改的都是同一批文件，git 面板却一个都不知道，只能等用户手动点刷新
 * （现象：在文件视图里改完文件，切到源代码管理还是旧的改动列表）。
 *
 * 这里给这些操作一个统一的出口：改成功就喊一声，关心这个工作区的人（目前只有 git 面板）
 * 自己去刷。**只报「变了」不带内容** —— 变更清单的唯一真源永远是 `git status`，
 * 这里只是「什么时候该去问一次」的信使。
 *
 * ## 为什么不放主进程做文件监听
 *
 * 外部工具（用户的编辑器、构建产物）改文件那种变更同样值得刷新，但监听要么引 chokidar、
 * 要么在渲染端轮询；先把**应用自己发起的**改动这条零依赖、零延迟的路打通。
 * 外部变更由「窗口重新聚焦时刷新」（见 GitPanel）兜一层。
 *
 * ## 语义
 *
 * 进程内单例事件通道（不是 `window` 事件）。`workspaceId` 为 `null` 表示「不知道来自哪个
 * 工作区」，听者自己决定要不要理：git 面板按 id 过滤，`null` 一律忽略。
 */
export interface WorkspaceFsChange {
  /** 改动落在哪个工作区；null = 来源未知 */
  workspaceId: string | null
  /** 什么操作干的：`write` / `create` / `mkdir` / `delete` / `copy` / `move` */
  kind: string
}

type Listener = (change: WorkspaceFsChange) => void

const listeners = new Set<Listener>()

/** 喊一声「这个工作区的文件变了」。**只在操作成功后调**，失败别报。 */
export function notifyWorkspaceFsChanged(workspaceId: string | null, kind: string): void {
  // 先把监听者快照取出来：回调里退订 / 新增都不影响这一轮派发
  for (const listener of [...listeners]) listener({ workspaceId, kind })
}

/** 订阅文件变更通知；返回退订函数 */
export function subscribeWorkspaceFsChanged(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
