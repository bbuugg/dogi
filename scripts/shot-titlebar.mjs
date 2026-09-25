// 标题栏取色/截图诊断：正常态 + 强制 :hover 态各截一张（裁剪放大右侧按钮区），并打印计算样式。
// 用法：node scripts/shot-titlebar.mjs（需先启动 9333 上的隔离实例，见 AGENTS.md）
import { connect, sleep } from './lib/cdp.mjs'

const OUT = '.workbuddy-ai/shots'
const cdp = await connect()
await cdp.bringToFront()
// 改完 CSS 要 reload 才能看到新产物（注入/截图前必须 reload，否则看的是旧样式）
await cdp.reload(2500)
await cdp.bringToFront()
await cdp.emulateColorScheme('light')
await sleep(900)

const info = await cdp.eval(`(() => {
  const header = document.querySelector('header')
  const btns = [...header.querySelectorAll('button')]
  return {
    header: { h: header.getBoundingClientRect().height, cls: header.className, bg: getComputedStyle(header).backgroundColor },
    width: window.innerWidth,
    btns: btns.map((b) => {
      const cs = getComputedStyle(b)
      const r = b.getBoundingClientRect()
      return { title: b.title, box: [Math.round(r.width), Math.round(r.height)], color: cs.color, bg: cs.backgroundColor }
    })
  }
})()`)
console.log(JSON.stringify(info, null, 2))

const { width } = info
const h = info.header.h
const clip = { x: width - 140, y: 0, width: 140, height: h, scale: 3 }
await cdp.screenshotClip(`${OUT}/titlebar-normal.png`, clip)

// 强制关闭按钮 :hover，看配色是否真的生效（缺令牌时会出现「红底 + 灰字」）
await cdp.send('DOM.enable')
await cdp.send('CSS.enable')
const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
  nodeId: root.nodeId,
  selector: 'header > div:last-child > button:last-child'
})
if (nodeIds.length) {
  await cdp.send('CSS.forcePseudoState', { nodeId: nodeIds[0], forcedPseudoClasses: ['hover'] })
}
await sleep(300)
const hoverInfo = await cdp.eval(`(() => {
  const b = document.querySelector('header > div:last-child > button:last-child')
  const cs = getComputedStyle(b)
  return { bg: cs.backgroundColor, color: cs.color }
})()`)
console.log('关闭按钮 hover（强制）:', JSON.stringify(hoverInfo))
await cdp.screenshotClip(`${OUT}/titlebar-hover-close.png`, clip)

cdp.close()
