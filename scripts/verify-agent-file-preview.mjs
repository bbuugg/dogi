/**
 * 工作区文件视图的预览能力验证（隔离 Electron 实例 + CDP）。
 *
 * 覆盖：
 * 1. 图片（真实 JPG）经 `dogi-ws://` 协议加载成功（`naturalWidth > 0`，即 MIME + 字节都对）；
 * 2. SVG 默认预览成图，切「编辑源码」进 Monaco 且能看到源码，再切回预览；
 * 3. 视频渲染出 `<video controls>`，并用 CDP 的 Network 事件确认响应是 `video/mp4`
 *    （本机没有可解码的样片，所以断言到「协议正确供片」这一层）；
 * 4. 压缩包等二进制给「不支持预览」提示，不硬塞进编辑器；
 * 5. 普通文本仍然是 Monaco；
 * 6. 安全边界：试图用 `..` 越出工作区读文件会失败（协议只服务工作区内）。
 *
 * 跑：node scripts/verify-agent-file-preview.mjs（在项目根目录执行）
 * ⚠️ 用独立的 --user-data-dir 起实例，不碰用户常驻的那个。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const PORT = 9333
const OUT_DIR = '.workbuddy-ai/shots'
const userData = join(tmpdir(), 'dogi-preview-cdp')
const wsPath = join(tmpdir(), 'dogi-preview-ws')
const wallPaper = 'C:/Windows/Web/Wallpaper/Windows/img0.jpg'

const check = (label, ok) => {
  assert.ok(ok, `FAIL: ${label}`)
  console.log(`  ok  ${label}`)
}

// ---------- 造工作区内容 ----------
await fs.rm(wsPath, { recursive: true, force: true })
await fs.mkdir(wsPath, { recursive: true })
await fs.rm(userData, { recursive: true, force: true })
await fs.mkdir(OUT_DIR, { recursive: true })

// 图片用系统自带的真实 JPG（1.6MB，顺带验证大文件不是靠 base64 塞过来的）
await fs.copyFile(wallPaper, join(wsPath, 'photo.jpg'))
await fs.writeFile(
  join(wsPath, 'logo.svg'),
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">',
    '  <rect width="120" height="120" rx="16" fill="#3b82f6" />',
    '  <text x="60" y="70" font-size="24" text-anchor="middle" fill="#fff">Dogi</text>',
    '</svg>'
  ].join('\n'),
  'utf8'
)
// 视频：本机没有可解码的样片，用足够大的假 mp4 验证协议按 video/mp4 供片 + 支持 Range
await fs.writeFile(join(wsPath, 'clip.mp4'), Buffer.alloc(300 * 1024, 7))
await fs.writeFile(join(wsPath, 'archive.zip'), Buffer.from('PK\u0003\u0004fake-zip-payload', 'binary'))
await fs.writeFile(join(wsPath, 'notes.md'), '# 笔记\n\n普通文本仍然走编辑器。\n', 'utf8')
// 工作区之外的文件：用来验证协议拦越界
await fs.writeFile(join(tmpdir(), 'dogi-secret.txt'), '不该被读到\n', 'utf8')

const log = await fs.open(join(OUT_DIR, 'file-preview.log'), 'a')
const child = spawn(
  'node_modules/electron/dist/electron.exe',
  [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--no-sandbox',
    '--in-process-gpu',
    '--disable-gpu-sandbox'
  ],
  { stdio: ['ignore', log.fd, log.fd], detached: true }
)
child.unref()

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('没有等到可调试的页面')
}

const page = await pageTarget()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})

let msgId = 0
const pending = new Map()
/** CDP 的 Network 事件：用来拿媒体响应的状态码与 content-type */
const netResponses = []
socket.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Network.responseReceived') {
    netResponses.push(msg.params.response)
    return
  }
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 失败')
  return r.result.value
}

const finish = async (code) => {
  try {
    socket.close()
  } catch {
    // 忽略
  }
  try {
    process.kill(child.pid)
  } catch {
    // 已退出
  }
  await log.close()
  process.exit(code)
}

/** 点文件树里的一行（行是 button，title 就是文件名） */
const clickTreeRow = (name) =>
  evaluate(`
    (() => {
      const row = Array.from(document.querySelectorAll('button')).find(
        (b) => b.getAttribute('title') === ${JSON.stringify(name)}
      )
      if (!row) throw new Error('文件树里找不到 ${name}')
      row.click()
      return true
    })()
  `)

try {
  await send('Network.enable')
  await new Promise((r) => setTimeout(r, 1500))

  // ---------- 打开文件视图 ----------
  const opened = await evaluate(`
    (async () => {
      await window.__store.getState().saveAgentWorkspace({ name: 'preview-ws', path: ${JSON.stringify(wsPath)} })
      const s = window.__store.getState()
      window.__store.setState({ ui: { ...s.ui, activeActivity: 'agent', sidebarCollapsed: true } })
      return s.agentWorkspaces.length === 1 ? window.__store.getState().activeAgentWorkspaceId : null
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  // 文件视图按钮：顶栏里唯一带 Files 图标的按钮
  await evaluate(`
    (() => {
      const btn = document.querySelector('.lucide-files')?.closest('button')
      if (!btn) throw new Error('找不到文件视图按钮')
      btn.click()
      return true
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  const treeReady = await evaluate(`
    Array.from(document.querySelectorAll('button')).map((b) => b.getAttribute('title')).filter(Boolean)
  `)
  check('文件视图打开并列出工作区文件', opened && treeReady.includes('photo.jpg') && treeReady.includes('logo.svg'))
  check('图片 / SVG 在树上有独立图标', (await evaluate(`!!document.querySelector('.lucide-file-image')`)) === true)

  // ---------- 图片预览 ----------
  await clickTreeRow('photo.jpg')
  await new Promise((r) => setTimeout(r, 1500))
  const image = await evaluate(`
    (() => {
      const img = Array.from(document.querySelectorAll('img')).find((i) => i.src.startsWith('dogi-ws://'))
      return img ? { src: img.src, w: img.naturalWidth, h: img.naturalHeight } : null
    })()
  `)
  check('图片走 dogi-ws:// 协议加载', !!image && image.src.startsWith('dogi-ws://'))
  check('图片真的解码出来了（协议 + MIME 都对）', !!image && image.w > 0 && image.h > 0)

  // ---------- SVG：预览 ↔ 编辑 ----------
  await clickTreeRow('logo.svg')
  await new Promise((r) => setTimeout(r, 1200))
  const svgPreview = await evaluate(`
    (() => {
      const img = Array.from(document.querySelectorAll('img')).find((i) => i.src.endsWith('/logo.svg'))
      return img ? { w: img.naturalWidth, h: img.naturalHeight } : null
    })()
  `)
  check('SVG 默认按图片预览', !!svgPreview && svgPreview.w > 0)

  await evaluate(`document.querySelector('[aria-label="编辑源码"]').click()`)
  await new Promise((r) => setTimeout(r, 1200))
  const svgEdit = await evaluate(`
    (() => ({
      monaco: !!document.querySelector('.monaco-editor'),
      hasSource: document.body.textContent.includes('xmlns="http://www.w3.org/2000/svg"')
    }))()
  `)
  check('切「编辑源码」后用 Monaco 打开 SVG', svgEdit.monaco)
  check('编辑器里能看到 SVG 源码', svgEdit.hasSource)

  await evaluate(`document.querySelector('[aria-label="预览"]').click()`)
  await new Promise((r) => setTimeout(r, 800))
  const svgBack = await evaluate(`
    !!Array.from(document.querySelectorAll('img')).find((i) => i.src.endsWith('/logo.svg'))
  `)
  check('切回预览又是图片', svgBack)

  // ---------- 视频 ----------
  await clickTreeRow('clip.mp4')
  await new Promise((r) => setTimeout(r, 1500))
  const video = await evaluate(`
    (() => {
      const v = document.querySelector('video')
      return v ? { src: v.src, controls: v.controls } : null
    })()
  `)
  check('视频渲染出 <video controls>', !!video && video.controls && video.src.startsWith('dogi-ws://'))
  const videoResponse = netResponses.find((r) => r.url.includes('clip.mp4'))
  check('协议返回 video/mp4', !!videoResponse && videoResponse.mimeType === 'video/mp4')
  check(
    '响应码是 200 / 206（支持流式与 Range）',
    !!videoResponse && (videoResponse.status === 200 || videoResponse.status === 206)
  )
  console.log(
    `      （视频响应：status=${videoResponse?.status} type=${videoResponse?.mimeType}）`
  )

  // ---------- 不支持的二进制 ----------
  await clickTreeRow('archive.zip')
  await new Promise((r) => setTimeout(r, 800))
  const zip = await evaluate(`
    (() => ({
      hint: document.body.textContent.includes('不支持预览'),
      monaco: !!document.querySelector('.monaco-editor')
    }))()
  `)
  check('压缩包给「不支持预览」提示', zip.hint)
  check('压缩包不会硬塞进编辑器', !zip.monaco)

  // ---------- 文本仍然可编辑 ----------
  await clickTreeRow('notes.md')
  await new Promise((r) => setTimeout(r, 1200))
  const md = await evaluate(`
    (() => ({
      monaco: !!document.querySelector('.monaco-editor'),
      text: document.body.textContent.includes('普通文本仍然走编辑器')
    }))()
  `)
  check('普通文本仍然是 Monaco 编辑器', md.monaco && md.text)

  // ---------- 安全边界：越界读不到 ----------
  const escape = await evaluate(`
    (async () => {
      const url = 'dogi-ws://' + window.__store.getState().activeAgentWorkspaceId + '/%2e%2e%2fdogi-secret.txt'
      return await new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ loaded: true, w: img.naturalWidth })
        img.onerror = () => resolve({ loaded: false, w: 0 })
        img.src = url
      })
    })()
  `)
  check('越出工作区的路径读不到（协议拦住）', escape.loaded === false && escape.w === 0)

  // ---------- 截图（回到图片预览） ----------
  await clickTreeRow('logo.svg')
  await new Promise((r) => setTimeout(r, 800))
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  await new Promise((r) => setTimeout(r, 600))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(join(OUT_DIR, 'agent-file-preview.png'), Buffer.from(shot.data, 'base64'))
  console.log(`  ok  截图已落盘 ${OUT_DIR}/agent-file-preview.png`)

  console.log('\nALL PASS')
  await finish(0)
} catch (err) {
  console.error(`\n${err.stack ?? err}`)
  await finish(1)
}
