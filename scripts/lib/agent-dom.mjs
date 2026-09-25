// 注入到页面里执行的 DOM 小工具（字符串形式 —— `Runtime.evaluate` 之间不共享作用域，
// 每个表达式都得自带一份）。
//
// 选择器**一律不写死宽度类**（`max-w-3xl` 这类会被随时改），而是从 fixture 的已知文本反推：
// 找到那条假消息 → 往上找到滚动容器 → 它的第一个子元素就是「装着全部消息的内层容器」。
//
// 里面用到 `用户消息 U0` 这个 fixture 文本，所以只适用于 agent-scroll-fixture 造的场景。

export const AGENT_DOM_HELPERS = `
const vis = (el) => !!el && el.offsetParent !== null
const anchorBubble = () =>
  [...document.querySelectorAll('[class~="group/msg"]')].find(
    (n) => vis(n) && /用户消息 U0/.test(n.textContent || '')
  )
const scroller = () => {
  let p = anchorBubble()
  while (p) {
    const cs = getComputedStyle(p)
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p
    p = p.parentElement
  }
  return null
}
const listInner = () => {
  const sc = scroller()
  return sc ? sc.firstElementChild : null
}
const msgNodes = () => {
  const inner = listInner()
  if (!inner) return []
  // 消息外层是那层只为挂 ref 的 div；用气泡根的 group/msg 类把它和错误条区分开
  return [...inner.children].filter((c) => c.querySelector('[class~="group/msg"]'))
}
const userNodes = () => msgNodes().filter((n) => n.querySelector('[class~="group/msg"].items-end'))
const relTop = (el, box) => Math.round(el.getBoundingClientRect().top - box.getBoundingClientRect().top)
const relBottom = (el, box) => Math.round(el.getBoundingClientRect().bottom - box.getBoundingClientRect().top)
const textarea = () => [...document.querySelectorAll('textarea')].find(vis) || null
// 按钮一律从**当前消息列表的容器**里找，不用全局 querySelector —— Agent 页与终端内嵌的
// AI 助手（AiPanel）各有一个同名的「滚动到底部」按钮，全局找会量错对象
const jumpBtn = () => {
  const sc = scroller()
  return sc && sc.parentElement ? sc.parentElement.querySelector('[aria-label="滚动到底部"]') : null
}
const bubbleOf = (node) => node.querySelector('[class~="group/msg"] > div')
/**
 * 底部留白（px）。两页统一用「消息后面插一个 data-tail-pad 占位元素」落地 ——
 * 比给容器加 paddingBottom 稳：容器可能带 min-h-full（border-box 下 padding 会被算进
 * 那 100% 高度里，撑不出滚动条），也可能带 gap/space-y（占位元素会被多算一个间距）。
 */
const tailPadOf = () => {
  const sc = scroller()
  if (!sc) return null
  const el = sc.querySelector('[data-tail-pad]')
  return el ? Math.round(el.getBoundingClientRect().height) : 0
}
/** 终端 AI 助手的输入框是单行 antd Input（不是 textarea），靠 placeholder 认 */
const aiPanelInput = () =>
  [...document.querySelectorAll('input')].find(
    (el) => vis(el) && /描述你想做的事|改完按 Enter/.test(el.placeholder || '')
  ) || null
/** React 受控输入：直接改 .value 不会触发 onChange，得走原生 setter + input 事件 */
const setVal = (el, v) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const pressKey = (el, key) => {
  el.focus()
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key, code: key, keyCode: key === 'Enter' ? 13 : 27, which: key === 'Enter' ? 13 : 27,
    bubbles: true, cancelable: true
  }))
}
`
