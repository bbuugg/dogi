/**
 * 接口请求的四种请求体形态（none / raw / x-www-form-urlencoded / form-data）验证。
 *
 * 跑的是**主进程真源码** `src/main/services/api/http.ts`（不是手抄的副本）与
 * 渲染端纯函数 `src/features/api/api-client.ts`：
 *
 *   A. executeHttp + 进程内真 HTTP 服务器（127.0.0.1 随机端口，回显请求头与原始 body）：
 *      0. none：不带 body、Content-Type 原样不动（哪怕三种形态的数据都传了）；
 *      1. x-www-form-urlencoded：字段序列化正确、空键跳过、没有 Content-Type 时自动补标准值；
 *      2. 调用方显式写了 Content-Type（带 charset）时**不动它**；
 *      3. form-data：文本字段 + 文件字段（真读磁盘文件）→ 服务端收到边界完整的多部分体，
 *         文件名 / 文件 MIME / 文件字节逐字节一致（含 0x00 与中文）；
 *      4. form-data：请求头里那份**没有 boundary** 的 Content-Type 被丢掉，用运行时生成的；
 *      5. form-data：文件字段没选文件 / 路径不存在 → status=0 + 人类可读的 error，且根本没发包；
 *      6. raw：正文与 Content-Type 原样透传（回归：老形态不能变）；
 *      7. GET / HEAD 不带 body（哪怕 bodyType=form-data）；
 *      8. 不就地改调用方传进来的 headers 对象（重发 / 历史记录还指着它）；
 *   B. 渲染端纯函数：请求体类型的标准 Content-Type、表单行的空槽位整理、
 *      Content-Type 请求头的覆盖/新增、路径取文件名、cURL `-F`（含 `@文件`）解析。
 *
 * 跑：node scripts/verify-api-body-types.mjs
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { executeHttp } from '../src/main/services/api/http.ts'
import {
  BODY_TYPES,
  baseNameOf,
  contentTypeForBodyType,
  emptyFormField,
  emptyHeader,
  isBlankFormField,
  normalizeFormFields,
  parseCurl,
  setContentType,
  tidyFormRows
} from '../src/renderer/src/features/api/api-client.ts'

const check = (label: string, ok: boolean): void => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}
const eq = (label: string, actual: unknown, expected: unknown): void => {
  assert.deepEqual(actual, expected, `FAIL: ${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  console.log(`  ok  ${label}`)
}

// ---------- 回显服务器 ----------

interface Echo {
  method: string
  contentType: string
  raw: Buffer
  host: string
  /** 收到的请求数（用来断言「准备阶段就失败时根本没发包」） */
  hits: number
}

let lastEcho: Echo = { method: '', contentType: '', raw: Buffer.alloc(0), host: '', hits: 0 }

function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      lastEcho = {
        method: req.method ?? '',
        contentType: String(req.headers['content-type'] ?? ''),
        raw,
        host: String(req.headers.host ?? ''),
        hits: lastEcho.hits + 1
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, size: raw.length }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}

/** 极简 multipart 解析：按 latin1 逐字符切（1 字节 ↔ 1 字符，二进制内容不会被打断） */
function parseMultipart(body: Buffer, contentType: string): Array<{ headers: string; data: Buffer }> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  assert.ok(m, `multipart Content-Type 里没有 boundary：${contentType}`)
  const boundary = (m[1] ?? m[2] ?? '').trim()
  const text = body.toString('latin1')
  const parts: Array<{ headers: string; data: Buffer }> = []
  for (const chunk of text.split(`--${boundary}`)) {
    if (!chunk || chunk === '--\r\n' || chunk === '--') continue
    const sep = chunk.indexOf('\r\n\r\n')
    if (sep < 0) continue
    const headers = chunk.slice(0, sep).replace(/^\r\n/, '')
    // 每段以 \r\n 结尾（紧邻下一个边界）
    let data = chunk.slice(sep + 4)
    if (data.endsWith('\r\n')) data = data.slice(0, -2)
    parts.push({ headers, data: Buffer.from(data, 'latin1') })
  }
  return parts
}

// ---------- 测试固件 ----------

const dir = await mkdtemp(join(tmpdir(), 'dogi-api-body-'))
// 文本文件：带 CRLF 与中文，确认没有被当成文本重新编码
const TEXT_PATH = join(dir, '样例 注释.txt')
const TEXT_BYTES = Buffer.from('第一行\r\nsecond line\r\n', 'utf8')
await writeFile(TEXT_PATH, TEXT_BYTES)
// 二进制文件：含 0x00 / 0xFF / 边界字符，逐字节比对
const BIN_PATH = join(dir, 'blob.bin')
const BIN_BYTES = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x41, 0x42, 0x00, 0x7f])
await writeFile(BIN_PATH, BIN_BYTES)
const PNG_PATH = join(dir, 'pic.png')
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
await writeFile(PNG_PATH, PNG_BYTES)
const MISSING_PATH = join(dir, '不存在-文件.dat')

const { server, port } = await startServer()
const base = `http://127.0.0.1:${port}/echo`

try {
  console.log('\nA. 主进程 executeHttp（真发 HTTP 请求）')

  // ---- 1. x-www-form-urlencoded ----
  {
    const headers: Record<string, string> = {}
    const res = await executeHttp({
      method: 'POST',
      url: base,
      headers,
      bodyType: 'x-www-form-urlencoded',
      urlencoded: [
        { key: 'a', value: '1' },
        { key: 'b', value: '空格 和 & 符号' },
        { key: '', value: '空键应被跳过' },
        { key: '中文', value: '值' }
      ]
    })
    check('urlencoded：请求成功', res.status === 200 && !res.error)
    eq('urlencoded：自动补标准 Content-Type', lastEcho.contentType, 'application/x-www-form-urlencoded')
    const parsed = new URLSearchParams(lastEcho.raw.toString('utf8'))
    eq('urlencoded：字段与值（含中文 / 空格 / &）', [...parsed.entries()], [
      ['a', '1'],
      ['b', '空格 和 & 符号'],
      ['中文', '值']
    ])
    check('urlencoded：空键行没被发出去', !lastEcho.raw.toString('utf8').includes('空键'))
    check('urlencoded：调用方的 headers 对象没被就地改', Object.keys(headers).length === 0)
  }

  // ---- 2. 显式 Content-Type（带 charset）不动 ----
  {
    await executeHttp({
      method: 'POST',
      url: base,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      bodyType: 'x-www-form-urlencoded',
      urlencoded: [{ key: 'x', value: 'y' }]
    })
    eq('urlencoded：显式 Content-Type 原样保留', lastEcho.contentType, 'application/x-www-form-urlencoded; charset=utf-8')
    eq('urlencoded：正文正确', lastEcho.raw.toString('utf8'), 'x=y')
  }

  // ---- 3. form-data：文本 + 文件 ----
  {
    const res = await executeHttp({
      method: 'POST',
      url: base,
      headers: { 'X-Trace': 'form' },
      bodyType: 'form-data',
      formFields: [
        { key: 'note', value: '一段中文备注' },
        { key: 'doc', value: TEXT_PATH, isFile: true },
        { key: 'blob', value: BIN_PATH, isFile: true },
        { key: '', value: '空键应被跳过' }
      ]
    })
    check('form-data：请求成功', res.status === 200 && !res.error)
    check('form-data：Content-Type 带 boundary', /^multipart\/form-data; boundary=.+/.test(lastEcho.contentType))
    const parts = parseMultipart(lastEcho.raw, lastEcho.contentType)
    eq('form-data：段数（空键行被跳过）', parts.length, 3)
    const note = parts.find((p) => p.headers.includes('name="note"'))
    check('form-data：文本字段存在', Boolean(note))
    eq('form-data：文本字段值', note?.data.toString('utf8'), '一段中文备注')
    const doc = parts.find((p) => p.headers.includes('name="doc"'))
    // undici 与浏览器一样，filename 直接写 UTF-8 字节（不是 RFC 5987 的 filename*）
    const docFilename = /filename="([^"]*)"/.exec(doc?.headers ?? '')?.[1] ?? ''
    eq(
      'form-data：文件字段带文件名（UTF-8 原字节，与浏览器一致）',
      Buffer.from(docFilename, 'latin1').toString('utf8'),
      '样例 注释.txt'
    )
    check('form-data：文件字段 MIME 按扩展名给出', Boolean(doc?.headers.match(/content-type:\s*text\/plain/i)))
    check('form-data：文本文件字节一致（CRLF / 中文未被重编码）', doc !== undefined && Buffer.compare(doc.data, TEXT_BYTES) === 0)
    const blob = parts.find((p) => p.headers.includes('name="blob"'))
    check('form-data：未知扩展名 → application/octet-stream', Boolean(blob?.headers.match(/content-type:\s*application\/octet-stream/i)))
    check('form-data：二进制文件逐字节一致（0x00 / 0xFF / CRLF / --）', blob !== undefined && Buffer.compare(blob.data, BIN_BYTES) === 0)
  }

  // ---- 4. form-data：请求头里那份没有 boundary 的 Content-Type 被丢掉 ----
  {
    await executeHttp({
      method: 'POST',
      url: base,
      headers: { 'Content-Type': 'application/json' },
      bodyType: 'form-data',
      formFields: [{ key: 'k', value: 'v' }]
    })
    check('form-data：旧的 Content-Type 未被沿用', lastEcho.contentType.startsWith('multipart/form-data; boundary='))
    const parts = parseMultipart(lastEcho.raw, lastEcho.contentType)
    eq('form-data：字段仍能解析出来', parts[0]?.data.toString('latin1'), 'v')
  }

  // ---- 5. 文件没选 / 路径不存在：准备阶段就失败，不发包 ----
  {
    const hitsBefore = lastEcho.hits
    const res1 = await executeHttp({
      method: 'POST',
      url: base,
      bodyType: 'form-data',
      formFields: [{ key: 'file', value: '', isFile: true }]
    })
    eq('form-data：没选文件 → status 0', res1.status, 0)
    check('form-data：没选文件的错误信息点名了字段', Boolean(res1.error?.includes('file') && res1.error?.includes('没有选择文件')))
    const res2 = await executeHttp({
      method: 'POST',
      url: base,
      bodyType: 'form-data',
      formFields: [{ key: 'file', value: MISSING_PATH, isFile: true }]
    })
    eq('form-data：路径不存在 → status 0', res2.status, 0)
    check('form-data：读文件失败的错误信息带路径', Boolean(res2.error?.includes(MISSING_PATH)))
    eq('form-data：两次失败都没有发请求', lastEcho.hits, hitsBefore)
  }

  // ---- 6. raw 原样透传（回归） ----
  {
    const res = await executeHttp({
      method: 'POST',
      url: base,
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}'
    })
    check('raw：请求成功', res.status === 200 && !res.error)
    eq('raw：Content-Type 未被改', lastEcho.contentType, 'application/json')
    eq('raw：正文原样发出', lastEcho.raw.toString('utf8'), '{"a":1}')
    // bodyType 显式写 raw 也一样
    await executeHttp({ method: 'POST', url: base, bodyType: 'raw', body: 'plain' })
    eq('raw：bodyType=raw 时正文原样发出', lastEcho.raw.toString('utf8'), 'plain')
  }

  // ---- 6b. none：完全不携带请求体（三种形态的数据都给了也不发） ----
  {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const res = await executeHttp({
      method: 'POST',
      url: base,
      headers,
      bodyType: 'none',
      body: '{"a":1}',
      urlencoded: [{ key: 'k', value: 'v' }],
      formFields: [{ key: 'f', value: TEXT_PATH, isFile: true }]
    })
    check('none：请求成功', res.status === 200 && !res.error)
    eq('none：没有 body', lastEcho.raw.length, 0)
    eq('none：Content-Type 原样不动', lastEcho.contentType, 'application/json')
    check('none：调用方的 headers 对象没被就地改', headers['Content-Type'] === 'application/json')
  }

  // ---- 7. GET / HEAD 不带 body ----
  {
    await executeHttp({
      method: 'GET',
      url: base,
      headers: { 'Content-Type': 'application/json' },
      bodyType: 'form-data',
      formFields: [{ key: 'k', value: 'v' }],
      urlencoded: [{ key: 'k', value: 'v' }],
      body: 'ignored'
    })
    eq('GET：没有 body', lastEcho.raw.length, 0)
    eq('GET：Content-Type 也没被自动补上', lastEcho.contentType, 'application/json')
  }

  console.log('\nB. 渲染端纯函数')

  // ---- 8. 请求体类型 → 标准 Content-Type ----
  {
    eq('BODY_TYPES：四种形态且 none 在首位（raw 仍是缺省）', BODY_TYPES.map((b) => b.value), ['none', 'raw', 'x-www-form-urlencoded', 'form-data'])
    eq('none 没有标准 Content-Type', contentTypeForBodyType('none'), null)
    eq('raw 没有标准 Content-Type', contentTypeForBodyType('raw'), null)
    eq('urlencoded 的标准 Content-Type', contentTypeForBodyType('x-www-form-urlencoded'), 'application/x-www-form-urlencoded')
    eq('form-data 的标准 Content-Type', contentTypeForBodyType('form-data'), 'multipart/form-data')
  }

  // ---- 9. 表单行的空槽位整理 ----
  {
    const rows = tidyFormRows([{ key: 'a', value: '1' }])
    eq('末行填了就补空槽位', rows.length, 2)
    check('补出来的是空槽位', isBlankFormField(rows[1]!))
    eq('末尾多个空行只留一个', tidyFormRows([...rows, emptyFormField(), emptyFormField()]).length, 2)
    eq('清空后至少留一行', tidyFormRows([]).length, 1)
    eq('空列表也能规整', normalizeFormFields(undefined).length, 1)
    eq('isFile 只在显式 true 时成立', normalizeFormFields([{ key: 'f', value: 'p', isFile: 'yes' }])[0]?.isFile, false)
    eq('isFile=true 被保留', normalizeFormFields([{ key: 'f', value: 'p', isFile: true }])[0]?.isFile, true)
  }

  // ---- 10. Content-Type 请求头的覆盖 / 新增 ----
  {
    eq('已有 Content-Type → 改值', setContentType([{ key: 'content-type', value: 'application/json' }], 'multipart/form-data'), [
      { key: 'content-type', value: 'multipart/form-data' },
      emptyHeader()
    ])
    eq('没有 → 新增在空槽位之前', setContentType([{ key: 'Accept', value: '*/*' }, emptyHeader()], 'multipart/form-data'), [
      { key: 'Accept', value: '*/*' },
      { key: 'Content-Type', value: 'multipart/form-data' },
      emptyHeader()
    ])
  }

  // ---- 11. 路径取文件名 ----
  {
    eq('Windows 路径取末段', baseNameOf('C:\\Users\\a\\样例 注释.txt'), '样例 注释.txt')
    eq('POSIX 路径取末段', baseNameOf('/tmp/x/blob.bin'), 'blob.bin')
    eq('空路径给空串', baseNameOf(''), '')
  }

  // ---- 12. cURL -F 解析成 form-data 字段 ----
  {
    const parsed = parseCurl(
      `curl -X POST https://api.example.com/upload -H "Authorization: Bearer t" -F "note=hi" -F "file=@/tmp/a.png;type=image/png" -F "paste=<C:\\\\tmp\\\\x.txt"`
    )
    eq('cURL -F：方法', parsed.method, 'POST')
    eq('cURL -F：请求体类型', parsed.bodyType, 'form-data')
    eq('cURL -F：不再把字段拼成文本正文', parsed.body, '')
    eq('cURL -F：字段（@ 为文件、去掉 ;type、< 退化成文本值）', parsed.bodyFields, [
      { key: 'note', value: 'hi', isFile: false },
      { key: 'file', value: '/tmp/a.png', isFile: true },
      { key: 'paste', value: 'C:\\tmp\\x.txt', isFile: false }
    ])
    check('cURL -F：自动补的 Content-Type 是 multipart', parsed.headers.some((h) => h.key === 'Content-Type' && h.value === 'multipart/form-data'))
    // 回归：-d 仍然是 raw 文本 + urlencoded 的 Content-Type 头
    const data = parseCurl(`curl -X POST https://api.example.com/x -d '{"a":1}'`)
    eq('cURL -d：仍是 raw（bodyType 缺省）', data.bodyType, undefined)
    eq('cURL -d：正文原样', data.body, '{"a":1}')
  }
} finally {
  server.close()
  await rm(dir, { recursive: true, force: true })
}

console.log('\n全部通过：四种请求体形态（none / raw / x-www-form-urlencoded / form-data）\n')
