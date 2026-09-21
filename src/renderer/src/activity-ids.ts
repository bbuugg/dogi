/**
 * 功能区 id 常量。
 *
 * 单独放在这个「叶子模块」（不 import 任何东西）是为了避免循环依赖：
 * activities.tsx 需要 import 各面板组件，而面板组件又要引用功能区 id
 * （例如面板里的「返回终端」），若 id 定义在 activities.tsx 就会形成
 * HostsPanel → activities → HostsPanel 的环，求值顺序不巧时注册表拿到的
 * 会是尚未初始化的组件。所以 id 下沉到这里。
 *
 * 插件不贡献功能区：安装的插件不再往活动栏挂条目，插件视图只在 PanelView
 * 里以标签页形式打开（入口是插件管理面板的「打开」按钮）。
 */
export const HOSTS_ACTIVITY_ID = 'hosts'
export const SCRIPTS_ACTIVITY_ID = 'scripts'
export const NOTES_ACTIVITY_ID = 'notes'
export const API_ACTIVITY_ID = 'api'
export const PLUGINS_ACTIVITY_ID = 'plugins'
export const AGENT_ACTIVITY_ID = 'agent'