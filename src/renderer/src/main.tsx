import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useAppStore } from './stores/app-store'
import { initThemeSync } from './lib/theme'
import './index.css'

// 尽早应用主题（主进程 nativeTheme 已就位，这里同步纠正 html class）
initThemeSync()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

void useAppStore.getState().bootstrap()
