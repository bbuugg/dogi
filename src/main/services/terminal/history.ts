/**
 * 终端命令历史：跨会话共享、跨重启持久化的用户输入命令。
 *
 * 数据只有一份，存在主进程（userData/command-history.json，整文件 JSON）：
 * 所有终端会话（本地 / SSH）共享同一个池，渲染端经 history:* 通道读写，
 * 并在全局 store 里持有镜像（命令预测与管理界面读镜像）。
 *
 * 记录的内容是「用户按回车提交的那一行」—— 渲染端 TerminalView 在回车时上报，
 * AI 工具 / 脚本写入的命令不进这里（那是主机日志 terminal 作用域的事，见 recording.ts）。
 *
 * 与 hostLogger 的两点差异：
 * - 落盘路径由 init(filePath) 注入而非自己取 app.getPath —— 保持与 Electron 解耦，
 *   探针可以在纯 Node 下直接跑这个真源码（同 browser/session.ts 的 profilesRoot 注入）；
 * - 文件很小（上限 MAX_ENTRIES 条短文本），每次变更整文件重写，不做 JSONL 追加 / 滚动。
 *
 * 落盘失败静默降级为仅内存（同 hostLogger：历史绝不能拖垮终端）；
 * 加载时逐条校验、坏数据跳过，文件损坏就从空历史开始，绝不起不来。
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { CommandHistoryEntry } from '@shared/types'

/** 内存与落盘共同的上限（最新的在前，超限从尾部丢弃） */
export const COMMAND_HISTORY_MAX = 1000
/** 单条命令最长字符数（超长粘贴截断，防单条撑爆文件） */
export const COMMAND_HISTORY_MAX_CHARS = 2000

/** 应用内的唯一实例（探针需要模拟「重启后再 init」，所以 class 也导出） */
export class CommandHistoryStore {
  private entries: CommandHistoryEntry[] = []
  private filePath = ''
  /** 串行化的落盘链路（并发 add 之间的写序不能交错） */
  private pending: Promise<void> = Promise.resolve()
  /**
   * 启动时注入落盘路径并读回历史；需早于 IPC 注册（bootstrap 的 history:list 才能读到）。
   * 传空串退化为仅内存模式。
   */
  async init(filePath: string): Promise<void> {
    if (this.filePath) return
    this.filePath = filePath
    if (!filePath) return
    const raw = await readFile(filePath, 'utf8').catch(() => '')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return // 文件损坏 / 为空：从空历史开始
    }
    if (!Array.isArray(parsed)) return
    for (const item of parsed) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as CommandHistoryEntry).cmd === 'string' &&
        (item as CommandHistoryEntry).cmd.trim() &&
        typeof (item as CommandHistoryEntry).ts === 'number'
      ) {
        this.entries.push({ cmd: (item as CommandHistoryEntry).cmd, ts: (item as CommandHistoryEntry).ts })
      }
    }
    if (this.entries.length > COMMAND_HISTORY_MAX) {
      this.entries.length = COMMAND_HISTORY_MAX
    }
  }

  /** 全部历史（最新在前） */
  list(): CommandHistoryEntry[] {
    return this.entries
  }

  /**
   * 记录一条：trim 后去重置顶（重复执行刷新时间并移到最前），超限丢尾部。
   * 空串不记。返回记录的条目（没记返回 null）。
   */
  add(rawCmd: string): CommandHistoryEntry | null {
    const cmd = rawCmd.trim().slice(0, COMMAND_HISTORY_MAX_CHARS)
    if (!cmd) return null
    this.entries = this.entries.filter((e) => e.cmd !== cmd)
    const entry: CommandHistoryEntry = { cmd, ts: Date.now() }
    this.entries.unshift(entry)
    if (this.entries.length > COMMAND_HISTORY_MAX) {
      this.entries.length = COMMAND_HISTORY_MAX
    }
    this.persist()
    return entry
  }

  /** 删除单条（按命令文本定位；不存在时静默） */
  remove(cmd: string): void {
    const next = this.entries.filter((e) => e.cmd !== cmd)
    if (next.length === this.entries.length) return
    this.entries = next
    this.persist()
  }

  /** 清空内存与落盘文件 */
  clear(): void {
    this.entries = []
    this.persist()
  }

  /** 等待挂起的落盘完成（测试断言与退出前刷盘用） */
  flush(): Promise<void> {
    return this.pending
  }

  private persist(): void {
    const path = this.filePath
    if (!path) return
    this.pending = this.pending
      .then(() => writeFile(path, JSON.stringify(this.entries), 'utf8'))
      .catch(() => {
        // 落盘失败不影响业务（下次变更会再试）
      })
  }
}

export const commandHistory = new CommandHistoryStore()

