/**
 * 插件系统共享类型。
 *
 * 设计目标：支持「运行时从本地 plugins 目录加载外部插件」，manifest 声明权限，
 * 宿主（主进程 + 渲染端）按权限放行宿主能力。v1 不含应用市场/签名校验，
 * 但 loader 与权限模型已为后续扩展留好位置。
 */

/** 插件可向宿主申请的权限（宿主按权限放行对应能力） */
export type PluginPermission = 'http' | 'storage' | 'fs'

export interface PluginManifest {
  /** 唯一 id（同 id 视为同一插件，主进程 handler 以 id 命名空间隔离） */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 侧边栏/视图图标：emoji 或字符即可（避免插件依赖我们的图标库） */
  icon?: string
  /** 渲染端入口（相对插件目录的 ESM 源码文件名），缺省则该插件无 UI */
  renderer?: string
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
