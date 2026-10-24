/**
 * 「给某个项目创建会话」的服务端实现 —— 经 `buildProjectTools` 的 deps 注入给
 * `create_conversation` 工具（`packages/tools` 不 import 领域包 / 服务端模块，
 * 见 project-tools.ts 头部的分层说明）。
 *
 * 只建**内置 Agent（mastra）**会话：ACP 会话创建时要先与外部 agent `session/new`
 * （还会 spawn 进程、失败要回收），那是界面「新建会话」弹窗的流程，不走工具这条路 ——
 * 工具描述里也写明这一点，模型不会用它去建 ACP 会话。
 *
 * 列表刷新不需要前端埋点：`saveConversation` → `store.mutate` → `makeLiveStore`
 * 自动标脏 → state-ws 推 `conversations` 快照，侧栏自己更新。
 */
import { domain } from './state'

/** 工具入参（与 @fizz/tools 的 ConversationCreateInput 同形，这里不引工具包免得反向依赖） */
export interface ProjectConversationInput {
  workspaceId: string
  title?: string
}

export interface ProjectConversationResult {
  id: string
  title: string
  workspaceId: string
}

/**
 * 建一个空会话（不发送任何消息）并返回其坐标。
 *
 * @param defaultTarget 新会话默认绑定的模型。调用方把自己**正在用的那一份**传进来：
 *   助手传当前选的模型，普通会话传本轮的配置 + 模型。缺省（ACP 会话里调到时）就不绑 ——
 *   会话能建、能开，但发送前要在输入框上方选一个模型（`chat-turn` 的严格解析会给人话，
 *   不静默回退，所以这里也不替用户猜一个）。
 */
export function createProjectConversation(
  input: ProjectConversationInput,
  defaultTarget?: { configId: string; modelId: string }
): ProjectConversationResult {
  const workspace = domain.getWorkspace(input.workspaceId)
  if (!workspace) {
    throw new Error(`项目不存在：${input.workspaceId}（先用 list_projects 拿项目 id）`)
  }
  // 目标模型悬空（配置 / 模型被删了）就现在报错，别建出一个发不出消息的会话
  if (defaultTarget) domain.resolveModelConfig(defaultTarget.configId, defaultTarget.modelId)
  const created = domain.saveConversation({
    workspaceId: workspace.id,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    backend: 'mastra',
    ...(defaultTarget ? { configId: defaultTarget.configId, modelId: defaultTarget.modelId } : {})
  })
  return { id: created.id, title: created.title, workspaceId: created.workspaceId }
}
