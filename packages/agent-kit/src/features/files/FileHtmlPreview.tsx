/**
 * HTML 文件预览：**沙箱 iframe + `srcdoc`**，两端行为一致。
 *
 * 为什么是这个形态（而不是把源码注进父页面 DOM / 走自定义协议）：
 * - **注入 DOM 等于 XSS**：HTML 里可以带 `<script>`，直接 render 到宿主页面上它能碰
 *   localStorage、cookie、token，甚至改 UI;
 * - **自定义协议**（`fizz-ws://` 那套）能解析相对资源，但要在 desktop 里重建
 *   `registerSchemesAsPrivileged` + `protocol.handle` + Range/206 一整条链，web 端还用不上
 *   （跨域），先不做 —— 代价是**页面引的相对资源（./style.css、./app.js、`<img src>`）
 *   解析不到**，确定性丢失的那部分由「编辑源码」补：想看全貌时切过去改绝对路径。
 *
 * `sandbox` **刻意不给 `allow-same-origin`**：脚本照样能跑（`allow-scripts`），但 iframe 落在
 * opaque origin 上，摸不到父页的存储与 DOM，也发不了同源请求。`allow-popups` /
 * `allow-forms` 让「点链接开新窗 / 提交表单」这类正常交互不被沙箱拦死。
 *
 * 另外：沙箱 iframe 的主题**不跟随**宿主（它是一份独立文档，`class="dark"` 到不了里面），
 * 所以底色固定给白 —— 网页里的 `<body>` 大多也没写背景色。
 *
 * ## 滚动条：把宿主那套「美化条」注入进去
 *
 * iframe 是**独立文档**，宿主 `styles.css` 里的 `::-webkit-scrollbar` 到不了里面（也没有
 * `allow-same-origin`，父页读 `contentDocument` 会被拦）。不注入的话预览里就是一条原生
 * 系统滚动条 —— 白底配一条宽灰轨，跟面板其余部分不像同一套界面。
 *
 * 所以把同一套规则以 `<style>` 拼进 `srcdoc`（见 `PREVIEW_SCROLLBAR_CSS`）。两个与宿主的差异：
 * - **判据只用 `pointer`，不用宽度**：iframe 的视口 = 侧栏宽度（300~600px），照搬宿主的
 *   `(min-width: 768px)` 会让桌面端永远命中不到、等于没生效；
 * - **颜色不能用 `--muted-foreground`**：预览文档里没有我们的令牌，改用系统色 `CanvasText`
 *   混一点透明（页面写了 `color-scheme: dark` 时它自己会变白）。
 */
import { useMemo } from 'react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/**
 * 注入预览文档的滚动条样式：数值 / 观感与 `styles.css` 的全局那一套对齐
 * （10px 轨道、4px 视觉粗细、圆角、透明轨道）。
 *
 * ⚠️ **不要给同一个元素同时写标准属性与 `::-webkit-scrollbar`**：Chromium 121+ 看到
 * `scrollbar-width` / `scrollbar-color` 就完全不画伪元素那套（圆角、hover 全失效）。
 * 标准属性只给不认伪元素的引擎（Firefox），用 `@supports` 隔开。
 */
const PREVIEW_SCROLLBAR_CSS = `
@media (pointer: fine) {
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background-color: rgb(120 120 120 / 0.45);
    background-color: color-mix(in oklab, CanvasText 28%, transparent);
    border-radius: 9999px;
    border: 3px solid transparent;
    background-clip: content-box;
  }
  ::-webkit-scrollbar-thumb:hover {
    background-color: rgb(120 120 120 / 0.7);
    background-color: color-mix(in oklab, CanvasText 45%, transparent);
  }
  ::-webkit-scrollbar-corner { background: transparent; }
}
/* 触摸设备：占位式滚动条会永久吃掉 10px，藏掉（与宿主一致，滚动本身不受影响） */
@media (pointer: coarse) {
  ::-webkit-scrollbar { display: none; }
}
@supports not selector(::-webkit-scrollbar) {
  html { scrollbar-width: thin; scrollbar-color: rgb(120 120 120 / 0.45) transparent; }
}
`

/**
 * 把样式塞进预览文档。
 *
 * 优先插在 `</head>` 前（排在页面自己的样式之后，同特异性下压得住它）；没有 `head` 时跟在
 * doctype 后面。**绝不能把 `<style>` 放到 `<!DOCTYPE>` 之前** —— 那会把文档打成 quirks 模式，
 * 预览里的排版跟真实浏览器打开的不一样。
 */
function withScrollbarStyles(html: string): string {
  const style = `<style data-fizz-preview-scrollbar>${PREVIEW_SCROLLBAR_CSS}</style>`
  const headClose = /<\/head\s*>/i
  if (headClose.test(html)) return html.replace(headClose, (match) => `${style}${match}`)
  const doctype = /<!doctype[^>]*>/i
  if (doctype.test(html)) return html.replace(doctype, (match) => `${match}${style}`)
  return `${style}${html}`
}

export function FileHtmlPreview({ html, className }: { html: string; className?: string }) {
  // 预览正文可能有几百 KB：只在源码变化时拼一次，别让无关重渲染反复拷贝整串
  const srcDoc = useMemo(() => withScrollbarStyles(html), [html])
  return (
    <iframe
      title="HTML 预览"
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-popups allow-forms"
      className={cn('h-full w-full border-0 bg-background', className)}
    />
  )
}
