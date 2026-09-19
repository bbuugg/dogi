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

// 尽早应用主题（主进程已设置窗口主题，这里同步纠正 html class）
initThemeSync()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

void useAppStore.getState().bootstrap()
