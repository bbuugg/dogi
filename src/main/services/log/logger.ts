/**
 * 主机日志：SSH 连接 / 终端命令 / 隧道 / SFTP 等主机相关事件的结构化记录。
 *
 * 两条通道：
 * - 内存环形缓冲（上限 MAX_ENTRIES）：界面经 `logs:list` 全量读取，新记录经 'entry'
 *   事件由 ipc/logs.ts 广播给渲染端补增量；
 * - JSONL 落盘（userData/logs/host.log）：跨重启保留，启动时回填尾部；超过
 *   MAX_FILE_BYTES 滚动一代为 host.log.1（每笔追加前 stat 一次 —— 写入是连接 /
 *   生命周期级事件，频率低，不值得为省一次 stat 引入复杂度）。
 *
 * 终端命令的输出增量经 update() 回填同一条目：同一 seq 会再次广播（渲染端按 seq
 * 覆盖），落盘追加更新行、启动回填时同 seq 后写覆盖先写。
 *
 * 落盘失败（磁盘只读等）静默降级为仅内存，日志本身绝不能拖垮业务；
 * 清空会同时清掉内存与文件，序号继续递增不复用（避免渲染端 key 撞车）。
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { app } from 'electron'
import type { HostLogEntry, HostLogLevel, HostLogScope } from '@shared/types'

/** 内存保留条数（渲染端同值封顶；落盘文件另行按体积滚动） */
const MAX_ENTRIES = 1000
/** 落盘文件体积上限（超过后滚动为 .1，只保留一代） */
const MAX_FILE_BYTES = 2 * 1024 * 1024
const LOG_DIR_NAME = 'logs'
const LOG_FILE_NAME = 'host.log'

class HostLogger extends EventEmitter {
  private entries: HostLogEntry[] = []
  private seq = 0
  private filePath = ''
  private dirPath = ''
  /** 串行化的落盘链路（滚动与追加不能交错） */
  private pending: Promise<void> = Promise.resolve()

  /** 应用就绪后调用；需早于 IPC 注册（隧道自启等早期事件同样要落盘） */
  async init(): Promise<void> {
    if (this.dirPath) return
    try {
      const dir = join(app.getPath('userData'), LOG_DIR_NAME)
      await mkdir(dir, { recursive: true })
      this.dirPath = dir
      this.filePath = join(dir, LOG_FILE_NAME)
      await this.loadTail()
    } catch {
      // 目录不可用：退化为仅内存模式（界面照常，只是不落盘）
    }
  }

  /** 日志目录（供「打开日志目录」用；init 失败时为空串） */
  directory(): string {
    return this.dirPath
  }

  /** 全部日志（从旧到新，界面按需倒序展示） */
  list(): HostLogEntry[] {
    return this.entries
  }

  /** 清空内存与落盘文件；之后的序号继续递增 */
  clear(): void {
    this.entries = []
    const path = this.filePath
    if (!path) return
    this.pending = this.pending.then(() => writeFile(path, '').catch(() => {}))
  }

  info(scope: HostLogScope, message: string, detail?: string): HostLogEntry {
    return this.log(scope, 'info', message, detail)
  }

  warn(scope: HostLogScope, message: string, detail?: string): HostLogEntry {
    return this.log(scope, 'warn', message, detail)
  }

  error(scope: HostLogScope, message: string, detail?: string): HostLogEntry {
    return this.log(scope, 'error', message, detail)
  }

  log(scope: HostLogScope, level: HostLogLevel, message: string, detail?: string): HostLogEntry {
    const entry: HostLogEntry = { seq: ++this.seq, ts: Date.now(), scope, level, message, detail }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    }
    this.emit('entry', entry)
    this.persist(entry)
    return entry
  }

  /**
   * 更新已有条目（终端命令的输出增量回填）：就地覆盖字段并再次广播 —— 同一 seq
   * 的重复广播即「更新」语义，渲染端按 seq 覆盖；落盘追加一行，启动回填按
   * seq 去重（后写覆盖先写）。
   */
  update(seq: number, patch: Partial<Pick<HostLogEntry, 'level' | 'message' | 'detail'>>): void {
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
    // 同 seq 后写覆盖先写（命令输出增量会重复落盘同一条目），再按 seq 升序保留最新一批
    const bySeq = new Map<number, HostLogEntry>()
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HostLogEntry
        if (typeof entry?.seq !== 'number' || typeof entry.message !== 'string') continue
        bySeq.set(entry.seq, entry)
      } catch {
        // 跳过损坏行
      }
    }
    for (const entry of [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_ENTRIES)) {
      this.entries.push(entry)
      if (entry.seq > this.seq) this.seq = entry.seq
    }
  }

  private persist(entry: HostLogEntry): void {
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

export const hostLogger = new HostLogger()
