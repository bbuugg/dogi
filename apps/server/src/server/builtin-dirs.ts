/**
 * 「随产品分发」的目录在哪儿：**内置插件根**（`plugins/`）与**内置技能根**（`skills/`）。
 *
 * ## 为什么需要探测
 *
 * 这两个根都躺在仓库里（要提交进 git）、跟着安装包分发，得在三种运行形态下都能找到：
 * - **开发 / 自建 server**：`process.cwd()` 就是仓库根（`node apps/server/dist/index.js`）；
 * - **桌面端（打包后）**：cwd 不可靠，目录由 electron-builder 的 `extraResources` 放进
 *   `process.resourcesPath`；
 * - **从子目录启动**：从 cwd 逐级往上找若干层。
 *
 * ## 判据是**标记文件**，不是目录名
 *
 * 「一个叫 plugins / skills 的目录」在谁的机器上都可能有 —— 只按名字判，宿主可能把某个无关
 * 目录当成内置根，然后去加载它里面的 `.ts` / `SKILL.md`。所以只认带标记文件的目录：
 * `builtin-plugins.json` / `builtin-skills.json`（同时它们也是给人看的说明文件）。
 *
 * `<envVar>` 可显式指定（**认，不要求标记**：显式意图优先）；指一个不存在的路径 =
 * 这台机器没有这个内置根（验证脚本靠它把自己与仓库里的内置内容隔离）。
 *
 * ⚠️ 路径探测刻意留在**服务端**，不进 `@fizz/plugin` / `@fizz/skills`：库不应该猜自己跑在哪
 * （两个库的 `standard*Roots` 只收 `builtinDir` 这种参数），否则每个 import 它们的测试进程
 * 都会莫名扫到仓库里的内置内容。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 内置插件根的标记文件名（见 `plugins/builtin-plugins.json`） */
export const BUILTIN_PLUGINS_MARKER = 'builtin-plugins.json'
/** 内置技能根的标记文件名（见 `skills/builtin-skills.json`） */
export const BUILTIN_SKILLS_MARKER = 'builtin-skills.json'

/** 内置插件根相对「仓库根 / resources 目录」的子路径（也是环境变量名后缀） */
const PLUGINS_SUBDIR = 'plugins'
const SKILLS_SUBDIR = 'skills'

/** 从 cwd 往上找多少层（覆盖「从 apps/server 之类子目录启动」的情形） */
const MAX_WALK_UP = 8

/**
 * 缓存的探测结果（key = 标记 + 环境变量名）。进程内环境变量不会变，而一次探测有近十次
 * `fs.existsSync`，而这些根每轮对话都会被问一次。
 */
const cache = new Map<string, string | null>()

/**
 * 找一个内置根（绝对路径）；这台机器上没有 = `undefined`。
 *
 * 顺序：显式环境变量 → 打包态的 `resourcesPath` → 从 cwd 逐级往上。后两者要求标记文件。
 */
export function resolveBuiltinDir(opts: {
  /** 相对仓库根 / resources 的子路径（如 `plugins`） */
  subdir: string
  /** 标记文件名（如 `builtin-plugins.json`） */
  marker: string
  /** 可显式指定这个根的绝对路径（如 `FIZZ_BUILTIN_PLUGINS_DIR`） */
  envVar: string
}): string | undefined {
  const cacheKey = `${opts.subdir}|${opts.marker}|${opts.envVar}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached ?? undefined

  const remember = (found: string | null): string | undefined => {
    cache.set(cacheKey, found)
    return found ?? undefined
  }

  const override = process.env[opts.envVar]?.trim()
  if (override) return remember(existsSync(override) ? override : null)

  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates: string[] = []
  if (resourcesPath) candidates.push(join(resourcesPath, opts.subdir))
  let dir = process.cwd()
  for (let i = 0; i <= MAX_WALK_UP; i++) {
    candidates.push(join(dir, opts.subdir))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return remember(candidates.find((p) => existsSync(join(p, opts.marker))) ?? null)
}

/** 内置插件根；这台机器上没有 = `undefined` */
export function resolveBuiltinPluginsDir(): string | undefined {
  return resolveBuiltinDir({
    subdir: PLUGINS_SUBDIR,
    marker: BUILTIN_PLUGINS_MARKER,
    envVar: 'FIZZ_BUILTIN_PLUGINS_DIR'
  })
}

/** 内置技能根；这台机器上没有 = `undefined` */
export function resolveBuiltinSkillsDir(): string | undefined {
  return resolveBuiltinDir({
    subdir: SKILLS_SUBDIR,
    marker: BUILTIN_SKILLS_MARKER,
    envVar: 'FIZZ_BUILTIN_SKILLS_DIR'
  })
}
