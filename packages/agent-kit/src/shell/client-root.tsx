/**
 * 客户端根：`App` 外面再包一层「宿主副作用」的壳。
 *
 * Next 版里它承担两件事：用 `dynamic(ssr:false)` 把整棵树挡在服务端渲染之外、
 * 注册 Service Worker。SPA 化之后第一件事**天然消失**（没有 SSR 了），
 * 只剩 SW 注册；SW 只在 web 宿主 + 生产构建下有意义（desktop 是 `file://`，
 * 注册必然失败），所以按 `platform` 分流。
 */
import { useEffect } from 'react'
import { App } from './App'
import { getAgentHost } from '@fizz/agent-client/host'

/**
 * 注册 Service Worker。
 *
 * 脚本是 `apps/web/public/sw.js`（**不参与打包**、由 vite 原样拷进产物；缓存策略与边界
 * 都写在那个文件头）。它保证的是「**弱网 / 服务端短暂不可达时外壳还能打开**」，不是
 * 「离线可用」—— 这个应用的后端在服务端，离线时业务必然不可用。
 * 「装到手机主屏」还差 manifest + 图标（尚未做），SW 只是地基。
 *
 * ⚠️ **只在生产构建注册**：dev 下 SW 会把改过的前端资源缓存住，导致「代码明明改了页面
 * 还是旧的」这类极难排查的问题。开发时宁可没有缓存。
 */
function useServiceWorker(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const register = (): void => {
      void navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
        // 注册失败（如非 https 环境）不该影响使用，静默即可
        console.warn('[sw] 注册失败：', err)
      })
    }
    // 等 load 完再注册：否则会和首屏资源抢带宽，反而拖慢打开速度
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }, [enabled])
}

export function ClientRoot() {
  const host = getAgentHost()
  useServiceWorker(host.platform === 'web' && import.meta.env.PROD)
  return <App />
}
