/**
 * edit_file 的**容错匹配**：把模型给的 `oldText` 对应到文件里的**真实片段**。
 *
 * 为什么需要它：模型看到的原文是 read_file 加过行号的输出，写回来的 oldText
 * 很少与磁盘上的字节逐字节一致 —— 常见差异有
 * - 行尾被换掉（Windows 上文件是 CRLF，模型给的是 LF）；
 * - 缩进多/少一档、行尾空白被吃掉；
 * - 把 read_file 输出里的 `  42 | ` **行号前缀一起抄了进来**；
 * - `\n` / `\t` 被当成字面量转义写进字符串。
 *
 * 之前这里只有一句 `text.split(oldText)`：上面任何一种差异都会失败成
 * 「未找到要替换的内容」，模型看不到原因、只能把同一份错误文本反复重试。
 *
 * 做法照搬 opencode 的 edit 工具：**从最严格到最宽松依次退档**，任一步命中就用
 * 文件里的真实片段做替换（不是用模型给的字符串 —— 否则等于把差异写进文件）。
 * 退档顺序（每一档都只在前面全都没命中时才生效）：
 *   1. 逐字节相同（先按文件的换行风格对齐一次）
 *   2. 逐行 trim 后相同（行首行尾空白差异）
 *   3. 只忽略行首缩进（缩进档位不同、行尾空白一致）
 *   4. 行内空白折叠后相同（空格数量不同）
 *   5. 首尾行锚点 + 中间行相似度（长块里个别行有小差异）
 *   6. 去掉首尾空行后重跑 2~5（框选时多带了几行空行）
 *   7. 还原反斜杠转义后重跑 1~6
 *   8. 剥掉 read_file 的行号前缀后重跑 1~7
 *
 * 全部失败时抛错，并尽量给出**可操作的线索**（oldText 首行在文件第几行出现过），
 * 而不是一句干巴巴的「未找到」。
 *
 * 匹配在「LF 归一化」的文本上做（把 `\r\n` 折成 `\n`），但**替换发生在原文上**：
 * 命中区间会映射回原文下标，插入的文本也按该处的换行风格对齐 —— 所以
 * CRLF 文件改完还是 CRLF，不会因为一次编辑把整个文件的行尾洗一遍。
 */

/** 命中区间（下标指向「LF 归一化文本」，用前先映射回原文） */
interface Span {
  start: number
  end: number
  /**
   * 命中**单独一行**时，该行的行首缩进。
   * 模型给的 oldText 常常是「去掉缩进的整行」（`const port = 3000`），
   * 而文件里是 `    const port = 3000` —— 这时整行会被替换掉，缩进得由我们补回去。
   */
  indent?: string
}

/** 归一化后的文本 + 行索引（行首偏移表 + 回原文的下标映射） */
interface LfText {
  /** `\r\n` 折成 `\n` 的文本：所有匹配都在它上面做 */
  lf: string
  /** `lf.split('\n')`（行尾不带 `\r`） */
  lines: string[]
  /** 每行在 `lf` 里的起始下标，与 `lines` 一一对应 */
  starts: number[]
  /**
   * `lf` 下标 → 原文下标。原文本来就没有 `\r` 时是 null（此时两者同构，省一张表）。
   * ⚠️ 折叠掉的那个 `\r` 没有映射项，所以映射区间末端要用 `toOriginalEnd`。
   */
  toOriginal: number[] | null
}

/** 一次编辑的结果 */
export interface TolerantEditResult {
  /** 替换后的全文（保留文件原本的换行风格） */
  text: string
  /** 实际替换了几处（同一片段出现多次时全部替换） */
  count: number
  /** 命中用的策略说明（空串 = 逐字节精确命中，不需要解释） */
  note: string
}

/** 策略名 → 给模型看的说明（空 = 精确命中，不用多说） */
const NOTES: Record<string, string> = {
  exact: '',
  lineTrimmed: '忽略了行首行尾空白差异',
  indentation: '忽略了缩进差异',
  whitespace: '忽略了空格数量差异',
  blockAnchor: '按首尾行锚点匹配',
  trimmedBlock: '忽略了首尾空行差异',
  escaped: '把字面量转义还原成真实字符后匹配',
  lineNumberPrefix: '剥掉了 read_file 输出的行号前缀'
}

/** 只在「行」这一层退让的策略（不含精确命中）：单行命中时要补回缩进 */
const LINE_LEVEL_STRATEGIES = new Set([
  'lineTrimmed',
  'indentation',
  'whitespace',
  'blockAnchor',
  'trimmedBlock'
])

// ---------------------------------------------------------------------------
// 归一化 / 映射
// ---------------------------------------------------------------------------

function buildLineIndex(lf: string): { lines: string[]; starts: number[] } {
  const lines = lf.split('\n')
  const starts: number[] = new Array(lines.length)
  let off = 0
  for (let i = 0; i < lines.length; i += 1) {
    starts[i] = off
    off += lines[i].length + 1
  }
  return { lines, starts }
}

function normalize(text: string): LfText {
  // 没有 \r 时不需要建映射表：lf 与原文逐字节同构
  if (!text.includes('\r')) {
    const { lines, starts } = buildLineIndex(text)
    return { lf: text, lines, starts, toOriginal: null }
  }

  const chars: string[] = []
  const map: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    // 丢掉 \r\n 里的 \r：换行只留 \n，映射表里就不需要它
    if (ch === '\r' && text[i + 1] === '\n') continue
    map.push(i)
    chars.push(ch)
  }
  const lf = chars.join('')
  const { lines, starts } = buildLineIndex(lf)
  return { lf, lines, starts, toOriginal: map }
}

function toOriginalStart(ctx: LfText, index: number): number {
  return ctx.toOriginal ? ctx.toOriginal[index] : index
}

function toOriginalEnd(ctx: LfText, index: number): number {
  // 用区间末端查：跨行命中时末尾那个字符一定在原文里（折叠掉的 \r 只出现在行中间）。
  // 没有映射表时原文与 lf 同构，末端下标就是 index + 1（**排他**端点，别再 -1）。
  return ctx.toOriginal ? ctx.toOriginal[index] + 1 : index + 1
}

/** 某个片段在 lf 里出现的每一处 */
function findAll(ctx: LfText, search: string): Span[] {
  if (!search) return []
  const spans: Span[] = []
  let from = 0
  for (;;) {
    const at = ctx.lf.indexOf(search, from)
    if (at === -1) return spans
    spans.push({ start: at, end: at + search.length })
    from = at + search.length
  }
}

/** 第 first~last 行（含）构成的区间；单行带上缩进提示 */
function lineSpan(ctx: LfText, first: number, last: number): Span {
  const span: Span = { start: ctx.starts[first], end: ctx.starts[last] + ctx.lines[last].length }
  if (first === last) span.indent = /^[ \t]*/.exec(ctx.lines[first])?.[0] ?? ''
  return span
}

/** 逐行比较的滑动窗口：任意一行的比较不成立就换下一段 */
function findLineWindow(
  ctx: LfText,
  oldLines: string[],
  equal: (contentLine: string, oldLine: string) => boolean
): Span[] {
  const n = oldLines.length
  if (n === 0 || n > ctx.lines.length) return []
  const spans: Span[] = []
  for (let i = 0; i + n <= ctx.lines.length; i += 1) {
    let hit = true
    for (let k = 0; k < n; k += 1) {
      if (!equal(ctx.lines[i + k], oldLines[k])) {
        hit = false
        break
      }
    }
    if (hit) spans.push(lineSpan(ctx, i, i + n - 1))
  }
  return spans
}

const collapseSpaces = (line: string): string => line.replace(/[ \t]+/g, ' ').trim()
const stripIndent = (line: string): string => line.replace(/^[ \t]+/, '')

// ---------------------------------------------------------------------------
// 各档策略
// ---------------------------------------------------------------------------

/** 第 5 档：首尾行锚点，中间行只要过半相似就认（长块里个别行被模型改动过） */
function findBlockAnchor(ctx: LfText, oldLines: string[]): Span[] {
  const n = oldLines.length
  if (n < 3) return []
  const first = oldLines[0].trim()
  const last = oldLines[n - 1].trim()
  if (!first || !last) return []
  const spans: Span[] = []
  for (let i = 0; i + n <= ctx.lines.length; i += 1) {
    if (ctx.lines[i].trim() !== first) continue
    if (ctx.lines[i + n - 1].trim() !== last) continue
    let same = 0
    let total = 0
    for (let k = 1; k < n - 1; k += 1) {
      const a = ctx.lines[i + k].trim()
      const b = oldLines[k].trim()
      if (!a && !b) continue
      total += 1
      if (a === b) same += 1
    }
    // 首尾行已经严格相等，中间行相似度过半就认，误伤概率很低
    if (total === 0 || same / total >= 0.5) spans.push(lineSpan(ctx, i, i + n - 1))
  }
  return spans
}

/** 行级的四档退让（2~5），命中返回对应的策略名 */
function matchByLines(ctx: LfText, oldLines: string[]): { spans: Span[]; strategy: string } | null {
  const lineTrimmed = findLineWindow(ctx, oldLines, (a, b) => a.trim() === b.trim())
  if (lineTrimmed.length > 0) return { spans: lineTrimmed, strategy: 'lineTrimmed' }

  const indentation = findLineWindow(ctx, oldLines, (a, b) => stripIndent(a) === stripIndent(b))
  if (indentation.length > 0) return { spans: indentation, strategy: 'indentation' }

  const whitespace = findLineWindow(ctx, oldLines, (a, b) => collapseSpaces(a) === collapseSpaces(b))
  if (whitespace.length > 0) return { spans: whitespace, strategy: 'whitespace' }

  const blockAnchor = findBlockAnchor(ctx, oldLines)
  if (blockAnchor.length > 0) return { spans: blockAnchor, strategy: 'blockAnchor' }

  return null
}

/** 去掉首尾的空行（模型框选时多带上几行空行是常事） */
function pruneBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start += 1
  while (end > start && !lines[end - 1].trim()) end -= 1
  return lines.slice(start, end)
}

/**
 * 把模型可能多写的字面量转义还原：`\n` → 换行、`\t` → 制表符、`\"` → 引号等。
 * 只在确实含反斜杠转义且能还原出变化时才返回新串，否则返回 null（不参与退档）。
 */
function unescapeLiterals(text: string): string | null {
  if (!/\\[ntr"'`\\/]/.test(text)) return null
  const restored = text.replace(/\\([ntr"'`\\/])/g, (_all, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      default:
        return ch
    }
  })
  return restored === text ? null : restored
}

/** read_file 输出的行号前缀：`   42 | code`（缩进 + 数字 + 竖线 + 一个空格） */
const LINE_NUMBER_PREFIX_RE = /^[ \t]*\d+[ \t]*\|[ \t]?/

/**
 * 剥掉 read_file 的行号前缀（第 8 档兜底）。
 * 要求**每一行非空行都带前缀**才认，否则返回 null —— 免得把「正文里恰好有
 * `12 | xxx` 这种内容」的文件误判成抄了行号。
 */
function stripLineNumberPrefix(text: string): string | null {
  const lines = text.split('\n')
  const body = lines.filter((line) => line.trim())
  if (body.length === 0) return null
  if (!body.every((line) => LINE_NUMBER_PREFIX_RE.test(line))) return null
  const stripped = lines
    .map((line) => (line.trim() ? line.replace(LINE_NUMBER_PREFIX_RE, '') : line))
    .join('\n')
  return stripped === text ? null : stripped
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface MatchResult {
  spans: Span[]
  strategy: string
}

/** 按「严格 → 宽松」找 oldText；找不到返回 null */
function findMatch(ctx: LfText, rawOld: string, allowDeepFallback: boolean): MatchResult | null {
  // 模型给的行尾可能是 CRLF，统一折成 LF 再比（文件侧已经在 lf 里折过了）
  const old = rawOld.replace(/\r\n/g, '\n')

  const exact = findAll(ctx, old)
  if (exact.length > 0) return { spans: exact, strategy: 'exact' }

  const oldLines = old.split('\n')
  const direct = matchByLines(ctx, oldLines)
  if (direct) return direct

  // 去掉首尾空行再来一遍（模型框选时多带的行）
  const pruned = pruneBlankLines(oldLines)
  if (pruned.length > 0 && pruned.length !== oldLines.length) {
    const hit = matchByLines(ctx, pruned)
    if (hit) return { spans: hit.spans, strategy: 'trimmedBlock' }
  }

  if (!allowDeepFallback) return null

  // 第 7 档：还原字面量转义（`\n` 被当成两个字符传了进来）
  const unescaped = unescapeLiterals(old)
  if (unescaped) {
    const hit = findMatch(ctx, unescaped, false)
    if (hit) return { ...hit, strategy: 'escaped' }
  }

  // 第 8 档：剥掉 read_file 的行号前缀
  const stripped = stripLineNumberPrefix(old)
  if (stripped) {
    const hit = findMatch(ctx, stripped, false)
    if (hit) return { ...hit, strategy: 'lineNumberPrefix' }
  }

  return null
}

/** 把 newText 的换行对齐到目标处的风格，免得往 CRLF 文件里插 LF */
function alignEol(text: string, eol: string): string {
  if (eol === '\r\n') return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  return text.replace(/\r\n/g, '\n')
}

/** 逐处替换（从后往前，前面的下标才不会因为长度变化错位） */
function replaceSpans(
  ctx: LfText,
  text: string,
  spans: Span[],
  newText: string,
  hintIndent: boolean
): string {
  // 单行命中时片段里没有换行，用文件整体的风格兜底
  const fileEol = text.includes('\r\n') ? '\r\n' : '\n'
  let out = text
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i]
    const start = toOriginalStart(ctx, span.start)
    const end = toOriginalEnd(ctx, span.end - 1)
    const hit = text.slice(start, end)
    let replacement = alignEol(newText, hit.includes('\r\n') ? '\r\n' : fileEol)
    // 整行被替换、而模型给的 oldText/newText 都没写缩进：把原行的缩进补回去
    if (hintIndent && span.indent) replacement = span.indent + replacement
    out = out.slice(0, start) + replacement + out.slice(end)
  }
  return out
}

/** 失败时的说明：给出「oldText 首行在文件第几行出现过」这类可操作线索 */
function describeMiss(ctx: LfText, old: string): string {
  const preview = old.split('\n').slice(0, 6).join('\n')
  const head = `未找到要替换的内容（已按「忽略行尾 / 缩进 / 空白差异」逐档重试）：\n${preview}`
  const firstLine = old
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return `${head}\n请先 read_file 确认这个文件的原文。`
  const lineNo = ctx.lines.findIndex((line) => line.trim() === firstLine)
  if (lineNo >= 0) {
    return `${head}\n文件中第 ${lineNo + 1} 行的内容与 oldText 首行一致，但后面几行对不上 —— 常见原因是原文已经改过、缩进抄错，或 oldText 里混进了 read_file 输出的「行号 | 」前缀。请重新 read_file 核对后再编辑。`
  }
  return `${head}\noldText 的首行在文件里也找不到完全一致的行 —— 请先 read_file 重新确认原文（注意不要带输出里的「行号 | 」前缀）。`
}

/**
 * 用容错匹配把 `oldText` 换成 `newText`（同一片段出现多处时全部替换）。
 *
 * @param text 文件全文（原样读进来的内容）
 * @throws 任何一档都没命中时抛错，错误里带可操作线索
 */
export function applyTolerantEdit(text: string, oldText: string, newText: string): TolerantEditResult {
  if (!oldText.trim()) throw new Error('oldText 不能为空')

  const ctx = normalize(text)
  const match = findMatch(ctx, oldText, true)
  if (!match) throw new Error(describeMiss(ctx, oldText.replace(/\r\n/g, '\n')))

  /*
   * 整行级的退档命中，配上「双方都没写缩进」的单行 oldText/newText 时补回原缩进：
   * 模型常把 `    const port = 3000` 写成 `const port = 3000`（缩进在它看来的
   * read_file 输出里是和行号前缀一起被它丢掉的），命中后整行会被替换，不补回去
   * 等于顺手把缩进删了。
   */
  const hintIndent =
    LINE_LEVEL_STRATEGIES.has(match.strategy) &&
    !oldText.includes('\n') &&
    !newText.includes('\n') &&
    !/^[ \t]/.test(oldText) &&
    !/^[ \t]/.test(newText)

  const next = replaceSpans(ctx, text, match.spans, newText, hintIndent)
  if (next === text) {
    throw new Error(
      '新旧内容相同：newText 与命中的原文一模一样，没有任何改动（检查是不是把 newText 又写成了原文）'
    )
  }
  return { text: next, count: match.spans.length, note: NOTES[match.strategy] ?? '' }
}
