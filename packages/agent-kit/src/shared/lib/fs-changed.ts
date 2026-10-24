/**
 * 「工作区的文件被应用自己改动了」这条**本地**通知。
 *
 * ## 为什么要有它
 *
 * git 面板的改动列表原本只有两个触发点：面板变可见、面板自己的写操作跑完（见
 * `GitPanel.tsx` 的 `refresh`）。但「工作区文件」面板那一侧能做的事远不止保存 ——
 * 保存、复制、剪切/移动、新建文件、新建文件夹、删除，改的都是同一批文件，
 * git 面板却一个都不知道，只能等用户手动点刷新。
 *
 * 这里给这些操作一个统一的出口：改成功就 `notifyWorkspaceFsChanged` 喊一声，
 * 关心这个工作区的人（目前只有 git 面板）自己去刷。**只报「变了」不带内容**——
 * 变更清单的唯一真源永远是 `git status`，这里只是「什么时候该去问一次」的信使。
 *
 * ## 为什么不放在服务端做
 *
 * 工作区可能在**另一台机器**上（server 模式），浏览器的 `FileSystemWatcher` 之类
 * 根本够不着；而且服务端监听要额外引入 chokidar、还得排除 `.git` / `node_modules`。
 * 应用自己发起的改动走本地通知，零依赖、零延迟；外部工具改文件那种「无感知」的
 * 变更留给以后的服务端监听（或窗口重新聚焦时的兜底刷新）。
 *
 * ## 语义
 *
 * - 进程内的单例事件通道（与 `conversation-activity.ts` / `state-ws.ts` 同一种写法），
 *   不是 `window` 事件 —— 组件在 SSR / 测试环境里没有 window。
 * - `workspaceId` 为 `null` 表示「不知道来自哪个工作区」（自定义 `FilesSource`，
 *   比如流程节点的容器目录）。听者自己决定要不要理：git 面板按 id 过滤，
 *   `null` 一律忽略。
 */
export interface WorkspaceFsChange {
  /** 改动落在哪个工作区；null = 来源未知（见文件头） */
  workspaceId: string | null
  /** 什么操作干的：`write` / `create` / `mkdir` / `delete` / `copy` / `move` */
  kind: string
}

const listeners = new Set<(change: WorkspaceFsChange) => void>()

/** 喊一声「这个工作区的文件变了」。**只在操作成功后调**，失败别报。 */
export function notifyWorkspaceFsChanged(workspaceId: string | null, kind: string): void {
  // 先把监听者快照取出来：回调里退订 / 新增都不影响这一轮派发
  for (const listener of [...listeners]) listener({ workspaceId, kind })
}

/** 订阅文件变更通知；返回退订函数 */
export function subscribeWorkspaceFsChanged(
  cb: (change: WorkspaceFsChange) => void
): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}