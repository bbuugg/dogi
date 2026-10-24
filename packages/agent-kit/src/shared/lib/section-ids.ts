/**
 * 各侧栏**分区**的身份声明，供 `shared/components/StackedSections.tsx` 使用。
 *
 * spec 现在是拖拽高度的 key（见 `shared/lib/sidebar-sections.ts`），所以 id
 * **必须全局唯一**：约定用「所属功能区.分区名」，避免不同面板的同名分区互相串高度。
 *
 * 分区**不再可折叠**（标题只是一行静态标签），所以这里也没有「默认收起」了 ——
 * 只保留 id 这一件事。
 *
 * 单独放这个「叶子模块」（不 import 任何运行时东西）是为了避免循环依赖：分区 spec 会被
 * 面板与它里面的子面板同时引用，定义在任一组件里都可能形成
 * `HostsSidebar → 某个子面板 → HostsSidebar` 那样的环。
 * 下面那句 `import type` 是纯类型引用（编译期擦除），不影响这一点。
 */
import type { SectionSpec } from '@fizz/agent-kit/shared/lib/sidebar-sections'

/** 主机功能区内：主机 / 终端那块内容组所在的**唯一**分区（脚本已经搬去主区域标签页了） */
export const HOSTS_LIST_SECTION: SectionSpec = { id: 'hosts.list' }

/** 接口请求功能区内：**唯一**分区（请求组 + 历史记录组） */
export const API_REQUESTS_SECTION: SectionSpec = { id: 'api.requests' }

/*
  ⚠️ 「请求历史」已经从**分区**降级为 `API_REQUESTS_SECTION` 里的第二块内容组
  （请求 → 历史记录，共用一个滚动区、不分高度、不可拖），所以它不再需要身份。
  原先的 `api.history` 就是这个 key —— 别再把它加回来：一个 spec 等于一个可拖高度的
  key，而整块已经不可拖（与 AI Agent 侧栏「已归档 / 定时任务」降级时同一个道理，
  见本文件末尾那段）。
*/

/** AI Agent 功能区内：项目树（会话 / 流程都挂在各自项目下） */
export const AGENT_PROJECTS_SECTION: SectionSpec = { id: 'agent.projects' }

/**
 * 笔记功能区内：登记的笔记根目录 + 其中的 Markdown 树。
 *
 * 只有这一个分区（笔记的形态很单纯：一堆根、每个根一棵树），所以不设 `grow` / `minHeight`
 * —— 它自己就把侧栏剩下的高度全占了。
 */
export const NOTES_ROOTS_SECTION: SectionSpec = { id: 'notes.roots' }

/*
  ⚠️ AI Agent 侧栏只有 `AGENT_PROJECTS_SECTION` 一个分区。
  「已归档」与「定时任务」已经从分区降级为这个分区里的**两块内容**
  （项目树 → 已归档 → 定时任务，共用一个滚动区、不分高度、不可拖），
  它们不再需要身份 —— 别再给它们补 spec：一个 spec 等于一个可拖高度的 key，
  而整块已经不可拖（见 `docs/lessons/ui.md` §92）。
*/
