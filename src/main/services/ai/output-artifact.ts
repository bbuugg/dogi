/**
 * 工具长输出产物（output artifact）：工具结果太长时的「落盘 + 按段回读」机制。
 *
 * ## 为什么需要
 *
 * 工具把命令输出整段塞回模型会撑爆上下文，硬截断又会把关键信息丢掉：
 * - 终端侧 `run_in_terminal` 的输出来自会话环形缓冲（256KB，会裁头），
 *   超限时 `outputFrom(beforeLen)` 直接返回 `''` —— 模型收到「完全没有输出」，
 *   连嗅探提示符的机会都没有，必然误判；
 * - 工作区侧 `execute_command` 用 `truncateOutput` 保留头尾，但**中段永久丢失**，
 *   且流式累积时先 `slice(-MAX_CMD_OUT)` 又丢一次头。
 *
 * 所以：输出短就照旧内联返回（**不产生任何文件**，绝大多数命令走这条路）；
 * 一旦超过内联上限，整段落盘成一个「产物文件」，返回给模型的文本里写明
 * **id / 总长度 / 下一次该带什么参数**，模型用 `read_tool_output` 按 offset 继续读。
 *
 * ## 三条硬约束（都来自踩过的坑，别绕过）
 *
 * 1. **产物只能从实时数据流攒，不能事后从环形缓冲补。**
 *    环形缓冲是有损的，等命令跑完再 `outputFrom` 拿到的可能已经是空的。
 *    调用方必须在等待期间订阅 `sessionManager` 的 `data` 事件边收边喂进来。
 * 2. **id 不暴露路径。** 模型传回来的 id 必须过白名单正则（`[a-z0-9-]`），
 *    再拼成 `<root>/<id>.txt`；任何分隔符 / 点号都不合法 —— 否则等于让模型
 *    传 `../../` 读整台机器（对照 workspace-fs.ts 的 `resolveInside` 边界）。
 * 3. **id 里带会话 slug**（`<conv>-<时间36>-<随机>`），删会话时按前缀就能精确清理，
 *    不必在内存里维护一张 id → 会话的索引（重启后索引就没了）。
 *
 * 与 Electron 解耦：落盘根目录由 init 注入（同 terminal/history.ts 的 filePath），
 * 没注入就退到临时目录，探针可以在纯 Node 下直接跑这个真源码。
 */
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 默认内联上限：超过就落盘。约 3~4k token，对绝大多数命令绰绰有余 */
export const ARTIFACT_INLINE_MAX = 12_000
/** 内联时保留的头部字符数（命令回显 / 输出开头通常在这里） */
export const ARTIFACT_HEAD_CHARS = 3_000
/** 单个产物文件上限：再大就地截断并标 truncated，不无限吃磁盘 */
export const ARTIFACT_MAX_CHARS = 4 * 1024 * 1024
/** read_tool_output 单次返回上限（防模型一次要 10MB） */
export const ARTIFACT_READ_MAX = 20_000
/** 启动时清理比这更旧的产物（产物只在产生它的那一轮里有意义，不长期保留） */
const ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * 产物 id 白名单：只允许小写字母 / 数字 / 连字符。
 * 文件名由它拼成 `<id>.txt`，所以这一条同时挡住了路径穿越与 Windows 保留名。
 */
const ID_RE = /^[a-z0-9-]{6,80}$/

let rootDir: string | null = null

/**
 * 注入落盘根目录（userData/tool-output）。未注入时退到临时目录 ——
 * 探针可以直接跑真源码，不需要 Electron。
 */
export async function initArtifactStore(dir: string): Promise<void> {
  if (dir === rootDir) return
  rootDir = dir
  await mkdir(dir, { recursive: true }).catch(() => {})
  await sweepOldArtifacts(dir).catch(() => {})
}

function resolveRoot(): string {
  return rootDir ?? join(tmpdir(), 'dogi-tool-output')
}

/** 产物文件路径；非法 id 直接抛（不拼路径、不猜、不容错成根目录） */
function artifactPath(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`产物 id 非法：${id}`)
  return join(resolveRoot(), `${id}.txt`)
}

/** 会话 id → 文件名片段（uuid 天然合规，这里只是防御外部传进来的脏值） */
function slugify(conversationId: string): string {
  return (
    conversationId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'anon'
  )
}

/** 启动清扫：删掉过期产物，避免长期运行把磁盘堆满 */
async function sweepOldArtifacts(dir: string): Promise<void> {
  const now = Date.now()
  const files = await readdir(dir).catch(() => [] as string[])
  for (const name of files) {
    if (!name.endsWith('.txt')) continue
    const full = join(dir, name)
    const st = await stat(full).catch(() => null)
    if (st && now - st.mtimeMs > ARTIFACT_MAX_AGE_MS) await unlink(full).catch(() => {})
  }
}

/** 产物 id：`<会话slug>-<时间36>-<随机>`，天然过白名单，带时间戳便于排查 */
function newArtifactId(conversationId: string): string {
  return `${slugify(conversationId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------- ANSI 清理（可跨 chunk 的有状态版） ----------

/** 一条转义序列的完整形态：OSC/DCS/SOS/PM/APC + CSI + 单字符转义 */
const COMPLETE_RE =
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[DP^X][\s\S]*?\x1b\\|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[^\x1b]/g

function stripComplete(input: string): string {
  return input.replace(COMPLETE_RE, '')
}

/**
 * 有状态的 ANSI 清理器：一条转义序列完全可能被 TCP / PTY 切成两块
 * （`\x1b[3` + `2m`），逐块清理会把 `\x1b[` 当成「单字符转义」吃掉、把 `32m`
 * 当正文漏进模型上下文。
 *
 * 做法：**永远保留从最后一个 ESC 开始到块尾的内容**，下一块到来时再一起判。
 * 最后那条 ESC 之前的所有内容都是完整序列，可以放心清掉。
 *
 * ⚠️ 别偷懒改成「逐块 stripComplete」—— 那正是上面那个 bug 的成因
 * （`\x1b[` 匹配得上「单字符转义」那条分支，因为「单字符」规则排在 CSI 规则之后
 * 只在 CSI 匹配失败时才生效，而半条序列恰好匹配失败）。
 *
 * 保留区有上限：一直带转义的长流（每块开头都有 OSC）否则会把 pending 撑到无限长。
 */
export class AnsiStripper {
  /** 保留区上限（字符）：超过就强制按整块清理，宁可漏半条也不无限缓冲 */
  private static readonly MAX_HOLD = 512

  private pending = ''

  /** 喂一块原始文本，返回可以安全输出的部分（末尾可能留了半条序列） */
  push(chunk: string): string {
    if (!chunk) return ''
    const raw = this.pending + chunk
    let esc = raw.lastIndexOf('\x1b')
    if (esc >= 0 && raw.length - esc > AnsiStripper.MAX_HOLD) esc = -1
    if (esc >= 0) {
      this.pending = raw.slice(esc)
      return stripComplete(raw.slice(0, esc))
    }
    this.pending = ''
    return stripComplete(raw)
  }

  /** 收尾：把 pending 里残留的序列按整段规则清掉后吐出（仅在输出结束时调用） */
  flush(): string {
    const rest = this.pending
    this.pending = ''
    return stripComplete(rest).replace(/\x1b/g, '')
  }
}

/** 一次性清干净整段（没有跨块问题的场合，如读历史缓冲） */
export function stripAnsi(input: string): string {
  return stripComplete(input).replace(/\x1b/g, '')
}

// ---------- 写入器 ----------

export interface ArtifactDescriptor {
  id: string
  /** 完整内容的字符数（不是文件字节数） */
  totalChars: number
  /** 输出本身超过产物上限，中后段未保存 */
  truncated: boolean
}

export interface ArtifactResult {
  /** 没超内联上限时的完整文本（此时 descriptor 为 null，且**没有产生文件**） */
  inline: string
  /** 实际该返回给模型的文本 */
  text: string
  descriptor: ArtifactDescriptor | null
}

export interface ArtifactWriterOptions {
  conversationId: string
  toolCallId: string
  /** 内联上限，超出即落盘 */
  inlineMax?: number
  /** 内联时保留的头部字符数 */
  headChars?: number
  /** 边收边清 ANSI（终端 PTY 输出必须开；spawn 的子进程输出不用） */
  strip?: boolean
  /** 文件上限 */
  maxChars?: number
}

/**
 * 一次工具调用的输出收集器。
 *
 * 状态机只有两段：**内存**（攒到 inlineMax 为止）→ **落盘**（超出后 write-through）。
 * 切换点很关键：在「即将超限的那一块」到来**之前**就开文件并把已攒内容写出去，
 * 这样文件内容严格连续，`read_tool_output` 的 offset 才对得上。
 */
export class OutputArtifactWriter {
  private readonly conversationId: string
  private readonly inlineMax: number
  private readonly headChars: number
  private readonly maxChars: number
  private readonly stripper: AnsiStripper | null

  private head = ''
  private mid = ''
  private total = 0
  private written = 0
  private stream: WriteStream | null = null
  private id: string | null = null
  private truncated = false
  private finished = false

  constructor(opts: ArtifactWriterOptions) {
    this.conversationId = opts.conversationId
    this.inlineMax = opts.inlineMax ?? ARTIFACT_INLINE_MAX
    this.headChars = opts.headChars ?? ARTIFACT_HEAD_CHARS
    this.maxChars = opts.maxChars ?? ARTIFACT_MAX_CHARS
    this.stripper = opts.strip ? new AnsiStripper() : null
  }

  /** 喂一段输出（必须按发生顺序喂，产物是严格连续的） */
  append(raw: string): void {
    if (this.finished || !raw) return
    const text = this.stripper ? this.stripper.push(raw) : raw
    if (!text) return
    if (!this.stream && this.total + text.length > this.inlineMax) {
      // 先落盘再喂这一块：已攒的 head+mid 连续，这一块紧跟其后，文件才无洞
      this.spill()
    }
    if (this.stream) {
      const before = this.written
      this.writeRaw(text)
      this.total += this.written - before
    } else {
      this.total += text.length
    }
    // head / mid 是**滚动预览**，与文件写入互不影响：哪怕第一块就超过内联上限、
    // 已经 spill，头也照样要从这一块的前 headChars 个字符里填 —— 只给尾巴不给开头，
    // 模型连「命令是什么 / 报了什么错」都看不到。
    if (this.head.length < this.headChars) {
      const room = this.headChars - this.head.length
      this.head += text.slice(0, room)
      this.pushTail(text.slice(room))
    } else {
      this.pushTail(text)
    }
  }

  /** 维护滚动尾巴：只保留 inlineMax - head.length 个字符，超了从头丢 */
  private pushTail(text: string): void {
    this.mid += text
    const budget = Math.max(0, this.inlineMax - this.head.length)
    if (this.mid.length > budget) this.mid = this.mid.slice(-budget)
  }

  private spill(): void {
    const id = newArtifactId(this.conversationId)
    this.id = id
    this.stream = createWriteStream(artifactPath(id), { flags: 'w' })
    // 落盘失败（磁盘满 / 目录不存在）不能拖垮工具：写失败就退回纯截断
    this.stream.on('error', () => {
      this.truncated = true
    })
    // 已攒的 head+mid 在内存阶段就计入 total 了，这里只推进 written，不再加 total
    this.writeRaw(this.head + this.mid)
  }

  /** 写文件并推进 written；不碰 total（total 只按真正写进去的字符增长） */
  private writeRaw(text: string): void {
    if (!this.stream) return
    if (this.written >= this.maxChars) {
      this.truncated = true
      return
    }
    const room = this.maxChars - this.written
    const chunk = text.length > room ? text.slice(0, room) : text
    this.written += chunk.length
    if (chunk.length < text.length) this.truncated = true
    this.stream.write(chunk)
  }

  /** 收尾：返回该给模型的文本 + 产物描述符（未超限时 descriptor 为 null 且没落过盘） */
  async finish(): Promise<ArtifactResult> {
    if (this.finished) throw new Error('OutputArtifactWriter 只能 finish 一次')
    // stripper 的尾巴要在封口之前喂进去（此时 append 仍然生效）
    if (this.stripper) {
      const rest = this.stripper.flush()
      if (rest) this.append(rest)
    }
    this.finished = true

    if (!this.stream) {
      const inline = this.head + this.mid
      return { inline, text: inline, descriptor: null }
    }
    const stream = this.stream
    await new Promise<void>((resolve) => stream.end(() => resolve()))
    const descriptor: ArtifactDescriptor = {
      id: this.id!,
      totalChars: this.total,
      truncated: this.truncated
    }
    return { inline: '', text: renderArtifactText(descriptor, this.head, this.mid), descriptor }
  }
}

/**
 * 超限时给模型看的文本：头 + 省略说明（含精确的下一次调用参数）+ 尾。
 * 说明里必须写清 **总量** 与 **怎么继续读** —— 模型看不到全文时唯一的出路就是这句话。
 */
function renderArtifactText(d: ArtifactDescriptor, head: string, mid: string): string {
  const omitted = Math.max(0, d.totalChars - head.length - mid.length)
  return [
    head,
    '',
    `…（本次输出共 ${d.totalChars} 字符，超过内联上限，上面只给了开头 ${head.length} 与结尾 ${mid.length} 字符，` +
      `中间省略 ${omitted} 字符。`,
    `完整内容已保存为产物文件，用 read_tool_output 工具按段读取：` +
      `{"id":"${d.id}","offset":${head.length},"length":8000}，` +
      `之后把 offset 加上本次返回的长度继续读，直到读完全部 ${d.totalChars} 字符。` +
      (d.truncated ? '（该输出本身已超过产物上限，中后段未保存。）' : '') +
      '）…',
    '',
    mid
  ].join('\n')
}

// ---------- 读取 ----------

export interface ArtifactReadResult {
  id: string
  offset: number
  length: number
  totalChars: number
  /** 从 offset+length 起还剩多少字符 */
  remaining: number
  text: string
}

/**
 * 按**字符**偏移读一段。offset / length 与模型看到的文本口径一致（不是字节），
 * 中文 / emoji 才不会把偏移算歪；产物有 4MB 上限，整读进内存再切是可接受的。
 */
export async function readArtifact(
  id: string,
  offset = 0,
  length = 8000
): Promise<ArtifactReadResult> {
  const path = artifactPath(id)
  const st = await stat(path).catch(() => null)
  if (!st || !st.isFile()) throw new Error(`产物不存在或已过期：${id}`)
  const whole = await readAll(path)
  const totalChars = whole.length
  const start = Math.max(0, Math.min(offset, totalChars))
  const want = Math.max(0, Math.min(length, ARTIFACT_READ_MAX))
  const text = whole.slice(start, start + want)
  return {
    id,
    offset: start,
    length: text.length,
    totalChars,
    remaining: Math.max(0, totalChars - (start + text.length)),
    text
  }
}

function readAll(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const rs = createReadStream(path)
    rs.on('data', (c: string | Buffer) => chunks.push(Buffer.from(c)))
    rs.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    rs.on('error', reject)
  })
}

// ---------- 清理 ----------

/** 删掉某个会话的全部产物（工作区会话与终端会话都算），会话删除时调用 */
export async function purgeArtifacts(conversationId: string): Promise<void> {
  const dir = resolveRoot()
  const prefix = `${slugify(conversationId)}-`
  const files = await readdir(dir).catch(() => [] as string[])
  await Promise.all(
    files
      .filter((f) => f.startsWith(prefix) && f.endsWith('.txt'))
      .map((f) => unlink(join(dir, f)).catch(() => {}))
  )
}

/** 清空整个产物目录（应用退出时兜底，或测试用） */
export async function clearArtifacts(): Promise<void> {
  await rm(resolveRoot(), { recursive: true, force: true }).catch(() => {})
  await mkdir(resolveRoot(), { recursive: true }).catch(() => {})
}