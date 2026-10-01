/**
 * edit_file 的匹配引擎：在文件内容里定位 oldString 并完成替换。
 *
 * 模型给出的 oldString 经常和文件内容有细小出入（缩进对不齐、空白被压扁、
 * 行尾转义没还原……）。只做严格匹配会让「找不到 oldString」成为 edit 失败的主因，
 * 所以这里移植了 opencode 的模糊匹配链（其来源是 cline / gemini-cli 的实战沉淀）：
 * 一系列 Replacer 逐个尝试，从「精确匹配」到「块锚点 + Levenshtein 相似度」逐级放宽，
 * 第一个能**唯一命中**的 replacer 赢。多候选歧义时宁可报错让模型补充上下文，绝不猜。
 *
 * 另有两道护栏：
 * - 匹配范围远大于 oldString（锚点抓错了块）时拒绝替换；
 * - 文件是 CRLF 时由调用方先把 oldString/newString 归一成文件的换行符（见
 *   detectLineEnding / convertToLineEnding），本模块内部按 LF 思路工作。
 *
 * 纯函数、零依赖 —— 可以 `node --experimental-strip-types` 直接跑（见
 * scripts/verify-agent-edit-match.ts）。
 */

/** 换行符归一：把 \r\n 压成 \n（用于比较与 diff 计算） */
export function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

/** 探测文本的主导换行符：只要出现过 \r\n 就按 CRLF 处理 */
export function detectLineEnding(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** 把以 \n 表达的文本转换成指定换行符 */
export function convertToLineEnding(text: string, ending: '\n' | '\r\n'): string {
  if (ending === '\n') return text
  return text.replaceAll('\n', '\r\n')
}

/** 一个 Replacer：在 content 里找出「可能是 oldString 对应片段」的候选串，逐个 yield */
export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

/** 块锚点匹配的相似度阈值（cline / opencode 实测值） */
const SIMILARITY_THRESHOLD = 0.65

function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') return Math.max(a.length, b.length)
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

/** 精确匹配（保底，也是唯一一定能命中的路径） */
export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

/** 逐行 trim 后比对：模型的缩进与文件不一致时仍能定位（替换回文件原文，保留原缩进） */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')
  if (searchLines[searchLines.length - 1] === '') searchLines.pop()

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false
        break
      }
    }
    if (!matches) continue
    let matchStartIndex = 0
    for (let k = 0; k < i; k++) matchStartIndex += originalLines[k].length + 1
    let matchEndIndex = matchStartIndex
    for (let k = 0; k < searchLines.length; k++) {
      matchEndIndex += originalLines[i + k].length
      if (k < searchLines.length - 1) matchEndIndex += 1
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

/**
 * 块锚点：≥3 行的查找块，取首尾两行当锚点，中间行按 Levenshtein 相似度判定。
 * 覆盖「中间若干行被模型记岔了」的场景；多候选时取相似度最高的一块。
 */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')
  if (searchLines.length < 3) return
  if (searchLines[searchLines.length - 1] === '') searchLines.pop()

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break
      }
    }
  }
  if (candidates.length === 0) return

  const blockSimilarity = (startLine: number, endLine: number): number => {
    const actualBlockSize = endLine - startLine + 1
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck <= 0) return 1.0
    let similarity = 0
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const originalLine = originalLines[startLine + j].trim()
      const searchLine = searchLines[j].trim()
      const maxLen = Math.max(originalLine.length, searchLine.length)
      if (maxLen === 0) continue
      similarity += 1 - levenshtein(originalLine, searchLine) / maxLen
    }
    return similarity / linesToCheck
  }

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    // 单候选放宽阈值达成前允许提前退出（与 opencode 一致：算到阈值即收）
    let similarity = 0
    const actualBlockSize = endLine - startLine + 1
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck <= 0) {
      similarity = 1.0
    } else {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) continue
        similarity += (1 - levenshtein(originalLine, searchLine) / maxLen) / linesToCheck
        if (similarity >= SIMILARITY_THRESHOLD) break
      }
    }
    if (similarity >= SIMILARITY_THRESHOLD) {
      yield blockAt(originalLines, content, startLine, endLine)
    }
    return
  }

  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1
  for (const candidate of candidates) {
    const similarity = blockSimilarity(candidate.startLine, candidate.endLine)
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }
  if (maxSimilarity >= SIMILARITY_THRESHOLD && bestMatch) {
    yield blockAt(originalLines, content, bestMatch.startLine, bestMatch.endLine)
  }
}

/** 取 originalLines[start..end] 对应的原文切片（含中间的换行符） */
function blockAt(originalLines: string[], content: string, startLine: number, endLine: number): string {
  let matchStartIndex = 0
  for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1
  let matchEndIndex = matchStartIndex
  for (let k = startLine; k <= endLine; k++) {
    matchEndIndex += originalLines[k].length
    if (k < endLine) matchEndIndex += 1
  }
  return content.substring(matchStartIndex, matchEndIndex)
}

/** 空白归一：所有连续空白视为一个空格后比对（能容忍行内多空格 / 制表符差异） */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim()
  const normalizedFind = normalizeWhitespace(find)

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
      continue
    }
    const normalizedLine = normalizeWhitespace(line)
    if (normalizedLine.includes(normalizedFind)) {
      const words = find.trim().split(/\s+/)
      if (words.length > 0) {
        const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
        try {
          const match = line.match(new RegExp(pattern))
          if (match) yield match[0]
        } catch {
          // 非法模式就跳过
        }
      }
    }
  }

  const findLines = find.split('\n')
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join('\n')) === normalizedFind) {
        yield block.join('\n')
      }
    }
  }
}

/** 缩进弹性：把两侧都去掉公共前导缩进后比对（模型复制时整体多一层 / 少一层缩进） */
export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split('\n')
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text
    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      })
    )
    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n')
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split('\n')
  const findLines = find.split('\n')

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n')
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

/** 转义归一：模型把 \n \t \" 等按字面转义序列发出来时还原后比对 */
export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar: string) => {
      switch (capturedChar) {
        case 'n':
          return '\n'
        case 't':
          return '\t'
        case 'r':
          return '\r'
        case "'":
          return "'"
        case '"':
          return '"'
        case '`':
          return '`'
        case '\\':
          return '\\'
        case '\n':
          return '\n'
        case '$':
          return '$'
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)
  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  const lines = content.split('\n')
  const findLines = unescapedFind.split('\n')
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    if (unescapeString(block) === unescapedFind) {
      yield block
    }
  }
}

/** 边界 trim：find 首尾带了多余空白行时，用 trim 后的版本匹配 */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()
  if (trimmedFind === find) return
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  const lines = content.split('\n')
  const findLines = find.split('\n')
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

/** 上下文感知：首尾两行锚定 + 中间行 50% 以上 trim 相等即认为命中（只取第一处） */
export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split('\n')
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === '') findLines.pop()

  const contentLines = content.split('\n')
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join('\n')
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0
          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()
            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) matchingLines++
            }
          }
          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break
          }
        }
        break
      }
    }
  }
}

/** 多次出现：逐个 yield 每处精确匹配（配合 replaceAll 或「多处即报错」的判定） */
export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0
  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break
    yield find
    startIndex = index + find.length
  }
}

/** 匹配范围远大于 oldString（锚点抓错块）：替换它等于大面积改写，必须拒绝 */
function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split('\n').length
  const searchLines = search.split('\n').length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}

/**
 * 在 content 里定位 oldString 并替换为 newString。
 *
 * - `replaceAll: false` 时候选必须**唯一命中**（首尾 indexOf 相同），否则报错让模型扩大上下文；
 * - `replaceAll: true` 时用第一个命中的候选串替换全部出现；
 * - 模糊链按顺序尝试：简单 → 行 trim → 块锚点 → 空白归一 → 缩进弹性 → 转义归一 →
 *   边界 trim → 上下文感知 → 多次出现。
 *
 * 返回替换后的全文与替换处数（replaceAll 时的出现次数；唯一替换恒为 1）。
 * 抛错的 message 直接面向模型，请保持可执行的纠正指引。
 */
export function replaceContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): { text: string; count: number } {
  if (oldString === newString) {
    throw new Error('oldString 与 newString 相同，没有可应用的修改。')
  }

  let foundAny = false

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      foundAny = true
      if (isDisproportionateMatch(search, oldString)) {
        throw new Error(
          '匹配到的范围远大于 oldString，疑似首尾锚点抓错了代码块。请重新 read_file，并基于最新内容提供完整、精确的 oldString。'
        )
      }
      if (replaceAll) {
        return { text: content.replaceAll(search, newString), count: content.split(search).length - 1 }
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return { text: content.substring(0, index) + newString + content.substring(index + search.length), count: 1 }
    }
  }

  if (foundAny) {
    throw new Error(
      'oldString 在文件中匹配到多处。请扩大 oldString 的上下文使其唯一，或改用 replaceAll: true 全部替换。'
    )
  }
  throw new Error(
    '未能在文件中找到 oldString。它必须与文件内容完全一致（空白、缩进、换行都对上）——请先 read_file 再从输出中复制原文，注意不要把「行号: 」前缀带进来。'
  )
}
