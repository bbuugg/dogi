/**
 * 通用可折叠分区（见 components/StackedSections.tsx）的稳定 id。
 *
 * 它同时是折叠状态的 key（存于 `ui.collapsedSections`），所以必须全局唯一：
 * 约定用「所属功能区.分区名」，避免不同页面的同名分区互相串状态。
 *
 * 与 activity-ids.ts 同样放在这个「叶子模块」（不 import 任何东西）是为了避免循环依赖：
 * 分区 id 会被多个面板组件引用，定义在任一组件里都可能形成
 * HostsPanel → Section → HostsPanel 的环。
 */

/** 主机功能区内：主机列表分区 */
export const HOSTS_LIST_SECTION_ID = 'hosts.list'

/** 主机功能区内：脚本列表分区（脚本只服务于主机，所以挂在主机侧边栏下半区） */
export const HOSTS_SCRIPTS_SECTION_ID = 'hosts.scripts'
