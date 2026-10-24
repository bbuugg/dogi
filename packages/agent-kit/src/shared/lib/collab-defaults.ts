/**
 * 新建「多智能体协作」会话时的默认班子：一个调研、一个审查。
 *
 * 侧栏「多智能体协作」现在是**点一下直接建会话**（不再弹窗选模型 / 配班子），
 * 这一份就是初始配置；用户建好后可以在协作画布上改成员 / 角色 / 工具
 * （`CollabWorkspace` 的 `saveCollabSettings`）。
 *
 * 位置按画布的两行两列摆好（40 / 410 两列），免得新会话一打开两个节点叠在一起。
 * 接线默认是「主智能体 → 每个子 Agent」（两条线），与加拓扑之前的行为一致。
 */
import {
  COLLAB_MAIN_ID,
  DEFAULT_COLLAB_SETTINGS,
  createCollabAgent,
  type CollabSettings
} from '@fizz/contracts/types'

export function defaultCollabSettings(): CollabSettings {
  const agents = [
    createCollabAgent({
      name: '调研员',
      role: '检索代码与文档，给出带文件 / 行号出处的结论',
      tools: ['read_file', 'list_files', 'search_files', 'find_files', 'web_fetch'],
      position: { x: 40, y: 190 }
    }),
    createCollabAgent({
      name: '审查员',
      role: '审查方案与改动，找风险、遗漏与不一致',
      tools: ['read_file', 'list_files', 'search_files', 'find_files'],
      position: { x: 410, y: 190 }
    })
  ]
  return {
    ...DEFAULT_COLLAB_SETTINGS,
    agents,
    edges: agents.map((agent) => ({
      id: `${COLLAB_MAIN_ID}->${agent.id}`,
      source: COLLAB_MAIN_ID,
      target: agent.id
    }))
  }
}
