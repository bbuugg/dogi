/**
 * 接口请求「请求体四种形态」的界面链路验证（隔离 Electron 实例 + CDP 驱动真 UI）。
 *
 * 覆盖（全部经真实界面操作，不直接改 store 的表）：
 *   1. 新建请求草稿 → 填地址 → 「请求体」分段默认是 raw（Monaco 在、表格不在）；
 *   2. 切到 x-www-form-urlencoded：表格出现（一行待填空槽位）、请求头里自动补
 *      `Content-Type: application/x-www-form-urlencoded`；填两行后点「发送」，
 *      **进程内真 HTTP 服务器**收到的正是 `a=1&b=2`（空格 / 中文按标准百分号编码）；
 *   3. 切到 form-data：每行多出「类型」列（在**值这一列前面**）；一行文本 + 一行改成「文件」→
 *      点「选择文件」（探针用 DOGI_API_PICK_FILE 旁路原生对话框，见下）→ 值变成文件名 (大小)；
 *      发送后服务器收到边界完整的多部分体：文本字段与**文件字节逐字节一致**；
 *   4. 切回 raw：请求头里的表单类 Content-Type 自动换成 application/json，Monaco 回来；
 *   5. 切到 none：编辑器与表单都让位，发送后服务器**一个字节 body 都没有**，
 *      而请求头里的 Content-Type 原样保留（none 不动它）；
 *   6. 在 form-data 下按 Ctrl/Cmd+S 落盘（先补请求名）：保存的请求带 bodyType 与两张表单，
 *      请求历史同样记下这几种形态；换成真实标签重新载入后仍是 form-data 且字段回填；
 *   7. `api:pickFile` 的真实回包形状（路径 / 文件名 / 大小）。
 *
 * 跑：node scripts/verify-api-body-ui.mjs（**先 npm run build**，探针跑的是 out/ 里的产物）
 * ⚠️ 原生文件对话框无法自动化：`DOGI_API_PICK_FILE` 只由探针设置（同 sftp:uploadDir 的旁路约定），
 *    正常运行不设该变量，行为不变。
 * ⚠️ 隔离实例的首次 loadFile 不提交首帧：连上后固定 bringToFront + reload（见 AGENTS 5.1）。
 * ⚠️ antd 会给两个汉字的按钮插空格，比对文案前先去空白；横向分段要读/点里面 radio 的 input。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { connect, report, sleep } from './lib/cdp.mjs'

const PORT = 9346
// ⚠️ 日志落在系统临时目录（仓库里的 .workbuddy-ai/ 在受限沙箱下不可写）；
// 截图存仓库 tmp/（与其它探针一致，方便直接看）
const OUT_DIR = join(tmpdir(), 'dogi-api-body-shots')
const SHOT_DIR = 'tmp'
const userData = join(tmpdir(), 'dogi-api-body-cdp')
const workDir = join(tmpdir(), 'dogi-api-body-fixture')

const check = (label, ok, extra = '') => {
  assert.ok(ok, `FAIL: ${label}${extra ? ' —— ' + extra : ''}`)
  console.log(`  ok  ${label}`)
}

// ---------- 固件：待上传的文件（含中文与 CRLF，确认字节没被重编码） ----------
await fs.rm(workDir, { recursive: true, force: true })
await fs.mkdir(workDir, { recursive: true })
const UPLOAD_PATH = join(workDir, '上传样例.txt')
const UPLOAD_BYTES = Buffer.from('first\r\n第二行\r\nwith, comma & ampersand\r\n', 'utf8')
await fs.writeFile(UPLOAD_PATH, UPLOAD_BYTES)

// ---------- 进程内真 HTTP 服务器（回显收到的 Content-Type 与原始 body） ----------
const received = []
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    received.push({ method: req.method, contentType: String(req.headers['content-type'] ?? ''), raw: Buffer.concat(chunks) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, size: received[received.length - 1].raw.length }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ECHO_URL = `http://127.0.0.1:${server.address().port}/echo`

/** 极简 multipart 解析（latin1 逐字符切，二进制内容不被打断） */
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  assert.ok(m, `multipart Content-Type 里没有 boundary：${contentType}`)
  const boundary = (m[1] ?? m[2] ?? '').trim()
  const parts = []
  for (const chunk of body.toString('latin1').split(`--${boundary}`)) {
    if (!chunk || chunk === '--\r\n' || chunk === '--') continue
    const sep = chunk.indexOf('\r\n\r\n')
    if (sep < 0) continue
    let data = chunk.slice(sep + 4)
    if (data.endsWith('\r\n')) data = data.slice(0, -2)
    parts.push({ headers: chunk.slice(0, sep).replace(/^\r\n/, ''), data: Buffer.from(data, 'latin1') })
  }
  return parts
}

// ---------- 起隔离实例 ----------
await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(join(OUT_DIR, 'api-body-ui.log'), 'a')
// ⚠️ 有些环境（WorkBuddy / 本仓库的探针终端）会注入 ELECTRON_RUN_AS_NODE=1，
// 那会让 electron.exe 退化成普通 Node —— 主进程 `import electron` 直接报
// 「does not provide an export named 'BrowserWindow'」。必须剥掉再启动。
const childEnv = { ...process.env, DOGI_API_PICK_FILE: UPLOAD_PATH }
delete childEnv.ELECTRON_RUN_AS_NODE
delete childEnv.NODE_OPTIONS
const child = spawn(
  'node_modules/electron/dist/electron.exe',
  ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-sandbox', '--in-process-gpu', '--disable-gpu-sandbox'],
  { stdio: ['ignore', log.fd, log.fd], detached: true, env: childEnv }
)
child.unref()

const cdp = await connect({ port: PORT })
let exitCode = 1
try {
  // 隔离实例首帧不提交：固定 bringToFront + reload（见探针通用约定）
  await cdp.bringToFront()
  await cdp.reload(2500)

  /** 轮询等待页面里的表达式为真 */
  const waitFor = async (expression, timeoutMs = 6000, label = expression) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await cdp.eval(`(() => { try { return Boolean(${expression}) } catch { return false } })()`)) return true
      await sleep(200)
    }
    throw new Error(`等待超时：${label}`)
  }

  /** 等第 n+1 个请求真的到达服务器（服务器数组在 Node 侧，页面里看不到）；顺手报出页面上的错误 */
  const waitForRequest = async (before, timeoutMs = 9000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (received.length > before) return true
      const err = await cdp.eval(`(() => { const m = /错误：([^\\n]+)/.exec(document.body.innerText); return m ? m[1] : null })()`)
      if (err) throw new Error('页面报错：' + err)
      await sleep(200)
    }
    throw new Error(`请求没有发出（服务器收到 ${received.length} 个，期望 > ${before}）`)
  }

  const HELPERS = `
    const vis = (el) => !!el && el.offsetParent !== null
    const clickText = (sel, text) => {
      const el = [...document.querySelectorAll(sel)].find((n) => vis(n) && (n.textContent || '').replace(/\\s/g, '') === text)
      if (!el) throw new Error('找不到按钮：' + text)
      el.click()
      return true
    }
    const setVal = (el, v) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const byPlaceholder = (ph) => [...document.querySelectorAll('input')].filter((el) => vis(el) && (el.placeholder || '') === ph)
  `
  const evalPage = (body) => cdp.eval(`(() => { ${HELPERS} ${body} })()`)

  await waitFor(`window.__store && window.__store.getState().apiGroups !== undefined`, 20000, 'store 就绪')

  // ---------- 1. 新建请求草稿并切到「请求体」 ----------
  await cdp.eval(`(() => {
    const s = window.__store.getState()
    window.__store.setState({ ui: { ...s.ui, activeActivity: 'api', sidebarCollapsed: false } })
    s.openNewApiDraft()
  })()`)
  await sleep(900)
  await evalPage(`
    const url = byPlaceholder('请求地址，如 https://api.example.com/users')[0]
    if (!url) throw new Error('找不到请求地址输入框')
    setVal(url, ${JSON.stringify(ECHO_URL)})
    return true
  `)
  await sleep(300)
  await evalPage(`return clickText('button', '请求体')`)
  await waitFor(`document.querySelector('.monaco-editor')`, 6000, 'Monaco 编辑器没出现')
  /**
   * 读当前选中的请求体形态：横向分段 Segmented ≈ 横向 radio。
   * 选中态读里面 radio 的 `checked` —— `-item-selected` 类在拇指动画期间会被摘掉（同 verify-rdp-host-ui）。
   */
  const BODY_TYPE_SEG = `(() => {
    const item = [...document.querySelectorAll('.ant-segmented-item')].filter(vis).find((el) => el.querySelector('input[type="radio"]')?.checked)
    return item ? (item.textContent || '').trim() : null
  })()`
  const rawDefault = await evalPage(`
    return { hasMonaco: !!document.querySelector('.monaco-editor'), typeText: ${BODY_TYPE_SEG}, tableRows: byPlaceholder('字段名，如 file').length }
  `)
  check('请求体默认是 raw（Monaco 在、表单不在）', rawDefault.hasMonaco && rawDefault.tableRows === 0, JSON.stringify(rawDefault))
  check('请求体形态是横向分段且选中 raw', rawDefault.typeText === 'raw', String(rawDefault.typeText))

  // ---------- 2. 切到 POST，再切 x-www-form-urlencoded ----------
  /** 打开某个 antd Select（按它当前显示的文字定位）并点选目标选项 */
  const pickSelect = async (currentValues, optionText, label) => {
    await evalPage(`
      const sel = [...document.querySelectorAll('.ant-select')].filter(vis).find((s) => ${currentValues}.test((s.innerText || '').trim()))
      if (!sel) throw new Error('找不到下拉：${label}')
      const targets = [sel, sel.querySelector('.ant-select-content')].filter(Boolean)
      for (const t of targets) {
        t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        t.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }
      return true
    `)
    await waitFor(`document.querySelectorAll('.ant-select-item-option').length > 0`, 5000, label + ' 没展开')
    await cdp.eval(`(() => {
      const opt = [...document.querySelectorAll('.ant-select-item-option')].find((o) => (o.textContent || '').trim() === ${JSON.stringify(optionText)})
      if (!opt) throw new Error('找不到选项：' + ${JSON.stringify(optionText)})
      opt.click()
    })()`)
    await sleep(500)
  }
  /** 点横向分段里的某个请求体形态；rc-segmented 的切换靠 label 里 radio 的原生 change，
   *  必须点 input —— 对 label 派发合成 MouseEvent 不会转发到 radio（同 verify-rdp-host-ui） */
  const pickBodyType = async (value) => {
    await evalPage(`
      const item = [...document.querySelectorAll('.ant-segmented-item')].filter(vis).find((el) => (el.textContent || '').trim() === ${JSON.stringify(value)})
      if (!item) throw new Error('找不到请求体形态分段：${value}')
      const input = item.querySelector('input[type="radio"]')
      if (!input) throw new Error('分段项里没有 radio：${value}')
      input.click()
      return true
    `)
    await sleep(500)
  }
  // 草稿默认是 GET：GET 不带请求体（这是刻意行为），要验表单得先换成 POST
  await pickSelect('/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/', 'POST', '请求方法')
  const methodNow = await evalPage(`
    const sel = [...document.querySelectorAll('.ant-select')].filter(vis).find((s) => /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test((s.innerText || '').trim()))
    return sel ? sel.innerText.trim() : null
  `)
  check('请求方法已切成 POST', methodNow === 'POST', String(methodNow))

  await pickBodyType('x-www-form-urlencoded')
  await waitFor(`document.querySelectorAll('input[placeholder="参数名"]').length > 0`, 5000, 'urlencoded 表格没出现')
  const urlencodedTable = await evalPage(`return { keys: byPlaceholder('参数名').length, values: byPlaceholder('参数值').length, hasMonaco: !!document.querySelector('.monaco-editor') }`)
  check('urlencoded：表格出现且行数与值列一致（末尾一个空槽位）', urlencodedTable.keys === 1 && urlencodedTable.values === 1, JSON.stringify(urlencodedTable))
  check('urlencoded：Monaco 让位给表格', !urlencodedTable.hasMonaco)

  // Content-Type 请求头被自动补上（去「请求头」分段看真实输入框的值）
  await evalPage(`return clickText('button', '请求头')`)
  await sleep(400)
  const autoCt = await cdp.eval(`[...document.querySelectorAll('input')].filter((el) => el.offsetParent !== null).map((el) => el.value).join(' | ')`)
  check('urlencoded：请求头自动补 Content-Type', autoCt.includes('application/x-www-form-urlencoded'), autoCt)
  await evalPage(`return clickText('button', '请求体')`)
  await sleep(400)

  // 填两行 + 发送
  await evalPage(`
    const keys = byPlaceholder('参数名')
    const vals = byPlaceholder('参数值')
    setVal(keys[0], 'a'); setVal(vals[0], '1')
    return true
  `)
  await sleep(300)
  await waitFor(`document.querySelectorAll('input[placeholder="参数名"]').length >= 2`, 5000, '填了末行没有补空槽位')
  await evalPage(`
    const keys = byPlaceholder('参数名')
    const vals = byPlaceholder('参数值')
    setVal(keys[1], '中文 空格'); setVal(vals[1], 'v&x')
    return true
  `)
  await sleep(300)
  const before2 = received.length
  const domBefore = await cdp.eval(`[...document.querySelectorAll('input')].filter((el) => el.offsetParent !== null).map((el) => (el.placeholder || '?') + '=' + el.value).join(' | ')`)
  await cdp.screenshot(join(SHOT_DIR, 'api-body-urlencoded.png')).catch(() => {})
  await evalPage(`return clickText('button', '发送')`)
  await waitForRequest(before2)
  await sleep(800)
  const sent2 = received[received.length - 1]
  check('urlencoded：真发到服务器了', received.length === before2 + 1, `hits=${received.length}`)
  check('urlencoded：Content-Type 正确', sent2?.contentType === 'application/x-www-form-urlencoded', sent2?.contentType)
  check(
    'urlencoded：正文是标准序列化（a=1&中文+空格=v%26x）',
    sent2?.raw.toString('utf8') === 'a=1&%E4%B8%AD%E6%96%87+%E7%A9%BA%E6%A0%BC=v%26x',
    `实际=${JSON.stringify(sent2?.raw.toString('utf8'))} / 界面=${domBefore}`
  )

  // ---------- 3. form-data（文本 + 本地文件） ----------
  await pickBodyType('form-data')
  await waitFor(`document.querySelectorAll('input[placeholder="字段名，如 file"]').length > 0`, 5000, 'form-data 表格没出现')
  const fdInit = await evalPage(`
    const kinds = [...document.querySelectorAll('.ant-select')].filter(vis).filter((s) => /^(文本|文件)$/.test((s.innerText || '').trim()))
    return { kinds: kinds.length, pickButtons: [...document.querySelectorAll('button')].filter((b) => vis(b) && (b.textContent || '').includes('选择文件')).length }
  `)
  check('form-data：每行有「类型」列（默认文本）', fdInit.kinds === 1, JSON.stringify(fdInit))
  check('form-data：文本行还没有「选择文件」按钮', fdInit.pickButtons === 0, JSON.stringify(fdInit))
  // 「类型」列必须在**值这一列前面**（用户明确要求的列序）
  const colOrder = await evalPage(`
    const nameInput = byPlaceholder('字段名，如 file')[0]
    const row = nameInput.closest('div.flex.items-center')
    const kind = row.querySelector('.ant-select')
    const valueInput = [...row.querySelectorAll('input')].find((el) => el !== nameInput)
    return {
      hasKind: !!kind,
      hasValue: !!valueInput,
      kindBeforeValue: !!(kind && valueInput && (kind.compareDocumentPosition(valueInput) & Node.DOCUMENT_POSITION_FOLLOWING))
    }
  `)
  check('form-data：「类型」列排在值这一列前面', colOrder.hasKind && colOrder.hasValue && colOrder.kindBeforeValue, JSON.stringify(colOrder))

  const before3 = received.length
  // 第一行：文本字段
  await evalPage(`
    const keys = byPlaceholder('字段名，如 file')
    const vals = byPlaceholder('字段值（上面的类型选「文件」可上传本地文件）')
    setVal(keys[0], 'note'); setVal(vals[0], '中文备注')
    return true
  `)
  await sleep(400)
  // 第二行（新补出来的空槽位）：改成「文件」类型
  await evalPage(`
    const kinds = [...document.querySelectorAll('.ant-select')].filter(vis).filter((s) => /^(文本|文件)$/.test((s.innerText || '').trim()))
    const sel = kinds[kinds.length - 1]
    if (!sel) throw new Error('找不到「类型」列的下拉')
    const targets = [sel, sel.querySelector('.ant-select-content')].filter(Boolean)
    for (const t of targets) {
      t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      t.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    return true
  `)
  await waitFor(`document.querySelectorAll('.ant-select-item-option').length > 0`, 5000, '类型下拉没展开')
  await cdp.eval(`(() => {
    const opt = [...document.querySelectorAll('.ant-select-item-option')].find((o) => (o.textContent || '').trim() === '文件')
    if (!opt) throw new Error('找不到「文件」选项')
    opt.click()
  })()`)
  await sleep(500)
  const fileRow = await evalPage(`
    const btn = [...document.querySelectorAll('button')].filter((b) => vis(b) && (b.textContent || '').includes('选择文件'))[0]
    if (!btn) throw new Error('改成文件类型后没有「选择文件」按钮')
    btn.click()
    return true
  `)
  check('form-data：改成「文件」后出现「选择文件」按钮', fileRow)
  await waitFor(`[...document.querySelectorAll('input')].some((el) => el.readOnly && /上传样例\\.txt/.test(el.value))`, 6000, '选择文件没有回填文件名')
  const pickedLabel = await cdp.eval(`[...document.querySelectorAll('input')].filter((el) => el.readOnly).map((el) => el.value).join('|')`)
  check('form-data：文件名 + 大小回填到该行（只读）', /上传样例\.txt \(\d+(\.\d+)? (B|KB|MB)\)/.test(pickedLabel), pickedLabel)
  // 文件字段的字段名
  await evalPage(`
    const keys = byPlaceholder('字段名，如 file')
    setVal(keys[1], 'doc')
    return true
  `)
  await sleep(400)

  await cdp.screenshot(join(SHOT_DIR, 'api-body-form-data.png')).catch(() => {})
  await evalPage(`return clickText('button', '发送')`)
  await waitForRequest(before3)
  await sleep(800)
  const sent3 = received[received.length - 1]
  check('form-data：Content-Type 带 boundary', /^multipart\/form-data; boundary=.+/.test(sent3?.contentType ?? ''), sent3?.contentType)
  const parts = parseMultipart(sent3.raw, sent3.contentType)
  const note = parts.find((p) => p.headers.includes('name="note"'))
  const doc = parts.find((p) => p.headers.includes('name="doc"'))
  check('form-data：文本字段送达', note?.data.toString('utf8') === '中文备注', JSON.stringify(parts.map((p) => p.headers)))
  check('form-data：文件字段带文件名', /filename="上传样例\.txt"/.test(Buffer.from(doc?.headers ?? '', 'latin1').toString('utf8')), doc?.headers)
  check('form-data：文件字节逐字节一致', doc !== undefined && Buffer.compare(doc.data, UPLOAD_BYTES) === 0, `${doc?.data.length} vs ${UPLOAD_BYTES.length}`)
  const respText = await cdp.eval(`document.body.innerText.replace(/\\s/g, '')`)
  check('响应面板显示 200（请求真的发出并回来了）', respText.includes('200'), respText.slice(-120))

  // ---------- 4. 在 form-data 下落盘（Ctrl+S 前先补请求名） ----------
  await evalPage(`
    const nm = [...document.querySelectorAll('input')].filter(vis).find((el) => /请求名称/.test(el.placeholder || ''))
    if (!nm) throw new Error('找不到请求名称输入框')
    setVal(nm, '表单上传用例')
    return true
  `)
  await sleep(400)
  // 页面根容器上挂着 onKeyDown，事件从输入框冒泡上去即可（Ctrl+S）
  await evalPage(`
    const nm = [...document.querySelectorAll('input')].filter(vis).find((el) => /请求名称/.test(el.placeholder || ''))
    nm.focus()
    nm.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))
    return true
  `)
  await waitFor(
    `document.body.innerText.includes('已保存') || window.__store.getState().apiRequests.some((r) => r.name === '表单上传用例')`,
    6000,
    'Ctrl+S 没有落盘'
  )
  await sleep(600)
  const saved = await cdp.eval(`(async () => {
    const list = await window.api.apiClient.list()
    const hit = list.find((r) => r.name === '表单上传用例')
    return hit ? { bodyType: hit.bodyType, formFields: hit.bodyFormFields, urlencoded: hit.bodyUrlencoded, body: hit.body } : null
  })()`)
  check('落盘：请求带上了 bodyType=form-data', saved?.bodyType === 'form-data', JSON.stringify(saved)?.slice(0, 200))
  check(
    '落盘：两张表单与文件路径一起保存',
    saved?.formFields?.[0]?.key === 'note' &&
      saved?.formFields?.[1]?.key === 'doc' &&
      saved?.formFields?.[1]?.isFile === true &&
      saved?.formFields?.[1]?.value === UPLOAD_PATH,
    JSON.stringify(saved?.formFields)
  )
  check('落盘：urlencoded 表也留着（切模式不丢）', Array.isArray(saved?.urlencoded) && saved.urlencoded[0]?.key === 'a', JSON.stringify(saved?.urlencoded))
  const history = await cdp.eval(`(async () => (await window.api.apiClient.listHistory())[0] ?? null)()`)
  check('历史记录带上请求体形态与字段', history?.bodyType === 'form-data' && history?.bodyFormFields?.[1]?.value === UPLOAD_PATH, JSON.stringify(history)?.slice(0, 200))

  // ---------- 5. 落盘后标签被换成真实请求：重新载入的界面要还原成 form-data ----------
  // （Ctrl+S 落盘草稿会把草稿标签关掉、换成真实请求标签 → 新页面默认停在「请求头」分段）
  await evalPage(`return clickText('button', '请求体')`)
  await sleep(800)
  const reloaded = await evalPage(`
    return {
      type: ${BODY_TYPE_SEG},
      keys: byPlaceholder('字段名，如 file').map((el) => el.value),
      readonly: [...document.querySelectorAll('input')].filter((el) => el.readOnly).map((el) => el.value)
    }
  `)
  check(
    '保存后重新载入：请求体仍是 form-data 且字段回填',
    reloaded.type === 'form-data' && reloaded.keys[0] === 'note' && reloaded.keys[1] === 'doc',
    JSON.stringify(reloaded)
  )
  check(
    '保存后重新载入：文件行认得出文件名（大小缓存已丢，退化到路径末段）',
    reloaded.readonly.includes('上传样例.txt'),
    JSON.stringify(reloaded.readonly)
  )

  // ---------- 6. 切回 raw：Content-Type 换成 application/json，Monaco 回来 ----------
  await pickBodyType('raw')
  await waitFor(`document.querySelector('.monaco-editor')`, 5000, 'Monaco 没回来')
  await evalPage(`return clickText('button', '请求头')`)
  await sleep(400)
  const ctAfterRaw = await cdp.eval(`[...document.querySelectorAll('input')].filter((el) => el.offsetParent !== null).map((el) => el.value).join(' | ')`)
  check('切回 raw：表单类 Content-Type 被换成 application/json', ctAfterRaw.includes('application/json') && !ctAfterRaw.includes('multipart/form-data'), ctAfterRaw)

  // ---------- 7. none：不携带请求体（前面的表单数据全都在，也必须一个字节都不发） ----------
  await evalPage(`return clickText('button', '请求体')`)
  await sleep(400)
  await pickBodyType('none')
  const noneUi = await evalPage(`return { type: ${BODY_TYPE_SEG}, hasMonaco: !!document.querySelector('.monaco-editor'), tables: byPlaceholder('字段名，如 file').length }`)
  check('none：分段选中 none，编辑器与表单都让位', noneUi.type === 'none' && !noneUi.hasMonaco && noneUi.tables === 0, JSON.stringify(noneUi))
  const before5 = received.length
  await evalPage(`return clickText('button', '发送')`)
  await waitForRequest(before5)
  await sleep(600)
  const sent5 = received[received.length - 1]
  check('none：真的发出去了但一个字节 body 都没有', sent5?.raw.length === 0, JSON.stringify(sent5?.raw.toString('utf8')))
  check('none：请求头里的 Content-Type 原样保留（application/json）', sent5?.contentType === 'application/json', sent5?.contentType)

  // ---------- 8. api:pickFile 的真实回包形状 ----------
  const pick = await cdp.eval(`(async () => await window.api.apiClient.pickFile())()`)
  check(
    'pickFile：回包带路径 / 文件名 / 大小',
    pick.canceled === false && pick.file?.path === UPLOAD_PATH && pick.file?.name === '上传样例.txt' && pick.file?.size === UPLOAD_BYTES.length,
    JSON.stringify(pick)
  )

  exitCode = 0
  console.log(`\n截图：${join(SHOT_DIR, 'api-body-urlencoded.png')} / ${join(SHOT_DIR, 'api-body-form-data.png')}`)
} catch (e) {
  console.error('\n探针失败：', e instanceof Error ? e.message : e)
  try {
    await cdp.screenshot(join(OUT_DIR, 'api-body-ui-fail.png'))
    console.error('失败截图：' + join(OUT_DIR, 'api-body-ui-fail.png'))
  } catch {
    // 截图失败不影响结论
  }
} finally {
  cdp.close()
  server.close()
  try {
    process.kill(child.pid)
  } catch {
    // 已退出
  }
  await log.close()
  await fs.rm(userData, { recursive: true, force: true }).catch(() => {})
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
}

process.exit(report([['接口请求请求体三形态 UI 链路', exitCode === 0]]) === 0 ? exitCode : 1)
