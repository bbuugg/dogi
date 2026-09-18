/**
 * 功能区 id 常量与插件功能区 id 的拼装规则。
 *
 * 单独放在这个「叶子模块」（不 import 任何东西）是为了避免循环依赖：
 * activities.tsx 需要 import 各面板组件，而面板组件又要引用功能区 id
 * （例如面板里的「返回终端」），若 id 定义在 activities.tsx 就会形成
 * HostsPanel → activities → HostsPanel 的环，求值顺序不巧时注册表拿到的
 * 会是尚未初始化的组件。所以 id 与规则下沉到这里。
 */
export const HOSTS_ACTIVITY_ID = 'hosts'
export const SCRIPTS_ACTIVITY_ID = 'scripts'
export const PLUGINS_ACTIVITY_ID = 'plugins'
export const NOTES_ACTIVITY_ID = 'notes'

/** 插件贡献的功能区 id 前缀：plugin:<viewId> */
export const PLUGIN_ACTIVITY_PREFIX = 'plugin:'

/** 插件视图 id → 功能区的快捷转换 */
export function pluginActivityId(viewId: string): string {
  return PLUGIN_ACTIVITY_PREFIX + viewId
}

/** 功能区 id → 插件视图 id（不是插件功能区则返回 null） */
export function pluginViewIdOf(activityId: string): string | null {
  return activityId.startsWith(PLUGIN_ACTIVITY_PREFIX)
    ? activityId.slice(PLUGIN_ACTIVITY_PREFIX.length)
    : null
}