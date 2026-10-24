import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

/*
 * `BrowserRouter` 用 history 路由：Vite dev server 默认就是 SPA 回落（任何路径都吐
 * `index.html`），所以 `/about` 直接刷新也没问题 —— 容器里经平台域名访问同理。
 *
 * ⚠️ `react-router` 与 `react-router-dom` 在 package.json 里**锁的是同一个精确版本**：
 * `react-router-dom@7` 把 `react-router` 写成精确依赖，两边版本一错开（比如 `^` 飘到 8.x）
 * 就会装出**两份 router**，效果是「导航能跳、但 context 读不到」这类很难查的怪毛病。
 */
const container = document.getElementById('root')
if (!container) throw new Error('#root 不存在：检查 index.html')

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
