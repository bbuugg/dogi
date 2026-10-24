/**
 * 终端转录：把一条终端会话的**输入与输出**同时写进两个地方 ——
 *
 * 1. **一条应用日志**（日志面板的「终端」/「SSH」Tab）：一次会话固定占一条，
 *    按节流覆盖回填（`appLog.update(seq, …)`）；
 * 2. **一个会话文件**：`<dataDir>/logs/terminal/<会话 id>.log`，按会话独立、逐块追加、**不截断**。
 *
 * ## 为什么日志条目要「回填同一条」而不是「每条输入输出记一条」
 *
 * 终端是全 App 最吵的写入源 —— 敲一个字符一次输入、程序每打一行一次输出，`npm run build`
 * 一秒能产几百个 chunk。逐条 `appLog.info` 会在几秒内把 `APP_LOG_MAX_ENTRIES`（1000 条
 * 环形缓冲）刷满，把别的功能（工作区 / 对话 / 任务）的日志**全部挤出去**，落盘文件也会被
 * 单条终端打爆。所以这里走 `appLog.update(seq, …)`：**一次会话固定占一条**，内容按节流
 * 覆盖 —— 这正是 `appLog.update` 注释里写的「长任务的输出增量回填」用途，前端按 seq 覆盖。
 *
 * ## 为什么还要另落一个按会话分的文件（参考 dogi 的 `logs/sessions/`）
 *
 * 日志条目那一路有两个天然上限：环形缓冲 1000 条（终端跑几轮就把别的功能挤没了）、detail
 * 封顶 `MAX_CHARS`（8KB，超了从**头部**截）。也就是说「最该留档的那条长会话」恰恰是**最先被
 * 截断、最早被挤出去**的那个。文件这一路没有这两个问题：一个会话一个文件，互不挤占、跨重启
 * 保留、不截断（只封 20MB 体积上限）。
 *
 * 目录名取 `terminal`（dogi 那边叫 `sessions`）：本仓的 web 服务端终端、桌面本机终端与 SSH
 * 终端**共用同一个目录**，用命名空间当目录名反而会分叉出三份。
 *
 * ## 三处必须做的清洗（少一个日志就没法看）
 *
 * 1. **剥 ANSI 控制序列**：`\x1b[32m` 这类序列是给终端解释的，写进日志面板的 `<pre>`
 *    就是一堆乱码。
 * 2. **归一换行**：PTY 输出用 `\r\n`；进度条（npm / curl / apt）靠**裸 `\r`** 回到行首
 *    重画，原样留着会把一整行撑成几百字符的横条。
 * 3. **保留尾部**：日志条目封顶 `MAX_CHARS`，超出从**头部**截 —— 最近发生的事最有价值。
 *    （会话文件不截，只有 20MB 的硬上限。）
 *
 * ## 输入怎么记
 *
 * 逐字符攒成行、**回车才提交**（前缀 `❯ `，与程序输出区分）。这样退格能在提交前就地删掉
 * （不留一串删除符）、进度条式的逐字符刷新不会刷爆日志、Ctrl+C 能标成一行 `❯ ^C`。
 *
 * ⚠️ **输入是明文记录的，包含 `sudo` / `mysql -p` 这类交互提示下敲的密码**（密码不回显，
 * 输出里看不到，只有这里能看到）。落盘在 `<dataDir>/logs/app.log` 与
 * `<dataDir>/logs/terminal/<会话 id>.log`。不需要这个能力时，去掉三个接入点对 `input()`
 * 的调用即可（`apps/server/.../terminal/pty.ts`、`apps/server/.../ssh/session.ts`、
 * `agent-host/src/pty.ts`）。
 *
 * ## 为什么放在 `packages/workspace`（而不是 `apps/server`）
 *
 * 终端有**三份**独立实现，都要记同一份日志：web 的服务端终端（`apps/server`）、SSH 终端
 * （`apps/server`）、桌面端的本机终端（`agent-host`，跑在主进程）。日志本体 `appLog` 就在
 * 本包，转录放这里三边都能直接引 —— 放 `apps/server` 的话 `agent-host` 够不着（跨 app 引
 * 源码是不允许的）。桌面端 server 是**进程内**装配的（`agent-host/src/manager.ts`），
 * 主进程与 server 拿到的是同一个 `appLog` 单例，所以主进程记的终端日志在日志面板里读得到。
 */
import { appendFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { appLog } from './app-log'

/** 转录文本字符上限（超出从头部截）：够看清最近跑了什么，也压得住落盘体积 */
const MAX_CHARS = 8 * 1024
/** 回填节流（毫秒）。终端写入太密，逐 chunk 回填会把落盘打爆（落盘有 2MB 滚动兜底） */
const FLUSH_MS = 1000
/** 输入行前缀：终端有本地回显，不标一下会把用户敲的和程序打的混成一片 */
const INPUT_PREFIX = '❯ '
/** 会话日志目录名（相对 `<dataDir>/logs`）——三份终端实现共用一个目录 */
export const TERMINAL_LOG_DIR_NAME = 'terminal'
/** 单会话日志文件体积上限（超出写一行提示后停写） */
const MAX_FILE_BYTES = 20 * 1024 * 1024

/** 在途的文件写入链：进程收尾时 `flushTerminalLogs()` 等它们写完，别把最后一块丢在链上 */
const pendingWrites = new Set<Promise<void>>()

function track(promise: Promise<void>): void {
  pendingWrites.add(promise)
  void promise.then(
    () => pendingWrites.delete(promise),
    () => pendingWrites.delete(promise)
  )
}

/**
 * 等在途的会话日志写入落地（进程收尾用，见 `shutdown.ts`）。
 *
 * ⚠️ 与 `appLog.flush()` 同一个理由：`appendFile` 是异步且**不 await** 的（写日志不该阻塞
 * 业务），进程 `exit` 时链上没跑完的那一块就丢了 —— 而终端被收掉前最后几行输出，往往正是
 * 最值得留档的那几行。失败不抛：收尾流程不该因为日志写不出去而卡住。
 */
export async function flushTerminalLogs(): Promise<void> {
  // 最多追两轮：收尾时终端已经被 kill 掉、不该再有新块（`finish()` 之后不再接受写入），
  // 第二轮只是兜住「等在途时又排进来一块」；有上限才不会在收尾阶段空转。
  for (let round = 0; round < 2 && pendingWrites.size > 0; round += 1) {
    await Promise.allSettled([...pendingWrites])
  }
}

/**
 * 清空终端会话日志目录（`DELETE /api/app-log/clear` 用）。
 *
 * 会话文件也是「应用日志」的一部分（同一条链路的另一种落盘形态），清空日志时一并清掉 ——
 * 与 dogi 的 `logs:clear` 连 `logs/sessions/` 一起删同一口径。**尽力而为**：仍在写入的会话
 * 文件在 Windows 上可能删不掉，跳过即可（那个会话下一次回填会把它重建出来）。
 */
export async function clearTerminalLogs(): Promise<void> {
  const root = appLog.directory()
  if (!root) return
  await rm(join(root, TERMINAL_LOG_DIR_NAME), { recursive: true, force: true }).catch(() => {})
}

/**
 * 剥掉 ANSI 控制序列。顺序不能反：OSC 先于 CSI（OSC 内容里可能含 `[`），
 * 最后的兜底扫掉残留的裸 ESC 与其余控制字符（**保留 `\t` 与 `\n`**，日志靠它们排版）。
 */
function stripAnsi(input: string): string {
  return input
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?<>=!]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[\u0040-\u005f][0-9A-Za-z]?/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

/** 文件名安全化：会话 id 是我们自己生成的（`term-…`），兜底清掉路径分隔符等非法字符 */
function safeFileStem(id: string): string {
  const cleaned = id.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'session'
}

export class TerminalTranscript {
  /** 日志条目序号：所有回填都打在这一条上（见文件头「一次会话一条日志」） */
  private readonly seq: number
  /** 会话头部信息（shell / 工作目录 / 主机），固定拼在转录正文前面 */
  private readonly header: string
  /** 会话文件名（目录在写入时才定 —— `appLog.directory()` 要等 `init()` 跑完） */
  private readonly fileName: string
  /** 文件头：打开文件就知道这是哪条会话、什么时候开的、shell / 主机是什么 */
  private readonly fileHeader: string
  private text = ''
  /** 待落文件的文本：**不截断**，与给日志条目的 `text` 分开维护 */
  private fileText = ''
  /** 上面那份的字节数（攒够 `MAX_FILE_BYTES` 就停手，不必每次重新量整串） */
  private filePendingBytes = 0
  /** 已写进文件的字节数（判断首块要不要补文件头 + 体积上限） */
  private fileBytes = 0
  /** 攒下的量已到体积上限：下次落盘写满 + 补一行提示后收场 */
  private fileOverflow = false
  /** 文件已收场（达到体积上限 / 写失败），之后不再写 */
  private fileEnded = false
  /** 文件写入串行链：同一文件的块不能交错（`appendFile` 是异步的） */
  private fileChain: Promise<void> = Promise.resolve()
  /** 未提交的输入行（回车才提交，见 `input`） */
  private line = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private finished = false

  constructor(seq: number, header: string, sessionId: string) {
    this.seq = seq
    this.header = header
    this.fileName = `${safeFileStem(sessionId)}.log`
    this.fileHeader = [`# 终端会话 ${sessionId}`, `# 开始于 ${new Date().toISOString()}`, header].join('\n')
  }

  /** 用户键入。`Uint8Array` 是 ZMODEM 的二进制帧，不是给人读的内容，直接忽略 */
  input(data: string | Uint8Array): void {
    if (this.finished || typeof data !== 'string') return
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        this.commitLine()
      } else if (ch === '\u007f' || ch === '\b') {
        // 退格：删当前行末尾字符，别把一串删除符写进日志
        this.line = this.line.slice(0, -1)
      } else if (ch === '\u0003') {
        // Ctrl+C：中断当前输入行
        this.line = ''
        this.commitLine('^C')
      } else if (ch >= ' ') {
        this.line += ch
      }
    }
  }

  /** 程序输出（原始字节）。非 UTF-8 会话由调用方先解码成文本再传进来 */
  output(data: Buffer | string): void {
    if (this.finished) return
    const raw = typeof data === 'string' ? data : data.toString('utf8')
    if (!raw) return
    // 先归一换行（进度条靠裸 `\r` 重画，留着会把一行撑成横条），再剥 ANSI
    this.append(stripAnsi(raw.replace(/\r\n/g, '\n')))
  }

  /** 收尾：提交未回车的输入、落最后一次（进程退出时调用，之后不再接受写入） */
  finish(note?: string): void {
    if (this.finished) return
    this.finished = true
    this.clearTimer()
    if (this.line) this.commitLine()
    if (note) this.append(`\n${note}\n`)
    this.flush()
  }

  private commitLine(override?: string): void {
    const text = override ?? this.line
    this.line = ''
    // 空回车（连按 Enter）不值得占一行
    if (!text.trim()) return
    this.append(`${INPUT_PREFIX}${text}\n`)
  }

  private append(chunk: string): void {
    if (!chunk) return
    // 文件那一路**不截断**（只封 20MB），所以要在日志条目的截断逻辑之前攒。
    // 攒到上限就停手：`flushFile` 会把攒下的写出去 + 补一行提示 —— 顺带保证
    // 「日志目录始终不可用」时 `fileText` 也不会无限涨（那种情况只走日志条目）。
    if (!this.fileEnded && !this.fileOverflow) {
      this.fileText += chunk
      this.filePendingBytes += Buffer.byteLength(chunk, 'utf8')
      if (this.fileBytes + this.filePendingBytes > MAX_FILE_BYTES) this.fileOverflow = true
    }
    this.text += chunk
    if (this.text.length > MAX_CHARS) {
      this.text = this.text.slice(this.text.length - MAX_CHARS)
      // 截断后开头多半是半行：砍到第一个换行，免得日志第一行是断的
      const nl = this.text.indexOf('\n')
      if (nl >= 0) this.text = this.text.slice(nl + 1)
    }
    this.dirty = true
    if (!this.finished) this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_MS)
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /** 回填这一条日志 + 追加会话文件。**没有新内容就不写**（终端静默时不该持续 appendFile） */
  private flush(): void {
    if (!this.dirty) return
    this.dirty = false
    const body = this.text.trimEnd()
    appLog.update(this.seq, { detail: body ? `${this.header}\n\n${body}` : this.header })
    this.flushFile()
  }

  /**
   * 把攒下的文本追加进会话文件。**惰性创建**：首次真正有内容时才建目录与文件 ——
   * 「开了终端什么都没跑」不留空文件。
   *
   * 目录从 `appLog.directory()` 取（`init()` 未跑完 / 落盘不可用时是空串）：那种情况
   * 直接返回、下一拍再试，日志条目那一路照常。任何 IO 失败都**静默停写** —— 日志绝不能拖垮业务。
   */
  private flushFile(): void {
    if (this.fileEnded || !this.fileText) return
    const root = appLog.directory()
    if (!root) return
    const dir = join(root, TERMINAL_LOG_DIR_NAME)
    const path = join(dir, this.fileName)
    // 首块补文件头（会话 id / 开始时间 / shell / 主机 / 工作目录），之后的块直接追加
    const chunk = this.fileBytes === 0 ? `${this.fileHeader}\n\n${this.fileText}` : this.fileText
    this.fileText = ''
    this.filePendingBytes = 0
    const notice = this.fileOverflow
      ? `\n[已达到 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限，后续输出不再写入本文件]\n`
      : ''
    this.fileBytes += Buffer.byteLength(chunk + notice, 'utf8')
    // 超限的会话到此为止：提示写进去之后不再接受内容（`append` 也会跳过累积）
    if (this.fileOverflow) this.fileEnded = true
    this.fileChain = this.fileChain
      .then(() => mkdir(dir, { recursive: true }))
      .then(() => appendFile(path, chunk + notice, 'utf8'))
      .catch(() => {
        // 磁盘满 / 权限不足：停写，终端照常用
        this.fileEnded = true
      })
    track(this.fileChain)
  }
}

/**
 * 开一条转录：先记「打开终端」那条日志，再把它交给 `TerminalTranscript` 持续回填。
 *
 * 头部信息（shell / 工作目录 / 主机）同时作为日志条目的初始 detail 与会话文件的文件头 ——
 * 终端还没输出时用户也能看到这条会话是怎么起的。`sessionId` 是会话文件的文件名。
 */
export function startTerminalTranscript(
  scope: string,
  message: string,
  header: string,
  sessionId: string
): TerminalTranscript {
  const entry = appLog.info(scope, message, header)
  return new TerminalTranscript(entry.seq, header, sessionId)
}
