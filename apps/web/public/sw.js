/**
 * Fizz 的 Service Worker（只在 **web 宿主 + 生产构建**下注册，见
 * `packages/agent-kit/src/shell/client-root.tsx`）。
 *
 * ⚠️ 这个文件**不参与打包**：它放在 `apps/web/public/` 里，由 vite 原样拷到产物根。
 * 所以 ① 不能写 `import`（没有按 module worker 注册）；② 语法要能跑在最旧的受支持浏览器上。
 *
 * 它要解决的三件事：
 * 1. **让注册成功** —— 此前 `/sw.js` 压根不存在（Next→SPA 迁移时文件被落下、注册调用留了下来），
 *    服务端的 SPA 回退把 index.html 发了回来，于是每个生产会话都打一条
 *    `unsupported MIME type ('text/html')`；
 * 2. **弱网 / 服务端短暂不可达时，应用外壳还能打开**（而不是白屏）；
 * 3. 给将来「装到主屏」把地基打好 —— 那还需要 manifest + 图标，是另一件事。
 *
 * **不是**为了「离线可用」：这个应用的后端在服务端，离线时业务必然不可用。所以这里只缓存
 * 静态外壳，**数据通道一概不碰**。
 *
 * 缓存策略（刻意保守，**绝不让用户卡在旧版本上**）：
 * - 导航请求（HTML）：**网络优先**；网络失败才回退到缓存里那份 index.html，并且每次成功
 *   拿到的 index.html 都会顺手更新进缓存；
 * - `/assets/**`：**缓存优先**。这些文件名里带内容哈希（`index-DwaUuya3.js`），内容永不变化，
 *   命中缓存最省流量、也最安全；
 * - **其它一切不拦**（不调 `respondWith`，直接交给网络）：`/api/**`（含 SSE、上传）、终端与
 *   SSH 的 WebSocket、`fizz-ws://`、`/monaco-editor/**`、跨域、非 GET —— 一律不经 SW。
 *
 * ⚠️ 刻意**不用** `skipWaiting()`：硬顶会让正在跑的页面拿到与预期不匹配的资源（本应用是长驻的
 * 交互式界面，不是营销页）。新版 SW 等所有标签页关掉后再接管；`clients.claim()` 只用于
 * 「首次安装后立刻接管当前页面」。
 *
 * 改策略时把 `VERSION` 加一（activate 会删掉所有旧版本缓存）。服务端对 `/sw.js` 明确发了
 * `Cache-Control: no-cache`（见 `apps/server/src/app.ts`），所以改完下次导航就能生效。
 */
const VERSION = 'v1'
const CACHE = `fizz-shell-${VERSION}`
/** 离线兜底用的外壳：导航网络失败时回它（导航 URL 千变万化，外壳永远是同一份 index.html） */
const SHELL = '/index.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      /**
       * 先预装一份外壳，这样「第一次遇到离线」也有东西可开。
       * 拿不到就**不预装**（下次导航成功时会补上）—— 安装本身不该因为一次网络抖动而失败。
       */
      .then((cache) => cache.add(SHELL).catch(() => undefined))
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.lastIndexOf('fizz-shell-', 0) === 0 && key !== CACHE)
          .map((key) => caches.delete(key))
      )
      // 首次安装后立即接管当前页面（此后新版要等标签页全关掉才接管，见文件头）
      await self.clients.claim()
    })()
  )
})

/** 带内容哈希的构建产物：文件名即版本，命中就用，不必再问网络 */
function isHashedAsset(url) {
  return url.pathname.indexOf('/assets/') === 0
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // 只管同源的静态资源：API / WS / 自定义协议 / 跨域都不归它管
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request)
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE)
            // 用固定的 SHELL 键存：外壳是同一份 index.html，不按导航 URL 各存一份
            await cache.put(SHELL, fresh.clone())
          }
          return fresh
        } catch (err) {
          const cached = (await caches.match(SHELL)) || (await caches.match(request))
          if (cached) return cached
          throw err
        }
      })()
    )
    return
  }

  if (isHashedAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request)
        if (cached) return cached
        const response = await fetch(request)
        if (response && response.ok) {
          const cache = await caches.open(CACHE)
          await cache.put(request, response.clone())
        }
        return response
      })()
    )
  }
  // 其余：不拦，走网络
})
