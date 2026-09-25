// CDP 小客户端（Node 22 自带全局 WebSocket，零依赖）。
//
// 启动隔离实例的方式见 AGENTS.md 的「验证工具链」一节；这里只管连上去发命令。
// 用法：
//   import { connect } from './lib/cdp.mjs'
//   const cdp = await connect()            // 默认 9333
//   await cdp.bringToFront()
//   await cdp.eval('1 + 1')
//   cdp.close()

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等到调试端口上出现一个可用的 page 目标（实例启动需要时间） */
async function waitForPage(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // 端口还没起来（本机 curl 走代理会回 upstream connect failed，所以用 fetch）
    }
    await sleep(500)
  }
  throw new Error(`CDP page not found on :${port}（实例起了吗？见 AGENTS.md「验证工具链」）`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 求值并取回值（异常直接抛出，别让它变成 undefined 静默通过） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception))
    }
    return r.result.value
  }

  /** 发按键前必做：reload 之后不调这两个，keydown 根本不派发 */
  async bringToFront() {
    await this.send('Page.bringToFront')
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  }

  /** 强制明暗（主题跟随 prefers-color-scheme 的应用靠这个切，然后才能截到目标主题） */
  async emulateColorScheme(value) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }]
    })
  }

  async reload(settleMs = 3000) {
    await this.send('Page.reload', { ignoreCache: true })
    await sleep(settleMs)
  }

  /** 截图存盘，返回路径 */
  async screenshot(outPath) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(outPath, Buffer.from(data, 'base64'))
    return outPath
  }

  /** 裁剪截图（局部放大看细节，如标题栏按钮区） */
  async screenshotClip(outPath, clip) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: clip.scale ?? 2 }
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(outPath, Buffer.from(data, 'base64'))
    return outPath
  }

  close() {
    this.ws.close()
  }
}

export async function connect({ port = 9333 } = {}) {
  const page = await waitForPage(port)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  return new Cdp(ws)
}

/** 打印 PASS/FAIL 汇总，返回失败数（配合 process.exit） */
export function report(checks) {
  console.log('\n=== 断言 ===')
  for (const [name, ok] of checks) console.log(ok ? 'PASS' : 'FAIL', name)
  const failed = checks.filter(([, ok]) => !ok)
  console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED`)
  return failed.length
}
