/**
 * 应用日志：整个 App 的业务事件记录（SSH / 终端 / 隧道 / SFTP / 插件 / Agent …）。
 *
 * 形态照搬 dogi 的主机日志，但有三处关键差异：
 *
 * 1. **落在 server 侧，不在 Electron 主进程**。本项目的能力都在 `apps/server`（Hono），
 *    桌面端只是进程内直连同一个 server —— 记在主进程就等于 Web 端看不见，所以本文件
 *    在 `@fizz/workspace`（零 Electron、零 Mastra），web 与 desktop 共享同一份。
 *
 * 2. **命名空间是运行时注册的，不是编译期枚举**。dogi 的 `HostLogScope` 写死六个值，
 *    新增功能要改类型 + 改 UI 两张静态表；这里改成 `registerNamespace()` 注册进一张
 *    Map，日志面板从 `namespaces()` 读出 Tab 列表，新增功能只加一行注册。
 *
 * 3. **`scope` 的类型是宽松的 `string`**（`AppLogScope`），且 `log()` 对未注册的 scope
 *    自动登记一个兜底元数据 —— 漏注册只会让 Tab 名字难看，**不会丢日志**。
 *
 * 两条通道（与 dogi 同构）：
 * - 内存环形缓冲（上限 `MAX_ENTRIES`）：界面经 `GET /api/app-log` 全量读取，
 *   新记录经 SSE 推给渲染端补增量；
 * - JSONL 落盘（`<dataDir>/logs/app.log`）：跨重启保留，启动时回填尾部；超过
 *   `MAX_FILE_BYTES` 滚动一代为 `app.log.1`（每笔追加前 stat 一次 —— 写入是生命周期级
 *   事件，频率低，不值得为省一次 stat 引入复杂度）。
 *
 * 落盘失败（磁盘只读等）静默降级为仅内存，日志本身绝不能拖垮业务；清空会同时清掉内存
 * 与文件，序号继续递增不复用（避免渲染端 key 撞车）。
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { resolveDataDir } from './store'

/** 内存保留条数（渲染端同值封顶；落盘文件另行按体积滚动） */
export const APP_LOG_MAX_ENTRIES = 1000
/** 落盘文件体积上限（超过后滚动为 .1，只保留一代） */
const MAX_FILE_BYTES = 2 * 1024 * 1024
const LOG_DIR_NAME = 'logs'
const LOG_FILE_NAME = 'app.log'

export type AppLogLevel = 'info' | 'warn' | 'error'

/**
 * 日志命名空间：约定为 `kebab-case` 短标识（`ssh` / `terminal` / `plugin`）。
 * 刻意**不是**联合类型 —— 命名空间由各功能模块运行时注册，类型层不该知道有几个。
 */
export type AppLogScope = string

/** 命名空间元数据（面板据此渲染 Tab 与行内标签） */
export interface AppLogNamespace {
  /** 标识，如 `ssh` */
  id: AppLogScope
  /** 展示名，如 `SSH` */
  label: string
  /**
   * 排序权重，小的在前。省略时按注册顺序排在已显式给值的项之后 ——
   * 大多数模块不需要关心顺序，只有确实要钉住位置的（如 `app` 永远第一）才给这个值。
   */
  order?: number
}

export interface AppLogEntry {
  /** 自增序号，跨重启从落盘最大值继续；渲染端 key */
  seq: number
  /** 时间戳（毫秒） */
  ts: number
  scope: AppLogScope
  level: AppLogLevel
  /** 单行正文 */
  message: string
  /** 多行补充，折叠展示 */
  detail?: string
}

// ---------- 命名空间注册表 ----------

/** 已注册命名空间（Map 保持插入序，供「省略 order 时按注册顺序」兜底） */
const namespaces = new Map<AppLogScope, AppLogNamespace>()
/** 未注册 scope 的兜底元数据（只影响 Tab 名字，不影响日志本身） */
const autoLabeled = new Map<AppLogScope, true>()
/** 省略 order 时的自增权重的起点：远大于任何手写值，于是**必排在有 order 的项之后** */
const NO_ORDER_BASE = 10_000

/**
 * 注册一个命名空间。各功能模块在自己文件顶部调一次即可（幂等，重复注册覆盖元数据）。
 *
 * 例：`registerNamespace({ id: 'ssh', label: 'SSH' })`
 */
export function registerNamespace(ns: AppLogNamespace): void {
  namespaces.set(ns.id, ns)
  autoLabeled.delete(ns.id)
}

/** 排序权重：显式 order 优先；省略时按注册顺序接在显式项之后 */
function orderOf(ns: AppLogNamespace, index: number): number {
  return ns.order ?? NO_ORDER_BASE + index
}

/** 已注册命名空间，按 order 升序（面板 Tab 顺序） */
export function appLogNamespaces(): AppLogNamespace[] {
  return [...namespaces.values()]
    .map((ns, i) => ({ ns, w: orderOf(ns, i) }))
    .sort((a, b) => a.w - b.w)
    .map((x) => x.ns)
}

/** 日志里出现过但没注册的命名空间（兜底展示 + 提示漏注册） */
export function appLogUnregisteredScopes(): AppLogScope[] {
  return [...autoLabeled.keys()].sort()
}

/** 未注册 scope 的兜底元数据：标识当标签，排在注册项之后 */
function ensureNamespace(scope: AppLogScope): void {
  if (namespaces.has(scope) || autoLabeled.has(scope)) return
  autoLabeled.set(scope, true)
}

// ---------- logger 本体 ----------

class AppLogger extends EventEmitter {
  private entries: AppLogEntry[] = []
  private seq = 0
  private filePath = ''
  private dirPath = ''
  /** 串行化的落盘链路（滚动与追加不能交错） */
  private pending: Promise<void> = Promise.resolve()

  /**
   * 初始化：建目录 + 回填落盘尾部。由 server 启动流程调用。
   * 多次调用幂等；目录不可用时退化为仅内存模式（界面照常，只是不落盘）。
   */
  async init(dataDir = resolveDataDir()): Promise<void> {
    if (this.dirPath) return
    try {
      const dir = join(dataDir, LOG_DIR_NAME)
      await mkdir(dir, { recursive: true })
      this.dirPath = dir
      this.filePath = join(dir, LOG_FILE_NAME)
      await this.loadTail()
    } catch {
      // 目录不可用：退化为仅内存模式
    }
  }

  /** 日志目录（供「打开日志目录」用；init 失败时为空串） */
  directory(): string {
    return this.dirPath
  }

  /**
   * 全部日志（从旧到新，界面按需倒序展示）。
   *
   * ⚠️ 返回**浅拷贝**：调用方（HTTP 序列化、SSE 攒帧）拿到的是数组副本，之后
   * `log()` 往 `this.entries` 里 push 不会改动它手里那份 —— 直接返回引用的话，
   * 一边 `JSON.stringify` 一边追加，序列化结果会随追加而变化（`maxSeq` 与
   * `entries` 就可能对不上）。条目本身是只读用的，不必深拷贝。
   */
  list(): AppLogEntry[] {
    return [...this.entries]
  }

  /**
   * 等在途的落盘写完（进程收尾时调）。
   *
   * ⚠️ **不调会丢最后几条**：`persist()` 是异步 `appendFile` 且**不 await**（写入是生命周期
   * 级事件，不该阻塞业务），进程 `exit` 时链上没跑完的那几条就丢了 —— 而「最后一次收尾」
   * 恰恰是最值得留档的那几条。挂在 `shutdown.ts` 第 6 步（与 store 落盘同一处）。
   *
   * 失败不抛：收尾流程不该因为日志写不出去而卡住或报错。
   */
  async flush(): Promise<void> {
    await this.pending.catch(() => {})
  }

  /** 清空内存与落盘文件；之后的序号继续递增 */
  clear(): void {
    this.entries = []
    const path = this.filePath
    if (!path) return
    this.pending = this.pending.then(() => writeFile(path, '').catch(() => {}))
  }

  info(scope: AppLogScope, message: string, detail?: string): AppLogEntry {
    return this.log(scope, 'info', message, detail)
  }

  warn(scope: AppLogScope, message: string, detail?: string): AppLogEntry {
    return this.log(scope, 'warn', message, detail)
  }

  error(scope: AppLogScope, message: string, detail?: string): AppLogEntry {
    return this.log(scope, 'error', message, detail)
  }

  log(scope: AppLogScope, level: AppLogLevel, message: string, detail?: string): AppLogEntry {
    ensureNamespace(scope)
    const entry: AppLogEntry = { seq: ++this.seq, ts: Date.now(), scope, level, message, detail }
    this.entries.push(entry)
    if (this.entries.length > APP_LOG_MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - APP_LOG_MAX_ENTRIES)
    }
    this.emit('entry', entry)
    this.persist(entry)
    return entry
  }

  /**
   * 更新已有条目（长任务的输出增量回填）：就地覆盖字段并再次广播 —— 同一 seq 的重复
   * 广播即「更新」语义，渲染端按 seq 覆盖；落盘追加一行，启动回填按 seq 去重（后写覆盖先写）。
   */
  update(seq: number, patch: Partial<Pick<AppLogEntry, 'level' | 'message' | 'detail'>>): void {
    const entry = this.entries.find((e) => e.seq === seq)
    if (!entry) return
    if (patch.level !== undefined) entry.level = patch.level
    if (patch.message !== undefined) entry.message = patch.message
    if (patch.detail !== undefined) entry.detail = patch.detail
    this.emit('entry', entry)
    this.persist(entry)
  }

  /** 启动时回填落盘文件的尾部（损坏行直接跳过，绝不因为一行坏数据起不来） */
  private async loadTail(): Promise<void> {
    const raw = await readFile(this.filePath, 'utf8').catch(() => '')
    const lines = raw.split('\n').filter((line) => line.trim())
    // 同 seq 后写覆盖先写（增量回填会重复落盘同一条目），再按 seq 升序保留最新一批
    const bySeq = new Map<number, AppLogEntry>()
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AppLogEntry
        if (typeof entry?.seq !== 'number' || typeof entry.message !== 'string') continue
        ensureNamespace(entry.scope)
        bySeq.set(entry.seq, entry)
      } catch {
        // 跳过损坏行
      }
    }
    for (const entry of [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-APP_LOG_MAX_ENTRIES)) {
      this.entries.push(entry)
      if (entry.seq > this.seq) this.seq = entry.seq
    }
  }

  private persist(entry: AppLogEntry): void {
    const path = this.filePath
    if (!path) return
    const line = `${JSON.stringify(entry)}\n`
    this.pending = this.pending
      .then(() => this.rotateIfNeeded(path))
      .then(() => appendFile(path, line, 'utf8'))
      .catch(() => {
        // 落盘失败不影响业务
      })
  }

  private async rotateIfNeeded(path: string): Promise<void> {
    try {
      const info = await stat(path)
      if (info.size <= MAX_FILE_BYTES) return
      await rename(path, `${path}.1`)
    } catch {
      // 文件不存在（首次写入）等
    }
  }
}

/** 全局单例：各功能模块直接 `appLog.info('ssh', …)` 写入 */
export const appLog = new AppLogger()
