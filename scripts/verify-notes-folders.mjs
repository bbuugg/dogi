/**
 * 笔记「多目录侧边栏」端到端验证（隔离 Electron 实例 + CDP 驱动真 UI）。
 *
 * 覆盖：
 * 1. 「打开文件夹」可一次加入多个目录（DOGI_NOTES_OPEN_DIRS 旁路，同 DOGI_SFTP_UPLOAD_DIR
 *    约定 —— 原生目录选择框无法自动化，仅探针设置），侧边栏每个目录一个根节点、各一棵文件树；
 * 2. 重复打开同一目录被去重（再点一次打开、大小写不同的同一路径都只提示不重复加入）；
 * 3. 父子目录可以同时打开（dirA 与 dirA/sub 并存，同一文件出现在两棵树里互不干扰）；
 * 4. 「打开文件」入口已移除（工具栏无按钮、preload 无 openFile 方法）；
 * 5. 点击文件开编辑标签（真实点击 → readFile → 标签 → 编辑器读出内容）；
 * 6. 移除目录只出侧边栏、磁盘文件不动；
 * 7. 重启后打开的目录与文件标签按原样恢复，被移除的目录保持移除（electron-store 落盘）；
 * 8. 旧格式存档（noteSession.folder 单值）读取时迁移成 folders 数组。
 *
 * 跑：node scripts/verify-notes-folders.mjs（在项目根目录执行；需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { connect, sleep } from './lib/cdp.mjs'

const CDP_PORT = 9377
const base = join(tmpdir(), `dogi-notes-folders-${Date.now()}`)
const userData = join(base, 'profile')
const dirA = join(base, 'noteA')
const dirB = join(base, 'noteB')
const dirC = join(base, 'noteC')
const sub = join(dirA, 'sub')
const alphaAbs = join(dirA, 'alpha.md')
const LOG = join(base, 'probe.log')
const SHOT = (name) => join(base, name)

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

// ---------- 准备三个笔记目录 ----------
await fs.mkdir(join(dirA, 'sub'), { recursive: true })
await fs.mkdir(dirB, { recursive: true })
await fs.mkdir(dirC, { recursive: true })
// 纯文本行（不带 markdown 语法），Milkdown 会按段落原样渲染，方便断言编辑器读到了内容
await fs.writeFile(alphaAbs, 'alpha-content-marker\n', 'utf8')
await fs.writeFile(join(sub, 'nested.md'), 'nested-marker\n', 'utf8')
await fs.writeFile(join(dirB, 'beta.md'), 'beta-marker\n', 'utf8')
await fs.writeFile(join(dirC, 'legacy.md'), 'legacy-marker\n', 'utf8')

const logHandle = await fs.open(LOG, 'a')

function launch(extraEnv = {}) {
  const child = spawn(
    'node_modules/electron/dist/electron.exe',
    [
      '.',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userData}`,
      '--no-sandbox',
      '--in-process-gpu',
      '--disable-gpu-sandbox'
    ],
    {
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      detached: true,
      env: { ...process.env, ...extraEnv }
    }
  )
  child.unref()
  return child
}

async function waitReady(cdp) {
  const start = Date.now()
  for (;;) {
    if ((await cdp.eval('!!(window.__store && window.__store.getState().shells !== null)')) === true) return
    if (Date.now() - start > 30000) throw new Error('等待 bootstrap 超时')
    await sleep(250)
  }
}

/** 切到笔记功能区并等侧边栏渲染出来 */
async function gotoNotes(cdp) {
  await cdp.eval(`(() => {
    const s = window.__store.getState()
    window.__store.setState({ ui: { ...s.ui, activeActivity: 'notes' } })
  })()`)
  await waitFor(cdp, "document.body.innerText.includes('笔记')")
}

async function waitFor(cdp, expr, timeoutMs = 8000, label = expr) {
  const start = Date.now()
  for (;;) {
    if ((await cdp.eval(expr)) === true) return
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(200)
  }
}

/** 点击侧边栏文件树 / 工具栏里的按钮（真实 click 事件，React 能收到） */
async function clickByTitle(cdp, title) {
  await cdp.eval(`(() => {
    const el = document.querySelector('[title="${title}"]')
    if (!el) throw new Error('找不到 [title=${title}]')
    el.click()
  })()`)
}

async function clickTreeFile(cdp, name) {
  await cdp.eval(`(() => {
    const span = [...document.querySelectorAll('.notes-tree span')].find((e) => e.textContent === '${name}')
    if (!span) throw new Error('文件树里找不到 ${name}')
    span.click()
  })()`)
}

const stop = async (child) => {
  if (!child) return
  process.kill(child.pid)
  child = null
  // 等调试端口真正释放，别让下一次连接连到垂死的实例
  await sleep(1200)
}

let child = null
let cdp = null
try {
  // ================= 第一次启动：多目录 + 去重 + 父子并存 =================
  child = launch({ DOGI_NOTES_OPEN_DIRS: `${dirA}|${dirB}` })
  cdp = await connect({ port: CDP_PORT })
  await cdp.bringToFront()
  await cdp.reload()
  await waitReady(cdp)
  await gotoNotes(cdp)

  // 空态 → 点「打开文件夹」（旁路返回 dirA + dirB 两个目录）
  await clickByTitle(cdp, '打开文件夹')
  await waitFor(
    cdp,
    `(() => {
      const s = window.__store.getState()
      return s.noteRoots.length === 2
        && s.noteRoots[0] === ${JSON.stringify(dirA)}
        && s.noteRoots[1] === ${JSON.stringify(dirB)}
        && (s.noteTrees[${JSON.stringify(dirA)}] ?? []).length === 2
        && (s.noteTrees[${JSON.stringify(dirB)}] ?? []).length === 1
    })()`,
    8000,
    '两个目录进入 store 且树已扫描'
  )
  console.log('  ok  打开文件夹一次加入两个目录（顺序保留、各自成根）')

  await waitFor(cdp, "document.body.innerText.includes('alpha.md') && document.body.innerText.includes('beta.md')")
  await cdp.screenshot(SHOT('notes-1-multi-roots.png'))

  // 重复打开：旁路再次返回同样两个目录 → 全部跳过，侧边栏不变，有提示
  await clickByTitle(cdp, '打开文件夹')
  await waitFor(cdp, "document.body.innerText.includes('已在侧边栏中')", 6000, '去重提示出现')
  check('重复打开同一目录被去重（store 不变）', (await cdp.eval('window.__store.getState().noteRoots.length')) === 2)

  // 「打开文件」入口已移除
  check('工具栏没有「打开文件」按钮', (await cdp.eval("!!document.querySelector('[title=\"打开文件\"]')")) === false)
  check('preload 已无 notes.openFile 方法', (await cdp.eval('window.api.notes.openFile === undefined')) === true)

  // 父子目录并存：把 dirA/sub 也加进来
  const nestedAdd = await cdp.eval(`window.__store.getState().addNoteRoots([${JSON.stringify(sub)}])`)
  check('父子目录可以同时打开（sub 加入成功）', nestedAdd.added === 1 && nestedAdd.skipped === 0)
  check(
    'sub 作为独立根节点出现且树里有 nested.md',
    (await cdp.eval(`(() => {
      const s = window.__store.getState()
      const tree = s.noteTrees[${JSON.stringify(sub)}] ?? []
      return s.noteRoots.length === 3 && tree.length === 1 && tree[0].name === 'nested.md'
    })()`)) === true
  )
  await waitFor(cdp, "document.body.innerText.includes('nested.md')")

  // 大小写不同的同一路径也算同一个目录（Windows / macOS 不区分大小写）
  if (process.platform === 'win32') {
    const caseAdd = await cdp.eval(`window.__store.getState().addNoteRoots([${JSON.stringify(dirA.toLowerCase())}])`)
    check('大小写不同的同一路径被去重', caseAdd.added === 0 && caseAdd.skipped === 1)
    check('去重后仍是 3 个目录', (await cdp.eval('window.__store.getState().noteRoots.length')) === 3)
  }

  // 点击 alpha.md 开标签，编辑器读到内容
  await clickTreeFile(cdp, 'alpha.md')
  await waitFor(cdp, "document.body.innerText.includes('alpha-content-marker')", 8000, '编辑器读到 alpha.md 内容')
  check(
    '点击文件开了编辑标签（noteFilePath = 绝对路径）',
    (await cdp.eval(`window.__store.getState().ui.panelTabs.some(
      (t) => t.type === 'note' && t.noteFilePath === ${JSON.stringify(alphaAbs)}
    )`)) === true
  )
  await cdp.screenshot(SHOT('notes-2-open-file.png'))

  // 移除 dirB：只出侧边栏，磁盘文件不动
  await cdp.eval(`window.__store.getState().removeNoteRoot(${JSON.stringify(dirB)})`)
  await sleep(300)
  check(
    '移除后侧边栏只剩 2 个目录',
    (await cdp.eval(`(() => {
      const s = window.__store.getState()
      return s.noteRoots.length === 2
        && !s.noteRoots.includes(${JSON.stringify(dirB)})
        && s.noteTrees[${JSON.stringify(dirB)}] === undefined
    })()`)) === true
  )
  check('磁盘文件仍在（移除不删文件）', (await fs.stat(join(dirB, 'beta.md'))).isFile())

  // 会话已落盘（订阅 400ms 节流）
  await sleep(900)
  const session1 = await cdp.eval('window.api.notes.getSession()')
  check(
    '会话落盘：folders + files 都在',
    JSON.stringify(session1.folders) === JSON.stringify([dirA, sub])
      && JSON.stringify(session1.files) === JSON.stringify([alphaAbs])
  )

  await stop(child)
  cdp.close()

  // ================= 第二次启动：重启恢复（目录 + 标签，移除保持） =================
  child = launch()
  cdp = await connect({ port: CDP_PORT })
  await cdp.bringToFront()
  await cdp.reload()
  await waitReady(cdp)
  await gotoNotes(cdp)

  check(
    '重启后目录按原样恢复（dirA、sub；被移除的 dirB 保持移除）',
    (await cdp.eval(`(() => {
      const roots = window.__store.getState().noteRoots
      return JSON.stringify(roots) === JSON.stringify([${JSON.stringify(dirA)}, ${JSON.stringify(sub)}])
    })()`)) === true
  )
  check(
    '重启后打开过的文件标签被恢复（文件仍在树中才恢复）',
    (await cdp.eval(`window.__store.getState().ui.panelTabs.some(
      (t) => t.type === 'note' && t.noteFilePath === ${JSON.stringify(alphaAbs)}
    )`)) === true
  )
  await waitFor(cdp, "document.body.innerText.includes('alpha.md') && document.body.innerText.includes('nested.md')")
  await cdp.screenshot(SHOT('notes-3-restored.png'))

  await stop(child)
  cdp.close()

  // ================= 第三次启动：旧格式存档（folder 单值）迁移 =================
  // 直接把 electron-store 里的 noteSession 改写成旧版形态，模拟 0.0.7 之前的数据
  const configPath = join(userData, 'config.json')
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  config.noteSession = { folder: dirC, files: [join(dirC, 'legacy.md')] }
  await fs.writeFile(configPath, JSON.stringify(config), 'utf8')

  child = launch()
  cdp = await connect({ port: CDP_PORT })
  await cdp.bringToFront()
  await cdp.reload()
  await waitReady(cdp)
  await gotoNotes(cdp)

  check(
    '旧格式 folder 单值迁移成 folders 数组并恢复',
    (await cdp.eval(`(() => {
      const s = window.__store.getState()
      return JSON.stringify(s.noteRoots) === JSON.stringify([${JSON.stringify(dirC)}])
        && (s.noteTrees[${JSON.stringify(dirC)}] ?? []).some((i) => i.name === 'legacy.md')
    })()`)) === true
  )
  check(
    '旧格式的文件标签也恢复',
    (await cdp.eval(`window.__store.getState().ui.panelTabs.some(
      (t) => t.type === 'note' && t.noteFilePath === ${JSON.stringify(join(dirC, 'legacy.md'))}
    )`)) === true
  )

  console.log('\nALL PASS')
} finally {
  await stop(child)
  try { cdp?.close() } catch { /* 已断开 */ }
  await logHandle.close()
  await fs.rm(base, { recursive: true, force: true })
}
