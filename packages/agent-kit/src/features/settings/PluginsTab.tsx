/**
 * 设置 →「插件」：**全局（用户级）插件**的管理页。
 *
 * 只管 `~/.fizz/plugins` 那一份，启停存服务端全局一份、与项目无关 —— 用户级插件对所有
 * 项目生效，开关自然也该是全局的。**项目自己的插件**由各项目的「更多 → 插件」弹窗管
 * （见 `features/projects/PluginsDialog`），两个面刻意不混。
 *
 * 内容本体是与项目弹窗共用的 `shared/components/PluginsPanel`（同一份列表 / 启停逻辑），
 * 这里只把作用域定死成 `global`。
 */
import { PluginsPanel } from '@fizz/agent-kit/shared/components/PluginsPanel'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export function PluginsTab({ app }: { app: AgentApp }) {
  return <PluginsPanel app={app} scope="global" />
}
