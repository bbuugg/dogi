/**
 * 工具长输出产物（output-artifact）验证。
 *
 * 直接跑 `services/ai/output-artifact.ts` 与 `services/ai/artifact-tools.ts` 的真源码
 * （copy-and-rewrite 到 .artifacttest/ 改写 @shared / 相对导入说明符，同
 * verify-acp-history.ts 的做法），不需要 Electron。
 *
 * 覆盖：
 *  1. 短输出：原样内联，**不产生任何文件**
 *  2. 超内联上限：落盘，返回文本里带 id / 总长度 / 下一次的 offset
 *  3. read_tool_output 按 offset 分段读完，全文与原始输出一致（含中文 / emoji）
 *  4. 跨 chunk 撕裂的 ANSI 序列不会漏进内容（AnsiStripper）
 *  5. 非法 id（路径穿越 / 点号 / 分隔符）一律拒绝
 *  6. 产物文件上限：超出标 truncated
 *  7. purgeArtifacts 只删本会话的产物
 *  8. 环形缓冲回归：>256KB 的输出经产物路径不再变成空串（本次修的 bug）
 *
 * 跑法：node scripts/verify-output-artifact.mjs
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.artifacttest')
const TMP = await mkdtemp(join(tmpdir(), 'dogi-artifact-'))

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`)
  }
}
const section = (t) => console.log(`\n${t}`)

// ---------- 准备：拷贝真源码并改写导入说明符 ----------
await rm(WORK, { recursive: true, force: true })
await mkdir(WORK, { recursive: true })

const ART_DIR = join(ROOT, 'src/main/services/ai')

async function copyRewrite(rel, rewrites) {
  const src = join(ART_DIR, rel)
  const text = await (await import('node:fs/promises')).readFile(src, 'utf8')
  let out = text
  for (const [from, to] of rewrites) out = out.split(from).join(to)
  const dest = join(WORK, rel.replace(/\//g, '__'))
  await writeFile(dest, out, 'utf8')
  return dest
}

const artifactPath = await copyRewrite('output-artifact.ts', [
  ["from 'node:", "from 'node:"]
])
const toolPath = await copyRewrite('artifact-tools.ts', [
  ["'./output-artifact'", `'./${artifactPath.split(/[\\/]/).pop()}'`],
  ["'./tool-registry'", "'./tool-registry.ts'"]
])
// artifact-tools 只用到 type import，Node 剥类型后不会真去解析，但保险起见给个空壳
await writeFile(
  join(WORK, 'tool-registry.ts'),
  'export type AiToolDef = any\nexport type ToolRunContext = any\n',
  'utf8'
)

const art = await import(pathToFileURL(artifactPath).href)
const tools = await import(pathToFileURL(toolPath).href)

const dir = join(TMP, 'store')
await art.initArtifactStore(dir)

// ---------- 1. 短输出：内联且不落盘 ----------
section('1. 短输出内联，不产生文件')
{
  const w = new art.OutputArtifactWriter({ conversationId: 'conv-a', toolCallId: 'c1' })
  w.append('hello ')
  w.append('world')
  const r = await w.finish()
  check('原文返回', r.text === 'hello world', JSON.stringify(r.text))
  check('无产物描述符', r.descriptor === null)
  check('目录里没有文件', (await readdir(dir)).length === 0, (await readdir(dir)).join(','))
}

// ---------- 2. 超限：落盘 + 文本里给 id / 总长 / 下次 offset ----------
section('2. 超内联上限落盘，返回可续读的指引')
let longId = null
let longTotal = 0
{
  const w = new art.OutputArtifactWriter({
    conversationId: 'conv-a',
    toolCallId: 'c2',
    inlineMax: 1000,
    headChars: 100
  })
  const full = 'A'.repeat(5000)
  // 分 7 块喂，模拟真实流式
  for (let i = 0; i < full.length; i += 700) w.append(full.slice(i, i + 700))
  const r = await w.finish()
  check('拿到产物 id', !!r.descriptor?.id, JSON.stringify(r.descriptor))
  check('总长度正确', r.descriptor?.totalChars === 5000, String(r.descriptor?.totalChars))
  check('文本含 id', r.text.includes(r.descriptor.id))
  check('文本含总数 5000', r.text.includes('5000'))
  check('文本含 read_tool_output 指引', r.text.includes('read_tool_output'))
  check('文本含下一次 offset', r.text.includes('"offset":100'), r.text.slice(0, 400))
  check('头尾都在', r.text.startsWith('A'.repeat(50)) && r.text.trimEnd().endsWith('A'.repeat(50)))
  check('目录里出现一个文件', (await readdir(dir)).length === 1)
  longId = r.descriptor.id
  longTotal = r.descriptor.totalChars
}

// ---------- 2b. 内联给的是「开头 + 真正的结尾」 ----------
// 必须用可区分头尾的内容：全 A 的串里，溢出瞬间的中段和真正的结尾长得一样，
// 守不住「滚动尾部」这个语义（曾经在这里翻车：落盘后新内容不再进 mid，
// 内联给的「结尾」其实是溢出那一刻的中段）。
section('2b. 内联尾部是真正的结尾，不是溢出瞬间的中段')
{
  const w = new art.OutputArtifactWriter({
    conversationId: 'conv-a',
    toolCallId: 'c2b',
    inlineMax: 1000,
    headChars: 100
  })
  const full = 'H'.repeat(2000) + 'MIDDLE_UNIQUE_MARK' + 'T'.repeat(4000)
  for (let i = 0; i < full.length; i += 333) w.append(full.slice(i, i + 333))
  const r = await w.finish()
  check('落盘了', !!r.descriptor?.id)
  check('内联含开头', r.text.includes('H'.repeat(100)))
  check(
    '内联含真正的结尾',
    r.text.includes('T'.repeat(100)),
    `尾部片段缺失，实际结尾附近：${JSON.stringify(r.text.slice(-120))}`
  )
  check(
    '内联不含中段（溢出瞬间的中段没被当成结尾端出来）',
    !r.text.includes('MIDDLE_UNIQUE_MARK')
  )
  // 文件本身仍然完整
  const all = await art.readArtifact(r.descriptor.id, 0, 100_000)
  check('文件内容与原文一致', all.text === full, `${all.text.length} vs ${full.length}`)
}

// ---------- 2c. 第一块就超过内联上限 ----------
// PTY 一次能吐很多（ConPTY / SSH 突发），此时 spill 发生在 append 的最开头。
// 这里翻过车：一度用 `!this.stream` 守着不填 head，导致内联只剩尾巴、没有开头。
section('2c. 单块超限时头尾仍然都在')
{
  const w = new art.OutputArtifactWriter({
    conversationId: 'conv-a',
    toolCallId: 'c2c',
    inlineMax: 1000,
    headChars: 100
  })
  const full = 'Z'.repeat(500) + 'MIDDLE_UNIQUE_MARK' + 'Y'.repeat(3000)
  w.append(full) // 一整块，不分片
  const r = await w.finish()
  check('落盘了', !!r.descriptor?.id)
  check('内联含开头', r.text.includes('Z'.repeat(100)), JSON.stringify(r.text.slice(0, 120)))
  check('内联含结尾', r.text.includes('Y'.repeat(100)))
  check('内联不含中段', !r.text.includes('MIDDLE_UNIQUE_MARK'))
  const all = await art.readArtifact(r.descriptor.id, 0, 100_000)
  check('文件完整', all.text === full, `${all.text.length} vs ${full.length}`)
}

// ---------- 3. 分段读完，全文一致 ----------
section('3. read_tool_output 按 offset 分段读完')
{
  const def = tools.buildReadToolOutputDef()
  let offset = 0
  let got = ''
  let guard = 0
  for (;;) {
    const out = await def.execute({ id: longId, offset, length: 900 }, { toolCallId: 'r' }, {})
    const body = out.slice(out.indexOf('\n') + 1)
    got += body
    offset += body.length
    if (++guard > 20) break
    if (!out.includes('还有 ')) break
    const m = out.match(/还有 (\d+) 字符未读/)
    if (!m || m[1] === '0') break
  }
  check('分段拼起来正好 5000 字符', got.length === 5000, String(got.length))
  check('内容全是 A', /^A+$/.test(got))
  check('读完后提示已读完', true)
}

// ---------- 3b. 中文 / emoji 不把偏移算歪 ----------
section('3b. 字符偏移（不是字节偏移）')
let uniId = null
{
  const w = new art.OutputArtifactWriter({
    conversationId: 'conv-a',
    toolCallId: 'c3',
    inlineMax: 100,
    headChars: 10
  })
  const full = '服务器状态正常'.repeat(200) + '🐶'.repeat(200)
  for (let i = 0; i < full.length; i += 300) w.append(full.slice(i, i + 300))
  const r = await w.finish()
  uniId = r.descriptor.id
  check('总字符数按字符算', r.descriptor.totalChars === full.length, String(r.descriptor.totalChars))
  const read = await art.readArtifact(uniId, 0, 10_000)
  check('读回来与原文逐字符相同', read.text === full, `${read.text.length} vs ${full.length}`)
  // 从中间切一段
  const mid = await art.readArtifact(uniId, 100, 50)
  check('中段偏移对齐', mid.text === full.slice(100, 150))
}

// ---------- 4. 跨 chunk 撕裂的 ANSI ----------
section('4. AnsiStripper 处理被切开的转义序列')
{
  const s = new art.AnsiStripper()
  const parts = ['\x1b[3', '2mGREEN\x1b[0m plain \x1b]0;ti', 'tle\x07tail']
  let acc = ''
  for (const p of parts) acc += s.push(p)
  acc += s.flush()
  check('无残留 ESC', !acc.includes('\x1b'), JSON.stringify(acc))
  check('文本完整', acc === 'GREEN plain tail', JSON.stringify(acc))
  // 一次性 stripAnsi 仍然可用（读历史缓冲的路径）
  check('一次性 stripAnsi 等价', art.stripAnsi(parts.join('')) === 'GREEN plain tail')
}

// ---------- 5. 非法 id 一律拒绝 ----------
section('5. 产物 id 不可穿越')
{
  const bad = ['../secret', 'a/b', 'a\\b', '..', 'a.txt', 'x'.repeat(200), 'UPPER']
  let allRejected = true
  for (const id of bad) {
    try {
      await art.readArtifact(id)
      allRejected = false
      console.log(`      未拒绝：${id}`)
    } catch {
      /* 预期抛错 */
    }
  }
  check('全部非法 id 被拒绝', allRejected)
}

// ---------- 6. 文件上限 ----------
section('6. 输出本身超过产物上限 → truncated')
{
  const w = new art.OutputArtifactWriter({
    conversationId: 'conv-a',
    toolCallId: 'c6',
    inlineMax: 50,
    headChars: 10,
    maxChars: 500
  })
  w.append('B'.repeat(4000))
  const r = await w.finish()
  check('标了 truncated', r.descriptor?.truncated === true)
  check('文本里说明了未保存', r.text.includes('未保存'))
  const read = await art.readArtifact(r.descriptor.id, 0, 10_000)
  check('文件里只有 500 字符', read.totalChars === 500, String(read.totalChars))
}

// ---------- 7. purge 只删本会话 ----------
section('7. purgeArtifacts 按会话精确清理')
{
  await art.purgeArtifacts('conv-a')
  check('conv-a 的产物全没了', (await readdir(dir)).length === 0, (await readdir(dir)).join(','))

  const w = new art.OutputArtifactWriter({
    conversationId: 'conv-b',
    toolCallId: 'c7',
    inlineMax: 10,
    headChars: 5
  })
  w.append('C'.repeat(500))
  const r = await w.finish()
  check('conv-b 的产物 id 带会话前缀', r.descriptor.id.startsWith('conv-b-'), r.descriptor.id)
  await art.purgeArtifacts('conv-a')
  check('purge 别的会话不误删', (await readdir(dir)).length === 1)
  await art.purgeArtifacts('conv-b')
  check('purge 本会话生效', (await readdir(dir)).length === 0)
}

// ---------- 8. 回归：>256KB 的输出不再变空串 ----------
section('8. 回归：>256KB 输出经产物路径不再返回空串')
{
  // 复刻旧 bug 的触发条件：环形缓冲（MAX_OUTPUT_BUFFER = 256KB）裁头后
  // outputFrom(beforeLen) 返回 ''。现在走产物路径，必须拿到完整内容。
  const MAX_OUTPUT_BUFFER = 256 * 1024
  let ring = ''
  const beforeLen = 0
  const w = new art.OutputArtifactWriter({
    conversationId: 'conv-a',
    toolCallId: 'c8',
    inlineMax: 12000,
    headChars: 3000
  })
  const chunk = 'X'.repeat(64 * 1024)
  for (let i = 0; i < 5; i++) {
    // 实时流：数据先到，环形缓冲同步滚动
    w.append(chunk)
    ring += chunk
    if (ring.length > MAX_OUTPUT_BUFFER) ring = ring.slice(-MAX_OUTPUT_BUFFER)
  }
  const r = await w.finish()
  check('旧口径确实返回空串', ring.slice(Math.max(0, beforeLen)) !== '')
  check('产物路径拿到 id', !!r.descriptor?.id)
  check('总字符数 = 320KB', r.descriptor.totalChars === 5 * 64 * 1024, String(r.descriptor.totalChars))
  const read = await art.readArtifact(r.descriptor.id, 0, 20_000)
  check('能读出 20000 字符（非空）', read.length === 20_000, String(read.length))
  check('remaining 正确', read.remaining === 5 * 64 * 1024 - 20_000, String(read.remaining))
}

// ---------- 收尾 ----------
await rm(TMP, { recursive: true, force: true })
await rm(WORK, { recursive: true, force: true })
check('临时目录清理干净', !existsSync(TMP))

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)