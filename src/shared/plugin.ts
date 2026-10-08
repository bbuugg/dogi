/**
 * 插件系统共享类型。
 *
 * 设计目标：支持「运行时从本地 plugins 目录加载外部插件」，manifest 声明权限，
 * 宿主（主进程 + 渲染端）按权限放行宿主能力。v1 不含应用市场/签名校验，
 * 但 loader 与权限模型已为后续扩展留好位置。
 */

/**
 * 插件可向宿主申请的权限（宿主按权限放行对应能力）
 *
 * - `http`：发起网络请求；
 * - `storage`：读写插件自己的持久化分区；
 * - `fs`：读写文件；
 * - `hooks`：挂 **AI 工具钩子**（`tool:call` 可在工具执行前拦截，`tool:result` 可改写结果）。
 *   单独列一个权限是刻意的 —— 它能**改变 AI 实际做了什么**（拦下一条命令 / 换掉工具看到的结果），
 *   比前三个都敏感，用户装插件时应该一眼看到。
 */
export type PluginPermission = 'http' | 'storage' | 'fs' | 'hooks'

/**
 * 插件可以挂的 AI 工具钩子。
 *
 * `tool:call`（执行**前**）—— 入参 `PluginToolCallEvent`，可返回 `{ block, reason }`：
 * 任何插件拦下这一条，工具就不再执行，`reason` 原样作为工具结果回给模型
 * （同 `guardWrite` 的拒绝语义：**不抛错**，模型能据此换个做法）。
 *
 * `tool:result`（执行**后**）—— 入参 `PluginToolResultEvent`，可返回 `{ result }` 改写结果
 * （字符串才算，其它返回值忽略）。用来做脱敏、给结果补上下文之类。
 *
 * ⚠️ 钩子**必须**是「出错/超时就当没挂」：插件崩了绝不能把整轮对话拖死 ——
 * 宿主侧统一 try/catch + 超时，插件作者不必自己兜底（但也别指望钩子一定跑得到）。
 */
export type PluginHookEvent = 'tool:call' | 'tool:result'

/** `tool:call` 钩子的入参 */
export interface PluginToolCallEvent {
  toolName: string
  input: unknown
  conversationId: string
  scope: 'workspace' | 'terminal'
  /** workspace 作用域下的工作区目录（terminal 为 undefined） */
  workspacePath?: string
}

/** `tool:call` 钩子的返回值 */
export interface PluginToolCallVerdict {
  /** true = 拦下这一条工具调用 */
  block?: boolean
  /** 拦下的原因（会原样作为工具结果回给模型，所以写给人看的话） */
  reason?: string
}

/** `tool:result` 钩子的入参 */
export interface PluginToolResultEvent {
  toolName: string
  input: unknown
  result: unknown
  conversationId: string
  scope: 'workspace' | 'terminal'
}

/** `tool:result` 钩子的返回值：给 `result` 就替换（仅字符串生效） */
export interface PluginToolResultVerdict {
  result?: string
}

/**
 * 渲染端入口：插件目录内的 ESM 源码文件名。
 * 宿主读取源码后用 blob import 执行，插件在运行时通过 `activate(api)` 注册视图。
 */
export type PluginRenderer = string

export interface PluginManifest {
  /** 唯一 id（同 id 视为同一插件，主进程 handler 以 id 命名空间隔离） */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 侧边栏/视图图标：emoji 或字符即可（避免插件依赖我们的图标库） */
  icon?: string
  /** 渲染端入口（插件目录内的 ESM 源码文件名），缺省则该插件无 UI */
  renderer?: PluginRenderer
  /** 主进程入口（相对插件目录的 ESM 文件名），缺省则该插件无主进程逻辑 */
  main?: string
  /** 声明需要的宿主权限；未声明的能力调用会被宿主拒绝 */
  permissions?: PluginPermission[]
}

/** 管理页使用的插件信息：manifest + 启用状态 + 加载错误 */
export interface PluginInfo extends PluginManifest {
  /** 是否启用（禁用后不加载主进程入口、不在侧边栏显示视图） */
  enabled: boolean
  /** 加载（主进程入口）错误信息，无错误则缺省 */
  error?: string
}

/** 渲染端向宿主发起的 HTTP 请求入参 */
export interface PluginHttpRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  /** 跳过 TLS 证书校验（自签证书）；需要 http 权限 */
  rejectUnauthorized?: boolean
  /** 代理地址，如 http://127.0.0.1:7890；需要 http 权限 */
  proxy?: string
  /** 超时（毫秒） */
  timeoutMs?: number
}

export interface PluginHttpResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  /** 耗时（毫秒） */
  timeMs: number
  /** 失败时的错误信息 */
  error?: string
}
