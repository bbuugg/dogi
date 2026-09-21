/**
 * 终端输入法组合（IME composition）防溢出。
 *
 * 全屏 TUI（如 pi agent）绘制完界面后常把真实光标停在行尾，xterm 会把
 * .composition-view 与 .xterm-helper-textarea 锚定在光标处，且组合期间把
 * textarea 拉宽到拼音串的实际宽度 —— 元素向右溢出屏幕后，Chrome 为暴露
 * 焦点光标会横向滚动最近的可滚动祖先（overflow-hidden 的应用根节点也算），
 * 整个终端页面被推左。
 *
 * 这里用 MutationObserver 盯住这两个元素的内联样式：一旦右缘超出
 * .xterm-screen，就把 left 回拉到屏幕内。拼音串从「光标处向右延伸」变成
 * 「贴着屏幕右缘向左生长」，始终可见，也不再触发祖先滚动。
 * 光标本就在屏幕内（常规 shell 输入）时不做任何事。
 */
export function clampCompositionOverflow(container: HTMLElement): () => void {
  const targets = container.querySelectorAll<HTMLElement>(
    '.composition-view, .xterm-helper-textarea'
  )
  if (targets.length === 0) return () => {}

  const clamp = (el: HTMLElement) => {
    const screen = container.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) return
    const width = el.getBoundingClientRect().width
    if (width <= 0) return
    const left = parseFloat(el.style.left)
    if (Number.isNaN(left)) return
    const overflow = left + width - screen.clientWidth
    if (overflow <= 0) return
    const next = Math.max(0, left - overflow)
    // 与现值相同就不再写，避免观察器自触发死循环
    if (Math.abs(parseFloat(el.style.left) - next) > 0.5) el.style.left = `${next}px`
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) clamp(r.target as HTMLElement)
  })
  for (const el of targets) {
    observer.observe(el, { attributeFilter: ['style'], attributes: true })
    clamp(el)
  }
  return () => observer.disconnect()
}
