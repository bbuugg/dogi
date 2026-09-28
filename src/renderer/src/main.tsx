import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { SettingsWindow } from './features/settings/SettingsWindow'
import { AntdProvider } from './shared/components/AntdProvider'
import { useAppStore } from './stores/app-store'
import { applyColorTheme, initThemeSync } from './shared/lib/theme'
import './index.css'

// 尽早应用主题（主进程 nativeTheme 已就位，这里同步纠正 html class）
initThemeSync()

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')

/**
 * 一个渲染端服务两种窗口（主进程用查询参数区分，见 main/index.ts 的 openSettingsWindow）：
 * - 默认：主界面（自绘标题栏 + 完整工作台）；
 * - `?window=settings`：独立设置窗口（自绘标题栏「设置 + 关闭」+ 设置面板，整窗铺满）。
 */
const windowKind = new URLSearchParams(location.search).get('window')

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    {windowKind === 'settings' ? (
      <AntdProvider>
        <SettingsWindow />
      </AntdProvider>
    ) : (
      <App />
    )}
  </React.StrictMode>
)

void useAppStore.getState().bootstrap()

// 让所有渲染端窗口在偏好变化时同步（在设置窗口改了，主窗口也立即生效）。
// 主进程 prefs:save 会广播 prefs:updated，这里只做一次性订阅：更新本窗口的状态与配色。
let prefsSynced = false
if (!prefsSynced) {
  prefsSynced = true
  window.api.prefs.onUpdated((prefs) => {
    useAppStore.setState({ preferences: prefs })
    // 重新把强调色写到本窗口的 html（data-color-theme 属性），antd token 才能跟着刷新
    applyColorTheme(prefs.colorTheme, prefs.customColor)
  })
}
