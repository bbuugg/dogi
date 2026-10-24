/**
 * 插件框架的公共类型（纯类型，无运行时）。
 */
import type { Context } from './context'

/** 清理函数：`ctx.effect()` / `ctx.plugin()` 的返回值都长这样；可异步 */
export type Dispose = () => void | Promise<void>

/**
 * 对象形式的插件。
 *
 * - `name`：给人看的名字（日志 / 冲突报错里出现）；缺省用 `plugin`；
 * - `inject`：依赖的服务名清单。缺任何一项时**推迟挂载**，等那一项被 `ctx.set`
 *   提供出来再自动挂上（见 Context 的 pending 机制）——这样挂载顺序无关紧要；
 * - `apply`：真正干活的函数。返回值是「卸载时要跑的清理」，可省略。
 */
export interface PluginObject<C = unknown> {
  name?: string
  inject?: string[]
  apply(ctx: Context, config: C): void | Dispose
}

/** 函数形式的插件：等价于只有 `apply` 的对象插件 */
export type PluginFunction<C = unknown> = (ctx: Context, config: C) => void | Dispose

/**
 * 类形式的插件：`new Plugin(ctx, config)`，实例上若有 `dispose()` 会在卸载时调用。
 * 一般配合 `Service` 基类使用。
 */
export type PluginClass<C = unknown> = new (
  ctx: Context,
  config: C
) => { dispose?(): void | Promise<void> } | void

export type Plugin<C = unknown> = PluginObject<C> | PluginFunction<C> | PluginClass<C>

/** 事件监听器；`waterfall` 场景下最后一个参数是 `next` */
export type Listener = (...args: unknown[]) => unknown

// ---------- 发现 / 加载（镜像技能根的形态；纯类型，加载实现在子路径 loader） ----------

/** 插件来源根目录（内置、`<工作区>/.fizz/plugins`、`~/.fizz/plugins`） */
export interface PluginRoot<S extends string = string> {
  source: S
  dir: string
}

/**
 * 标准插件来源：
 * - `builtin`：**随产品分发**的内置插件根（`<仓库/安装目录>/plugins`，目录标记由宿主判定，
 *   见 `apps/server/src/server/builtin-dirs.ts`），
 *   对所有项目生效；开关在设置 →「插件」里（与用户级共用那一份全局启停）；
 * - `workspace`：`<工作区>/.fizz/plugins`，只对该项目生效，开关在项目「更多 → 插件」里；
 * - `user`：`~/.fizz/plugins`，所有项目生效，开关在设置 →「插件」里。
 */
export type StandardPluginSource = 'builtin' | 'workspace' | 'user'

/**
 * 插件目录里的 `plugin.json`（**唯一的接口判据**：没有它 / 字段不合格的目录不会被加载）。
 *
 * 一个插件 = 一个目录，入口由 manifest 的 `entry` 指定（不再支持单文件插件）。
 * `id` 是**稳定身份**：启停状态、设置值、模型配置 id 都按它记，改目录名不会失联。
 */
export interface PluginManifest {
  /** 全局唯一 id（`[A-Za-z0-9][A-Za-z0-9._-]*`，最长 64）；装插件时也用它做目录名 */
  id: string
  /** 展示名（设置页 / 报错里出现） */
  name: string
  /** 插件版本（semver，如 `1.0.0`） */
  version: string
  /** 宿主接口版本；当前只认 1 */
  apiVersion: number
  /** 入口源码（目录内相对路径，如 `index.ts` / `src/main.ts`） */
  entry: string
  /** 可选说明 */
  description?: string
  /** 可选作者 */
  author?: string
}

/** 扫描到的一个插件（一个目录 + 一份 manifest） */
export interface PluginCandidate<S extends string = string> {
  /** 插件 id = manifest.id（稳定；启停状态按它记） */
  id: string
  /** 给人看的名字 = manifest.name */
  name: string
  /** manifest 原文（发现阶段已校验） */
  manifest: PluginManifest
  /** 入口文件绝对路径（manifest.entry 解析后） */
  file: string
  /** 插件目录 */
  dir: string
  /** 来源根目录 */
  root: string
  source: S
}

/** 带配置与启停态的插件描述（API 返回给设置页的形状） */
export interface PluginDescriptor<S extends string = string> extends PluginCandidate<S> {
  /** 最终是否启用（plugins.yml 的 enabled + 用户设置合并后的结果） */
  enabled: boolean
  /** plugins.yml 里配给它的 config（原样透传） */
  config?: unknown
}

/** 插件启停偏好：**默认全启用**，`disabled` 里是被用户关掉的插件 id */
export interface PluginSettings {
  disabled: string[]
}

/**
 * 设置页展示用的**上传源摘要**：`UploadProviderRegistration` 里可以外传的那部分
 * （`put` / `resolveModelUrl` 这类函数留在宿主，不进 HTTP 响应）。
 *
 * 放在这个纯类型文件里而不是 `loader.ts`：前端要从包根入口 import type 它，
 * 而根入口刻意不导出 loader（那会把 jiti / fs 拖进浏览器产物）。
 */
export interface PluginUploadSourceInfo {
  id: string
  title: string
  acceptMime: string[]
  maxBytes?: number
}