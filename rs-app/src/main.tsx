import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { bindAppListeners, useAppStore } from './stores/app-store'
import { initThemeSync } from './lib/theme'
import { installApi } from './tauri/api'
import './index.css'

// 替代 Electron preload 的 contextBridge：先注入 window.api，再渲染与拉数据
installApi()
// 事件监听必须在 installApi 之后绑定（import 提升会让 store 模块早于此处求值）
bindAppListeners()

// 屏蔽 WebView2 内置的默认右键菜单（Reload / Inspect / 返回等），避免在留白区误弹。
// 捕获阶段 preventDefault 只取消默认菜单，不影响应用自身的右键菜单：
// antd Dropdown(trigger=contextMenu) 走 React 合成事件、终端右键粘贴走自有 contextmenu 处理，
// 它们仍会照常触发。
window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true })

// 尽早应用主题（主进程已设置窗口主题，这里同步纠正 html class）
initThemeSync()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

void useAppStore.getState().bootstrap()
