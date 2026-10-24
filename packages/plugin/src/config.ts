/**
 * Cordis 风格的 `plugins.yml` 配置加载器。
 *
 * 文件形态（两种写法，二选一）：
 *
 * ```yaml
 * # 列表式（推荐：能写 enabled / 名字等更多字段）
 * plugins:
 *   - module: ./plugins/hello
 *     config: { greeting: 你好 }
 *   - module: ./plugins/lint-hook
 *     enabled: false
 *
 * # 映射式（更紧凑：键是 module，值是 config）
 * plugins:
 *   ./plugins/hello:
 *     greeting: 你好
 * ```
 *
 * 这里**只做解析与校验**：把 yml 读成规整的 `PluginEntry[]`。
 * 「按 module 去解析 / 动态 import 出真正的插件对象」是发现加载器的事（见 P2），
 * 让本文件保持零运行时依赖（除 yaml 解析外），也便于单测。
 */
/// <reference path="./vendor.d.ts" />
import { promises as fs } from 'node:fs'
import { load as parseYaml } from 'js-yaml'

export interface PluginEntry {
  /** 模块定位串：插件目录的相对路径（`./plugins/x`），也兼容指向入口文件的写法 */
  module: string
  /** 原样透传给插件的配置 */
  config?: unknown
  /** 缺省 true；显式 false = 不加载（留在文件里便于随时开关） */
  enabled?: boolean
}

function fail(message: string): never {
  throw new Error(`plugins.yml 格式错误：${message}`)
}

/** 把一项映射式配置（键 = module）转成规整条目 */
function fromMap(module: string, value: unknown): PluginEntry {
  if (value === null || value === undefined) return { module }
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(`「${module}」的值必须是对象（即该插件的 config）`)
  }
  return { module, config: value }
}

/**
 * 解析 `plugins.yml` 文本。空文件 / 没有 `plugins` 键 = 没有任何插件（返回空数组）。
 * 结构不对时抛**可读**的错误（带条目下标），不静默跳过 —— 配置写错要立刻知道。
 */
export function parsePluginsYaml(text: string): PluginEntry[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  let doc: unknown
  try {
    doc = parseYaml(trimmed)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
  if (doc === null || doc === undefined) return []
  if (typeof doc !== 'object' || Array.isArray(doc)) fail('顶层必须是一个对象（含 `plugins` 键）')

  const plugins = (doc as Record<string, unknown>).plugins
  if (plugins === undefined || plugins === null) return []

  if (Array.isArray(plugins)) {
    return plugins.map((raw, i) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        fail(`plugins[${i}] 必须是对象`)
      }
      const item = raw as Record<string, unknown>
      const module = item.module
      if (typeof module !== 'string' || !module.trim()) {
        fail(`plugins[${i}] 缺少非空的 module 字段`)
      }
      const entry: PluginEntry = { module: module.trim() }
      if ('config' in item) entry.config = item.config
      if (item.enabled !== undefined) {
        if (typeof item.enabled !== 'boolean') fail(`plugins[${i}].enabled 必须是布尔值`)
        entry.enabled = item.enabled
      }
      return entry
    })
  }

  if (typeof plugins === 'object') {
    return Object.entries(plugins as Record<string, unknown>).map(([module, value]) =>
      fromMap(module, value)
    )
  }

  fail('`plugins` 必须是数组或对象')
}

/** 读取并解析一个 `plugins.yml` 文件；文件不存在 = 没有插件（返回空数组，不报错） */
export async function readPluginsFile(file: string): Promise<PluginEntry[]> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return parsePluginsYaml(text)
}