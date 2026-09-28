import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { useAppStore } from './stores/app-store'
import { applyColorTheme, initThemeSync } from './shared/lib/theme'
import './index.css'

// 尽早应用主题（主进程 nativeTheme 已就位，这里同步纠正 html class）
initThemeSync()

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')

// 只有一个窗口：设置也做成主窗口内的 antd Modal（见 features/settings/SettingsModal）
ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

void useAppStore.getState().bootstrap()

// 偏好变化时同步本窗口的 store 与配色：主进程 prefs:save 落盘后会广播 prefs:updated
// （设置弹窗与主界面同进程，这里同时兜住「preferences 被外部改写」的情况）。
let prefsSynced = false
if (!prefsSynced) {
  prefsSynced = true
  window.api.prefs.onUpdated((prefs) => {
    useAppStore.setState({ preferences: prefs })
    // 重新把强调色写到本窗口的 html（data-color-theme 属性），antd token 才能跟着刷新
    applyColorTheme(prefs.colorTheme, prefs.customColor)
  })
}
