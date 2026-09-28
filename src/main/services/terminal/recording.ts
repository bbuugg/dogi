/**
 * 终端命令记录器：把「终端里执行的命令 + 命令输出」汇进主机日志（scope: 'terminal'）。
 *
 * 入口是 SessionManager 的三个钩子（输入 / 输出 / 关闭），在主进程统一处理，
 * 所以渲染端键入、AI 工具写入、脚本注入都会覆盖，后两者按来源打 [AI] / [脚本] 标记。
 *
 * 命令重建是尽力而为：PTY 是裸字节流、没有 shell 集成，历史补全 / 行内编辑等
 * 跨行改写无法还原。策略是「宁缺毋错」—— 一旦遇到无法确定行内容的控制序列，
 * 就把当前行作废（至多到该行回车为止都不记录），绝不错记一条没执行过的命令；
 * 输入里的换行按 shell 习惯推断（bracketed paste 区间内的换行是编辑缓冲区的
 * 行分隔，最终由一次回车统一提交，与 shell 实际执行语义一致）。
 *
 * 每条命令产生一条日志条目；命令输出以节流方式增量回填同一条目（同 seq 重复
 * 广播 = 覆盖更新，见 logger.update），超长截断并在条目里指向会话记录文件
 * —— userData/logs/sessions/<时间戳>-<标题>-<id前8位>.log，逐字节保真、不截断。
 *
 * 输出归属同样尽力而为：PTY 输出没有命令边界标记，输出块按到达时刻归属「当前进行中的
 * 命令」。无法还原的行（作废行）回车时不抢占槽位 —— 上一命令若尚未收到任何输出，槽位
 * 保留等它，免得迟到的回显变成孤儿；连续极速输入时，输出可能整体落在相邻命令条目上，
 * 此时以原始会话文件为准。清洗后无内容（纯界面重绘）或与上次回填相同的内容不重复
 * update —— 每次 update 都会广播 + 落盘一行，重复内容只会白涨 host.log。
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SessionInfo } from '@shared/types'
import { hostLogger } from '../log/logger'

/** 命令来源：渲染端键入（user）/ AI 工具写入（ai）/ 脚本注入（script） */
export type CommandSource = 'user' | 'ai' | 'script'

/** 非用户来源在正文前加标记，一眼可辨 */
const SOURCE_LABEL: Record<CommandSource, string> = {
  user: '',
  ai: '[AI] ',
  script: '[脚本] '
}

/** 单条命令最长记录字符数（超出截断，防超长粘贴撑爆日志条目） */
const MAX_COMMAND_CHARS = 2000
/** 单条命令的输出附加在日志条目里的最长字符数（超出截断；完整内容在会话记录文件） */
const MAX_OUTPUT_CHARS = 4000
/** 输出回填节流间隔：命令跑得久时不是每个输出块都更新日志条目 */
const FLUSH_INTERVAL_MS = 800
/** 单会话原始记录文件体积上限（超出写一行提示后停写） */
const MAX_SESSION_LOG_BYTES = 20 * 1024 * 1024
/** 原始记录文件目录名（相对 userData/logs） */
const SESSION_LOG_DIR = 'sessions'

/** bracketed paste 包裹标记（xterm 粘贴多行内容时成对发送） */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * 输出清洗（与 AI 侧 ai.ts 的 stripAnsi 同款规则，另补行处理）：
 * 去 OSC / DCS / CSI / 单字符转义序列，CRLF 与单独 CR（进度条原位刷新）统一成换行，
 * 再清掉残余控制字符（保留 \t \n）。
 */
function sanitizeOutput(input: string): string {
  return input
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[DP^X][\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[^\x1b]/g, '')
    .replace(/\x1b/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/** 单会话记录状态 */
interface SessionRecord {
  id: string
  title: string
  /** 记录创建时间（原始文件名的时间戳来源） */
  createdAt: number
  /** 当前行重建缓冲（只收可信字符） */
  buf: string
  /** 当前行是否可信（遇到无法解析的控制序列后作废，直到回车或 Ctrl+C 重置） */
  valid: boolean
  /** 处于 bracketed paste 包裹区间（期间的换行是行分隔，不是提交） */
  inPaste: boolean
  /** 待回填输出的日志条目 seq（null = 没有进行中的命令） */
  pendingSeq: number | null
  /** 待回填的原始输出（清洗与截断在 flush 时做） */
  pendingRaw: string
  /** 已回填的输出长度（判断是否还需要再次 update） */
  flushedLen: number
  pendingTruncated: boolean
  /** 上次已回填的清洗后文本（空串 = 还没回填过有意义内容）；内容没变就不重复 update */
  lastSent: string
  lastFlush: number
  flushTimer: NodeJS.Timeout | null
  /** 原始输出文件（首个输出块到达时惰性创建） */
  file: WriteStream | null
  filePath: string | null
  fileBytes: number
  /** 文件已结束（达到体积上限 / 出错 / 会话关闭），之后不再写入 */
  fileEnded: boolean
  decoder: StringDecoder
  /** 已成功记录的命令条数（会话关闭时汇报） */
  cmdCount: number
}

class TerminalRecorder {
  private records = new Map<string, SessionRecord>()
  /** 已关闭的会话（迟到事件直接忽略，不重建记录） */
  private closed = new Set<string>()

  /** 输入钩子：在会话「确实接受了写入」后调用（source 区分键入 / AI / 脚本） */
  feedInput(id: string, info: SessionInfo, data: string | Uint8Array, source: CommandSource): void {
    if (this.closed.has(id)) return
    const rec = this.ensure(id, info)
    if (typeof data !== 'string') {
      // 二进制写入（如 zmodem）：不是行编辑，丢弃当前行的重建状态
      rec.buf = ''
      rec.valid = true
      rec.inPaste = false
      return
    }
    for (let i = 0; i < data.length; i++) {
      if (data.startsWith(PASTE_START, i)) {
        rec.inPaste = true
        i += PASTE_START.length - 1
        continue
      }
      if (data.startsWith(PASTE_END, i)) {
        rec.inPaste = false
        i += PASTE_END.length - 1
        continue
      }
      const ch = data[i]
      if (ch === '\x1b') {
        // 除粘贴标记外的转义序列（方向键 / 历史补全等）会改写行内容且无从跟进 → 作废
        rec.valid = false
        continue
      }
      if (ch === '\r' || ch === '\n') {
        if (rec.inPaste) {
          // 粘贴区间内的换行是编辑缓冲区的行分隔，保留在命令里（最终一次回车统一提交）
          if (rec.valid && rec.buf.length < MAX_COMMAND_CHARS) rec.buf += '\n'
        } else {
          this.submit(rec, source)
        }
        continue
      }
      if (ch === '\x7f' || ch === '\b') {
        // 退格 / Delete：行可信时同步回退，否则维持作废状态
        if (rec.valid && rec.buf) rec.buf = rec.buf.slice(0, -1)
        continue
      }
      if (ch === '\x03' || ch === '\x15' || ch === '\x1a') {
        // Ctrl+C / Ctrl+U / Ctrl+Z：shell 会清掉整行 → 重建为「空的合法行」，粘贴收集同样中止
        rec.buf = ''
        rec.valid = true
        rec.inPaste = false
        continue
      }
      if (ch < ' ') {
        // Tab 补全等其他控制字符：行内容被 shell 改写，无法跟进 → 作废
        rec.valid = false
        continue
      }
      if (rec.valid && rec.buf.length < MAX_COMMAND_CHARS) rec.buf += ch
    }
  }

  /** 输出钩子：原始字节写入会话记录文件；进行中命令的输出节流回填条目 */
  feedOutput(id: string, info: SessionInfo, data: Buffer | string): void {
    if (this.closed.has(id)) return
    const rec = this.ensure(id, info)
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    this.writeRaw(rec, buf)
    if (rec.pendingSeq === null || rec.pendingTruncated) return
    const text = rec.decoder.write(buf)
    if (!text) return
    rec.pendingRaw += text
    if (rec.pendingRaw.length > MAX_OUTPUT_CHARS) {
      rec.pendingRaw = rec.pendingRaw.slice(0, MAX_OUTPUT_CHARS)
      rec.pendingTruncated = true
    }
    const elapsed = Date.now() - rec.lastFlush
    if (elapsed >= FLUSH_INTERVAL_MS) {
      this.flush(rec)
    } else if (!rec.flushTimer) {
      // 尾块兜底：命令跑完后再没有新输出时，最后一次增量也要回填
      rec.flushTimer = setTimeout(() => this.flush(rec), FLUSH_INTERVAL_MS - elapsed)
    }
  }

  /** 会话关闭：收尾进行中的命令、写完记录文件、留一条「已保存」日志（幂等） */
  close(id: string): void {
    const rec = this.records.get(id)
    if (!rec) return
    this.records.delete(id)
    this.closed.add(id)
    this.finishPending(rec)
    if (rec.file && !rec.fileEnded) {
      rec.file.end()
      rec.fileEnded = true
    }
    if (rec.filePath) {
      hostLogger.info(
        'terminal',
        `[${rec.title}] 会话结束：已记录 ${rec.cmdCount} 条命令（原始输出 ${SESSION_LOG_DIR}/${basename(rec.filePath)}）`,
        rec.filePath
      )
    }
  }

  /** 回车提交当前行：先收尾上一命令的输出回填，再记录本条命令（空行 / 作废行不记录） */
  private submit(rec: SessionRecord, source: CommandSource): void {
    const cmd = rec.buf
    const valid = rec.valid
    rec.buf = ''
    rec.valid = true
    // 空行回车（如命令运行中连敲回车）不产生新命令，也不打断上一命令的输出回填
    if (valid && !cmd.trim()) return
    if (!valid) {
      // 作废行没有条目可归属；若上一命令一个输出字节都还没到（ConPTY 回显有延迟），
      // 槽位保留继续等它 —— 否则那份还在路上的输出会变成孤儿（只进原始文件）
      if (rec.pendingSeq !== null && rec.pendingRaw.length === 0) return
      this.finishPending(rec)
      return
    }
    this.finishPending(rec)
    let text = cmd.trim()
    if (text.length >= MAX_COMMAND_CHARS) text = `${text.slice(0, MAX_COMMAND_CHARS)}…`
    const entry = hostLogger.info('terminal', `[${rec.title}] $ ${SOURCE_LABEL[source]}${text}`)
    rec.pendingSeq = entry.seq
    rec.pendingRaw = ''
    rec.flushedLen = 0
    rec.pendingTruncated = false
    rec.lastSent = ''
    rec.lastFlush = 0
    rec.cmdCount++
  }

  /** 收尾进行中的命令：把剩余输出回填掉，解除输出归属 */
  private finishPending(rec: SessionRecord): void {
    this.flush(rec)
    rec.pendingSeq = null
    rec.pendingRaw = ''
    rec.flushedLen = 0
    rec.pendingTruncated = false
    rec.lastSent = ''
  }

  /** 立即回填（节流窗口到点 / 尾块定时器 / 命令收尾时调用） */
  private flush(rec: SessionRecord): void {
    if (rec.flushTimer) {
      clearTimeout(rec.flushTimer)
      rec.flushTimer = null
    }
    if (rec.pendingSeq === null || rec.pendingRaw.length === rec.flushedLen) return
    rec.flushedLen = rec.pendingRaw.length
    const detail = this.formatDetail(rec)
    const text = detail ?? ''
    // 清洗后为空（纯转义序列的界面重绘）或与上次回填一致 → 不空转
    if (text === rec.lastSent) return
    rec.lastSent = text
    rec.lastFlush = Date.now()
    hostLogger.update(rec.pendingSeq, { detail })
  }

  private formatDetail(rec: SessionRecord): string | undefined {
    let text = sanitizeOutput(rec.pendingRaw).replace(/\n{3,}/g, '\n\n').trim()
    if (rec.pendingTruncated) {
      text += `${text ? '\n' : ''}…（输出过长已截断，完整内容见会话记录文件）`
    }
    return text || undefined
  }

  /** 追加原始输出字节；首块惰性建文件，达到体积上限 / 出错后静默停写 */
  private writeRaw(rec: SessionRecord, buf: Buffer): void {
    if (rec.fileEnded) return
    if (!rec.file) {
      const root = hostLogger.directory()
      // 日志目录不可用（init 失败）→ 命令条目照记，只是没有原始文件
      if (!root) return
      try {
        const dir = join(root, SESSION_LOG_DIR)
        mkdirSync(dir, { recursive: true })
        rec.filePath = join(dir, this.fileName(rec))
        const stream = createWriteStream(rec.filePath, { flags: 'a' })
        stream.on('error', () => {
          // 磁盘满 / 权限不足等：静默停写，不影响终端使用
          rec.fileEnded = true
          rec.file = null
        })
        rec.file = stream
      } catch {
        rec.fileEnded = true
        return
      }
    }
    const stream = rec.file
    if (!stream) return
    if (rec.fileBytes + buf.length > MAX_SESSION_LOG_BYTES) {
      stream.end(`\n[已达到 ${MAX_SESSION_LOG_BYTES / 1024 / 1024}MB 上限，后续输出不再写入本文件]\n`)
      rec.fileEnded = true
      return
    }
    rec.fileBytes += buf.length
    stream.write(buf)
  }

  /** 文件名：时间戳 + 会话标题（去非法字符）+ 会话 id 前 8 位，保证可读且不重名 */
  private fileName(rec: SessionRecord): string {
    const d = new Date(rec.createdAt)
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const safeTitle = rec.title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    const sid = rec.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
    return `${stamp}-${safeTitle || 'session'}-${sid || 'session'}.log`
  }

  private ensure(id: string, info: SessionInfo): SessionRecord {
    let rec = this.records.get(id)
    if (rec) return rec
    rec = {
      id,
      title: info.title,
      createdAt: Date.now(),
      buf: '',
      valid: true,
      inPaste: false,
      pendingSeq: null,
      pendingRaw: '',
      flushedLen: 0,
      pendingTruncated: false,
      lastSent: '',
      lastFlush: 0,
      flushTimer: null,
      file: null,
      filePath: null,
      fileBytes: 0,
      fileEnded: false,
      decoder: new StringDecoder('utf8'),
      cmdCount: 0
    }
    this.records.set(id, rec)
    return rec
  }
}

export const terminalRecorder = new TerminalRecorder()
