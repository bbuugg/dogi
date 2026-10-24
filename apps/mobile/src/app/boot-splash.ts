/**
 * 首屏启动屏的退场（`index.html` 里那段静态 `#boot-splash`）。
 *
 * 启动屏**不放在 React 里**：它要在打包后的 JS 还没执行时就已经画在屏幕上，否则
 * 用户看到的是原生窗口底色 → 空白 → 界面。静态 HTML + 内联 CSS 才能盖住那段时间；
 * logo 也内联在 HTML 里（见 `vite.config.ts` 的 `bootSplashLogo` 插件），所以
 * 第一帧就是「居中 logo」，而不是等 JS 跑完才补上。
 *
 * 退场时机 = React **第一帧真的画出来之后**（effect 后连等两帧：一帧只保证在下一个
 * 绘制帧之前执行，两帧才落到底下那层内容已经可见）。之后加 `is-leaving` 淡出，
 * `transitionend`（或兜底计时器）把它从 DOM 里摘掉。
 *
 * ⚠️ 不要在这里加「最少显示 N 毫秒」：原生启动屏已经把这段时间占掉了，再人为拖
 * 只会让冷启动更慢。想让它多停一会儿，改原生那边，不在这里 sleep。
 */
import { useEffect } from 'react'

/** 淡出时长：与 `index.html` 里 `#boot-splash` 的 transition 一致 */
const FADE_MS = 220
/** `transitionend` 没来（reduced-motion / 元素被隐藏）时的兜底 */
const REMOVE_AFTER_MS = FADE_MS + 160

export function useBootSplash(): void {
  useEffect(() => {
    const splash = document.getElementById('boot-splash')
    if (!splash) return

    let outer = 0
    let inner = 0
    let timer = 0
    let done = false

    const remove = (): void => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      splash.remove()
    }

    outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => {
        splash.classList.add('is-leaving')
        splash.addEventListener('transitionend', remove, { once: true })
        timer = window.setTimeout(remove, REMOVE_AFTER_MS)
      })
    })

    return () => {
      window.cancelAnimationFrame(outer)
      window.cancelAnimationFrame(inner)
      window.clearTimeout(timer)
      splash.removeEventListener('transitionend', remove)
    }
  }, [])
}
