// 远程桌面「独立主机类型」界面链路验证 ——
// 新建主机对话框的三类型选择（远程 SSH / 远程桌面 / 本地终端）+ rdp 字段与保存；
// 主机行菜单不再有「远程桌面 (RDP)」直达入口（rdp 主机直接「连接」）；
// 编辑对话框可切换类型（segmented 可改、字段随类型换）；
// RdpPage 读主机配置自动连接（有密码）/ 弹凭据对话框（无密码，可勾选保存回配置）。
//
// 自起隔离实例（CDP 9341）；连接目标端口无真实 RDP 服务器，连接必然失败 ——
// 断言的是流程正确（桥已就绪 → 页面进入断开态），不是画面。
// 运行：node scripts/verify-rdp-host-ui.mjs（需先 npm run build）
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, sleep } from './lib/cdp.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CDP_PORT = 9341
const OUT_DIR = join(REPO_ROOT, '.workbuddy-ai', 'shots')
const userData = join(tmpdir(), 'dogi-rdp-host-ui-cdp')

const check = (label, ok) => {
  if (!ok) throw new Error(`FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(OUT_DIR, { recursive: true })
const log = await fs.open(join(OUT_DIR, 'rdp-host-ui.log'), 'a')
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
  { cwd: REPO_ROOT, stdio: ['ignore', log.fd, log.fd], detached: true }
)
child.unref()

const cdp = await connect({ port: CDP_PORT })

/** 轮询求值直到谓词为真 */
async function waitEval(expr, pred, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cdp.eval(expr)
      if (pred(last)) return last
    } catch {
      // 页面仍在校验过程中，继续轮询
    }
    await sleep(150)
  }
  return last
}

async function run() {
  await cdp.bringToFront()

  // 等 bootstrap 完成
  {
    const ready = await waitEval(
      `!!(window.__store && window.__store.getState().shells !== null)`,
      (v) => v === true,
      30000
    )
    check('渲染端 bootstrap 已完成', ready === true)
  }

  // 可重复执行：清掉遗留弹窗与 pvrdp-* 主机
  await cdp.eval(`(async () => {
    for (const m of Array.from(document.querySelectorAll('.ant-modal'))) {
      const cancel = Array.from(m.querySelectorAll('button')).find((b) => b.textContent.replace(/\\s+/g, '') === '取消')
      if (cancel) cancel.click()
    }
    const profiles = await window.api.ssh.list()
    for (const p of profiles) if (p.name.startsWith('pvrdp-')) await window.api.ssh.remove(p.id)
    const st = window.__store.getState()
    await st.refreshProfiles()
    st.selectActivity('hosts')
    return 'ok'
  })()`)

  // 注入页面侧小工具
  await cdp.eval(`window.__pv5 = {
    byText: (sel, text) => Array.from(document.querySelectorAll(sel)).find((el) => el.textContent.replace(/\\s+/g, '') === text) || null,
    modalByTitle: (title) => Array.from(document.querySelectorAll('.ant-modal')).find((m) => m.textContent.includes(title)) || null,
    visibleModalText: () => {
      const wrap = Array.from(document.querySelectorAll('.ant-modal-wrap')).find((w) => w.style.display !== 'none')
      return wrap ? wrap.textContent : ''
    },
    clickModalButton: (text) => {
      // 必须在「可见」的弹窗里找：RdpPage 的凭据弹窗 forceRender，已挂载的隐藏弹窗里也有同名按钮
      const wrap = Array.from(document.querySelectorAll('.ant-modal-wrap')).find((w) => w.style.display !== 'none')
      const scope = wrap ?? document
      // 模板字面量里必须写成 \\s：少一个反斜杠，页面里就变成 /s+/g，按钮永远匹配不到
      const btn = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent.replace(/\\s+/g, '') === text)
      if (!btn) return 'BTN-NOT-FOUND:' + text
      btn.click()
      return 'ok'
    },
    segTexts: () => Array.from(document.querySelectorAll('.ant-modal .ant-segmented-item-label')).map((el) => el.textContent.trim()),
    // 选中态直接读 radio 的 checked：segmented 的 -item-selected 类在拇指动画期间会被摘掉
    segSelected: () => {
      const label = Array.from(document.querySelectorAll('.ant-modal .ant-segmented-item')).find(
        (el) => el.querySelector('input[type="radio"]')?.checked
      )
      return label ? label.textContent.trim() : null
    },
    // rc-segmented 的切换靠 label 里 radio 的原生 change；必须点 input，
    // 对 label 派发合成 MouseEvent 不会转发到 radio
    clickSegment: (text) => {
      const item = Array.from(document.querySelectorAll('.ant-modal .ant-segmented-item')).find((el) => el.textContent.trim() === text)
      if (!item) return 'SEG-NOT-FOUND:' + text
      const input = item.querySelector('input[type="radio"]')
      if (!input) return 'SEG-INPUT-NOT-FOUND:' + text
      input.click()
      return 'ok'
    },
    setInputById: (id, value) => {
      const input = document.getElementById(id)
      if (!input) return 'INPUT-NOT-FOUND:' + id
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    },
    valById: (id) => {
      const el = document.getElementById(id)
      return el ? el.value : null
    },
    setModalInputByPlaceholder: (ph, value) => {
      const wrap = Array.from(document.querySelectorAll('.ant-modal-wrap')).find((w) => w.style.display !== 'none')
      if (!wrap) return 'MODAL-NOT-VISIBLE'
      const input = wrap.querySelector('input[placeholder="' + ph + '"]')
      if (!input) return 'INPUT-NOT-FOUND:' + ph
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    },
    clickVisibleModalCheckbox: () => {
      const wrap = Array.from(document.querySelectorAll('.ant-modal-wrap')).find((w) => w.style.display !== 'none')
      if (!wrap) return 'MODAL-NOT-VISIBLE'
      const box = wrap.querySelector('.ant-checkbox-wrapper')
      if (!box) return 'CHECKBOX-NOT-FOUND'
      box.click()
      return 'ok'
    },
    openMenuOnRow: (name) => {
      const els = Array.from(document.querySelectorAll('div')).filter((d) => d.textContent.trim() === name)
      const el = els[els.length - 1]
      if (!el) return 'ROW-NOT-FOUND:' + name
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      return 'ok'
    },
    clickMenuItem: (text) => {
      const item = Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find((i) => i.textContent.trim() === text)
      if (!item) return 'MENU-NOT-FOUND:' + text
      item.click()
      return 'ok'
    },
    menuItemTexts: () => Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).map((i) => i.textContent.trim()),
    closeMenu: () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      return 'ok'
    }
  }; 'ok'`)

  // ---- A. 新建主机对话框：三类型选择 + rdp 字段 ----
  await cdp.eval(`window.__store.getState().setSshDialog(true, null); 'ok'`)
  const dialogOpen = await waitEval(`!!window.__pv5.modalByTitle('新建主机')`, (v) => v === true, 6000)
  check('「新建主机」对话框已打开', dialogOpen === true)
  const segTexts = await cdp.eval(`window.__pv5.segTexts()`)
  check(
    `主机类型是三分段（远程 SSH / 远程桌面 / 本地终端）：${JSON.stringify(segTexts)}`,
    Array.isArray(segTexts) &&
      segTexts.length === 3 &&
      segTexts[0] === '远程 SSH' &&
      segTexts[1] === '远程桌面' &&
      segTexts[2] === '本地终端'
  )
  check('新建时默认选中「远程 SSH」', (await cdp.eval(`window.__pv5.segSelected()`)) === '远程 SSH')

  const segClicked = await cdp.eval(`window.__pv5.clickSegment('远程桌面')`)
  check('点击「远程桌面」分段', segClicked === 'ok')
  await sleep(250)
  const segAfter = await cdp.eval(`window.__pv5.segSelected()`)
  check(`切换后选中「远程桌面」（实际：${JSON.stringify(segAfter)}）`, segAfter === '远程桌面')
  const rdpFields = await cdp.eval(
    `['rdp-host', 'rdp-port', 'rdp-user', 'rdp-domain', 'rdp-password'].map((id) => !!document.getElementById(id))`
  )
  const rdpFieldDiag = await cdp.eval(
    `(() => {
      const ids = ['rdp-host', 'rdp-port', 'rdp-user', 'rdp-domain', 'rdp-password', 'ssh-host', 'ssh-port', 'local-auto-command', 'ssh-name']
      const pres = ids.map((id) => id + '=' + !!document.getElementById(id)).join(' ')
      const modals = Array.from(document.querySelectorAll('.ant-modal'))
      const visible = modals.filter((m) => m.closest('.ant-modal-wrap')?.style.display !== 'none')
      const m = visible[0] || modals[0]
      const txt = m ? (m.textContent || '').replace(/\\s+/g, ' ').slice(0, 200) : '(no modal)'
      return pres + ' || modals=' + modals.length + ' visible=' + visible.length +
        ' rootChildren=' + (document.getElementById('root')?.childElementCount ?? -1) +
        ' bodyKids=' + document.body.childElementCount + ' || ' + txt
    })()`
  )
  console.log('  诊断：' + rdpFieldDiag)
  check(`切到「远程桌面」：rdp 字段齐备`, rdpFields.every(Boolean) === true)
  check('切到「远程桌面」：端口自动换为 3389', (await cdp.eval(`window.__pv5.valById('rdp-port')`)) === '3389')
  const sshGone = await cdp.eval(
    `!document.getElementById('ssh-host') && !document.body.textContent.includes('使用 Mosh')`
  )
  check('「远程桌面」下不渲染 ssh 专属区（ssh 主机地址 id / Mosh 开关）', sshGone === true)

  // 默认值：切到远程桌面后端口 3389 / 用户名 administrator 预填（用户改过的不动）
  const kindDefaults = await cdp.eval(`(() => {
    const user = document.getElementById('rdp-user')
    const port = document.getElementById('rdp-port')
    return { user: user ? user.value : null, port: port ? port.value : null }
  })()`)
  check(
    `切换到远程桌面：端口 3389 / 用户名 administrator 预填（实际：${JSON.stringify(kindDefaults)}）`,
    kindDefaults.user === 'administrator' && String(kindDefaults.port) === '3389'
  )

  // footer 按钮靠右：rdp 类型没有「测试连接」，取消/保存/保存并连接也必须贴右缘
  // （历史上测试连接带 mr-auto 把按钮推右，按钮移除后整排曾塌到左边）
  const footerGeom = await cdp.eval(`(() => {
    const wrap = Array.from(document.querySelectorAll('.ant-modal-wrap')).find((w) => w.style.display !== 'none')
    const footer = wrap ? wrap.querySelector('.ant-modal-footer') : null
    if (!footer) return null
    const btns = Array.from(footer.querySelectorAll('button'))
    if (btns.length === 0) return null
    const fr = footer.getBoundingClientRect()
    const first = btns[0].getBoundingClientRect()
    const last = btns[btns.length - 1].getBoundingClientRect()
    return { gapLeft: Math.round(first.left - fr.left), gapRight: Math.round(fr.right - last.right) }
  })()`)
  check(
    `rdp 弹窗 footer 按钮贴右缘（实际：${JSON.stringify(footerGeom)}）`,
    !!footerGeom && footerGeom.gapRight <= 40 && footerGeom.gapLeft > 80
  )

  await cdp.eval(`window.__pv5.setInputById('ssh-name', 'pvrdp-win')`)
  await cdp.eval(`window.__pv5.setInputById('rdp-host', '127.0.0.1')`)
  await cdp.eval(`window.__pv5.setInputById('rdp-port', 29421)`)
  await cdp.eval(`window.__pv5.setInputById('rdp-user', 'probe')`)
  await cdp.eval(`window.__pv5.setInputById('rdp-domain', 'CORP')`)
  await cdp.eval(`window.__pv5.setInputById('rdp-password', 'pw1')`)
  await cdp.screenshot(join(REPO_ROOT, 'tmp', 'pv5-rdp-dialog.png'))
  const wrapDiag = await cdp.eval(
    `JSON.stringify(Array.from(document.querySelectorAll('.ant-modal-wrap')).map((w) => ({ disp: w.style.display, btns: Array.from(w.querySelectorAll('button')).map((b) => b.textContent.replace(/\\s+/g, '')) })))`
  )
  console.log(`  弹窗清单：${wrapDiag}`)
  const saveClicked = await cdp.eval(`window.__pv5.clickModalButton('保存')`)
  await sleep(900)
  const saveState = await cdp.eval(`(async () => {
    const wrap = Array.from(document.querySelectorAll('.ant-modal-wrap')).find((w) => w.style.display !== 'none')
    const errs = wrap ? Array.from(wrap.querySelectorAll('.ant-form-item-explain-error')).map((e) => e.textContent) : []
    const errText = wrap ? (wrap.querySelector('p.text-destructive')?.textContent ?? null) : null
    const p = (await window.api.ssh.list()).find((x) => x.name === 'pvrdp-win')
    return JSON.stringify({ stillOpen: !!wrap, errs, errText, saved: p ? { kind: p.kind, port: p.port, user: p.username, hasPw: p.hasPassword } : null })
  })()`)
  console.log(`  保存：click=${saveClicked} state=${saveState}`)
  const saved = await waitEval(`!window.__pv5.modalByTitle('新建主机')`, (v) => v === true, 8000)
  check('保存后对话框关闭', saved === true)
  const p1 = await cdp.eval(`window.api.ssh.list().then((l) => {
    const p = l.find((x) => x.name === 'pvrdp-win')
    if (!p) return null
    return { id: p.id, name: p.name, kind: p.kind, host: p.host, port: p.port, username: p.username, domain: p.domain ?? null, hasPassword: p.hasPassword === true }
  })`)
  check(
    'rdp 主机已保存：kind=rdp / 127.0.0.1:29421 / 域 CORP / 密码已加密存（hasPassword）',
    Boolean(p1 && p1.kind === 'rdp' && p1.host === '127.0.0.1' && p1.port === 29421 && p1.username === 'probe' && p1.domain === 'CORP' && p1.hasPassword === true)
  )

  // ---- B. 主机行菜单：rdp 主机没有「远程桌面 (RDP)」直达入口 ----
  await cdp.eval(`window.__store.getState().selectActivity('hosts'); 'ok'`)
  await sleep(300)
  const menuOpened = await waitEval(
    `window.__pv5.openMenuOnRow('pvrdp-win')`,
    (v) => v === 'ok',
    6000
  )
  check('右键 rdp 主机行打开菜单', menuOpened === 'ok')
  const menuTexts = await cdp.eval(`window.__pv5.menuItemTexts()`)
  check(`菜单包含「连接」与「编辑」：${JSON.stringify(menuTexts)}`, menuTexts.includes('连接') && menuTexts.includes('编辑'))
  check('菜单不再有「远程桌面 (RDP)」直达入口', !menuTexts.some((t) => t.includes('远程桌面')))
  check('rdp 主机没有 SFTP / 隧道入口（仅 ssh 主机提供）', !menuTexts.includes('SFTP 文件管理') && !menuTexts.some((t) => t.includes('隧道')))
  await cdp.eval(`window.__pv5.closeMenu()`)
  await sleep(200)

  // ---- C. 编辑对话框：类型可切换 + rdp 字段回填 ----
  await cdp.eval(`window.__pv5.openMenuOnRow('pvrdp-win')`)
  await sleep(300)
  await cdp.eval(`window.__pv5.clickMenuItem('编辑')`)
  const editOpen = await waitEval(`!!window.__pv5.modalByTitle('编辑主机')`, (v) => v === true, 6000)
  check('菜单「编辑」打开编辑主机对话框', editOpen === true)
  check('编辑 rdp 主机：segmented 停在「远程桌面」（类型可改不锁死）', (await cdp.eval(`window.__pv5.segSelected()`)) === '远程桌面')
  check('编辑回填：主机地址 127.0.0.1', (await cdp.eval(`window.__pv5.valById('rdp-host')`)) === '127.0.0.1')
  check('编辑回填：端口 29421', (await cdp.eval(`window.__pv5.valById('rdp-port')`)) === '29421')
  check('编辑回填：域 CORP', (await cdp.eval(`window.__pv5.valById('rdp-domain')`)) === 'CORP')
  const pwPh = await cdp.eval(`document.getElementById('rdp-password')?.placeholder ?? null`)
  check('编辑回填：密码占位提示「已保存（留空保持不变）」', pwPh === '已保存（留空保持不变）')
  await cdp.eval(`window.__pv5.clickSegment('远程 SSH')`)
  await sleep(250)
  const sshShown = await cdp.eval(`!!document.getElementById('ssh-host') && !document.getElementById('rdp-host')`)
  check('切到「远程 SSH」：字段区切换成 ssh 分支', sshShown === true)
  await cdp.eval(`window.__pv5.clickSegment('远程桌面')`)
  await sleep(250)
  check('切回「远程桌面」：域值仍为 CORP（表单值保留）', (await cdp.eval(`window.__pv5.valById('rdp-domain')`)) === 'CORP')
  await cdp.eval(`window.__pv5.clickModalButton('取消')`)
  await waitEval(`!window.__pv5.modalByTitle('编辑主机')`, (v) => v === true, 6000)

  // ---- D. rdp 主机「连接」：开远程桌面标签 + 读配置自动连接 ----
  const profileId = p1?.id ?? ''
  await cdp.eval(`window.__pv5.openMenuOnRow('pvrdp-win')`)
  await sleep(300)
  await cdp.eval(`window.__pv5.clickMenuItem('连接')`)
  const tabOpened = await waitEval(
    `window.__store.getState().ui.panelTabs.some((t) => t.id === 'rdp-' + ${JSON.stringify(profileId)})`,
    (v) => v === true,
    6000
  )
  check('「连接」打开 rdp-<id> 标签', tabOpened === true)
  const noSession = await cdp.eval(
    `!window.__store.getState().sessions.some((s) => s.profileId === ${JSON.stringify(profileId)})`
  )
  check('rdp 连接不创建终端会话', noSession === true)
  const bridgeReady = await waitEval(
    `window.api.logs.list().then((logs) => logs.some((e) => e.scope === 'rdp' && e.message.includes('[rdp-' + ${JSON.stringify(profileId)} + '] 本地桥已就绪')))`,
    (v) => v === true,
    12000
  )
  check('RdpPage 读配置开启本地桥（目标取自主机配置）', bridgeReady === true)
  const noPrompt = await cdp.eval(`!window.__pv5.visibleModalText().includes('远程桌面')`)
  check('密码已保存：不弹凭据对话框（自动连接）', noPrompt === true)
  const ended = await waitEval(
    `document.body.textContent.includes('远程桌面连接已断开')`,
    (v) => v === true,
    30000
  )
  check('无真实 RDP 服务器：连接失败并进入「已断开」态（流程走通）', ended === true)
  await cdp.screenshot(join(REPO_ROOT, 'tmp', 'pv5-rdp-autoconnect.png'))

  // ---- E. 无密码的 rdp 主机：弹凭据对话框 + 勾选保存回配置 ----
  const noPwId = await cdp.eval(`
    (async () => {
      const list = await window.api.ssh.save({
        id: '', kind: 'rdp', name: 'pvrdp-nopw', host: '127.0.0.1', port: 29422,
        username: '', authType: 'password'
      })
      await window.__store.getState().refreshProfiles()
      return list.find((p) => p.name === 'pvrdp-nopw').id
    })()
  `)
  check('无密码 rdp 主机已保存', Boolean(noPwId))
  const connected = await cdp.eval(`(() => {
    const st = window.__store.getState()
    const prof = st.profiles.find((p) => p.name === 'pvrdp-nopw')
    if (!prof) return 'NO-PROFILE'
    void st.connectHost(prof).catch(() => {})
    return 'ok'
  })()`)
  check('触发无密码主机的连接', connected === 'ok')
  const promptShown = await waitEval(
    `window.__pv5.visibleModalText().includes('远程桌面')`,
    (v) => v === true,
    10000
  )
  check('无密码：打开标签后弹出凭据对话框', promptShown === true)
  const promptText = await cdp.eval(`window.__pv5.visibleModalText()`)
  check(
    '对话框展示配置地址（127.0.0.1:29422）与保存勾选项',
    promptText.includes('127.0.0.1:29422') && promptText.includes('保存到主机配置')
  )
  const noPortInput = await cdp.eval(`
    (() => {
      const wrap = Array.from(document.querySelectorAll('.ant-modal-wrap')).find((w) => w.style.display !== 'none')
      return wrap ? wrap.querySelectorAll('.ant-input-number').length === 0 : false
    })()
  `)
  check('对话框不含端口输入框（端口取自主机配置）', noPortInput === true)
  await cdp.screenshot(join(REPO_ROOT, 'tmp', 'pv5-rdp-prompt.png'))
  const setUser = await cdp.eval(`window.__pv5.setModalInputByPlaceholder('Windows 账号（域账号可只填用户名）', 'probe2')`)
  const setPw = await cdp.eval(`window.__pv5.setModalInputByPlaceholder('Windows 登录密码', 'pw2')`)
  const cbToggled = await cdp.eval(`window.__pv5.clickVisibleModalCheckbox()`)
  const btnBefore = await cdp.eval(
    `JSON.stringify(Array.from(document.querySelectorAll('.ant-modal button')).map((b) => ({ text: b.textContent.replace(/\\s+/g, ''), cls: b.className.split(' ').slice(0, 2).join('.'), vis: b.closest('.ant-modal-wrap')?.style.display !== 'none' })))`
  )
  console.log(`  按钮清单：${btnBefore}`)
  const okClicked = await cdp.eval(`window.__pv5.clickModalButton('连接')`)
  console.log(`  填写：user=${setUser} pw=${setPw} checkbox=${cbToggled} ok=${okClicked}`)
  await sleep(600)
  const afterSubmit = await cdp.eval(`(async () => {
    const wrap = Array.from(document.querySelectorAll('.ant-modal-wrap')).find((w) => w.style.display !== 'none')
    const errs = wrap ? Array.from(wrap.querySelectorAll('.ant-form-item-explain-error')).map((e) => e.textContent) : []
    const p = (await window.api.ssh.list()).find((x) => x.name === 'pvrdp-nopw')
    return JSON.stringify({ modalOpen: !!wrap, errs, checked: wrap ? !!wrap.querySelector('input[type=checkbox]')?.checked : null, profile: p ? { user: p.username, hasPw: p.hasPassword === true } : null })
  })()`)
  console.log(`  提交后：${afterSubmit}`)
  const savedBack = await waitEval(
    `window.api.ssh.list().then((l) => { const p = l.find((x) => x.name === 'pvrdp-nopw'); return !!(p && p.hasPassword === true && p.username === 'probe2') })`,
    (v) => v === true,
    12000
  )
  check('勾选保存：凭据写回主机配置（hasPassword=true / username=probe2）', savedBack === true)

  // ---- 清理 ----
  await cdp.eval(`(async () => {
    const profiles = await window.api.ssh.list()
    for (const p of profiles) if (p.name.startsWith('pvrdp-')) await window.api.ssh.remove(p.id)
    await window.__store.getState().refreshProfiles()
    return 'ok'
  })()`)
}

let failed = 0
try {
  await run()
  console.log('\nALL PASS')
} catch (err) {
  console.error(`\n${err.stack ?? err}`)
  failed = 1
} finally {
  await sleep(200)
  cdp.close()
  try {
    process.kill(child.pid)
  } catch {
    // 已退出
  }
  await log.close()
}
process.exit(failed)
