/**
 * edit_file 匹配引擎（`services/ai/agent-core/edit-match.ts`）验证：不起 Electron，直接跑真源码。
 *
 * 匹配链移植自 opencode（其来源是 cline / gemini-cli 的实战沉淀）：模型给的 oldString
 * 与文件内容有细小出入时逐级放宽（行 trim → 块锚点 Levenshtein → 空白归一 → 缩进弹性
 * → 转义归一 → 边界 trim → 上下文感知）；歧义（多处命中）宁可报错也不猜。
 *
 * 覆盖：精确替换、找不到 / 多处的报错、replaceAll、各模糊 replacer 的触发场景、
 * 过大匹配拒绝、oldString === newString、换行符辅助函数。
 *
 * 跑：node --experimental-strip-types scripts/verify-agent-edit-match.ts
 */

import assert from 'node:assert/strict'
import {
  convertToLineEnding,
  detectLineEnding,
  normalizeLineEndings,
  replaceContent
} from '../src/main/services/ai/agent-core/edit-match.ts'

let pass = 0
let fail = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log('  PASS ' + name)
  } catch (err) {
    fail++
    console.log('  FAIL ' + name + ' — ' + String((err as Error).message).slice(0, 300))
  }
}

/** 期望抛错并校验文案特征 */
function expectThrow(name: string, fn: () => unknown, pattern: RegExp): void {
  check(name, () => {
    assert.throws(fn, (e: Error) => pattern.test(e.message))
  })
}

console.log('\n[1] 精确匹配 / 报错路径')
check('精确替换（唯一命中）', () => {
  const r = replaceContent('const a = 1\nconst b = 2\n', 'const b = 2', 'const b = 3')
  assert.equal(r.text, 'const a = 1\nconst b = 3\n')
  assert.equal(r.count, 1)
})
expectThrow('找不到 oldString → 报错并提示先 read_file', () => {
  replaceContent('hello world', 'hello brave world', 'x')
}, /未能.*oldString|read_file/)
expectThrow('多处命中（未开 replaceAll）→ 报错并提示扩大上下文或 replaceAll', () => {
  replaceContent('foo();\nfoo();\n', 'foo();', 'bar();')
}, /多处|replaceAll/)
check('replaceAll 全部替换并给出处数', () => {
  const r = replaceContent('foo();\nfoo();\nfoo();\n', 'foo();', 'bar();', true)
  assert.equal(r.text, 'bar();\nbar();\nbar();\n')
  assert.equal(r.count, 3)
})
expectThrow('oldString === newString → 报错', () => {
  replaceContent('abc', 'abc', 'abc')
}, /相同|没有可应用/)

console.log('\n[2] 模糊匹配链（模型 oldString 有细小出入时仍能命中）')
check('LineTrimmed：缩进不一致也能定位（替换内容以模型的 newString 为准）', () => {
  const content = 'function f() {\n    return 1\n}\n'
  // 模型给的是不带缩进的版本
  const r = replaceContent(content, 'function f() {\nreturn 1\n}', 'function f() {\nreturn 2\n}')
  assert.equal(r.text, 'function f() {\nreturn 2\n}\n')
})
check('BlockAnchor：≥3 行块中间一行记岔，首尾锚点命中', () => {
  const content = ['a1', 'b2', 'c33', 'd4', 'e5'].join('\n')
  // 中间行 c33 被模型记成 c3（1 字符之差，Levenshtein 相似度远超阈值）
  const r = replaceContent(content, 'a1\nb2\nc3\nd4\ne5', 'a1\nb2\nCX\nd4\ne5')
  assert.equal(r.text, ['a1', 'b2', 'CX', 'd4', 'e5'].join('\n'))
})
check('WhitespaceNormalized：行内多空格被压扁时命中', () => {
  const content = 'let  x   =  1\n'
  const r = replaceContent(content, 'let x = 1', 'let x = 2')
  assert.equal(r.text, 'let x = 2\n')
})
check('IndentationFlexible：模型整体多缩进一层', () => {
  const content = 'if (ok) {\n    doWork()\n    cleanup()\n}\n'
  const r = replaceContent(content, '    doWork()\n    cleanup()', '    doOther()')
  assert.equal(r.text, 'if (ok) {\n    doOther()\n}\n')
})
check('EscapeNormalized：模型发的是字面 \\n 转义序列', () => {
  const content = 'print("a\\nb")\n'
  // 模型把实际换行写成了字面的反斜杠 n
  const r = replaceContent(content, 'print("a\\nb")'.replace('\\n', '\\n'), 'print("c")')
  assert.equal(r.text, 'print("c")\n')
})
check('TrimmedBoundary：查找块首尾多出空行（行内片段场景，更早的逐行 trim 接不住）', () => {
  // 模型在块前多写了两个空行：精确匹配不上、逐行 trim 需要整行对齐也接不住，
  // 靠「trim 后的块在文件里唯一出现」兜底
  const r = replaceContent('start\nfoo bar\nend\n', '\n\nfoo bar\nend', 'X')
  assert.equal(r.text, 'start\nX\n')
})
check('ContextAware：首尾锚定 + 中间过半相同', () => {
  const content = ['head', 'x1', 'x2', 'keep', 'tail'].join('\n')
  // 中间 x1/x2 完全不同，但 keep 行相同（2/3 > 50%）
  const r = replaceContent(content, 'head\nx1\nx2\nkeep\ntail', 'head\nY1\nY2\nkeep\ntail')
  assert.equal(r.text, ['head', 'Y1', 'Y2', 'keep', 'tail'].join('\n'))
})
expectThrow('模糊候选多处命中 → 仍报「多处」（不猜）', () => {
  // 同一块出现两次：LineTrimmed 每处都 yield，唯一性校验必须拦下
  const content = 'if (a) {\n    work()\n}\nif (b) {\n    work()\n}\n'
  replaceContent(content, 'work()', 'rest()')
}, /多处|replaceAll/)
expectThrow('过大匹配（转义还原把匹配范围撑大）→ 拒绝替换', () => {
  // 模型把多行内容压成了字面转义序列：还原后横跨 4 行，远大于 oldString 本身
  const content = 'a\nb\nc\nd\ntail'
  replaceContent(content, 'a\\nb\\nc\\nd', 'x')
}, /远大于|锚点/)

console.log('\n[3] 换行符辅助（CRLF 文件的编辑前提）')
check('detectLineEnding：LF / CRLF / 混合按 CRLF', () => {
  assert.equal(detectLineEnding('a\nb'), '\n')
  assert.equal(detectLineEnding('a\r\nb'), '\r\n')
  assert.equal(detectLineEnding('a\nb\r\nc'), '\r\n')
})
check('normalizeLineEndings / convertToLineEnding 往返', () => {
  assert.equal(normalizeLineEndings('a\r\nb\r\n'), 'a\nb\n')
  assert.equal(convertToLineEnding('a\nb', '\r\n'), 'a\r\nb')
  assert.equal(convertToLineEnding('a\nb', '\n'), 'a\nb')
})
check('CRLF 文件 + LF 的 oldString：归一后精确替换，文件保持 CRLF', () => {
  const crlf = 'function f() {\r\n    return 1\r\n}\r\n'
  const ending = detectLineEnding(crlf)
  const old = convertToLineEnding(normalizeLineEndings('function f() {\n    return 1\n}'), ending)
  const replacement = convertToLineEnding(normalizeLineEndings('function f() {\n    return 2\n}'), ending)
  const r = replaceContent(crlf, old, replacement)
  assert.equal(r.text, 'function f() {\r\n    return 2\r\n}\r\n')
})

console.log('\n===== 通过 ' + pass + ' / 失败 ' + fail + ' =====')
process.exit(fail ? 1 : 0)
