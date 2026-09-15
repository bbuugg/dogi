import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import { registerIpc } from './ipc'
import { registerShortcuts } from './shortcuts'
import { storage } from './services/storage'

let mainWindow: BrowserWindow | null = null

/**
 * 自定义菜单：保留编辑 / 重载 / DevTools / 全屏，但**去掉 zoom 角色**。
 * 默认菜单的 Ctrl+加/减/0 会缩放整个页面，并抢在渲染端之前触发；
 * 去掉后才能把这些组合键交给终端自己处理（Ctrl+滚轮 / Ctrl +/- 缩放终端字号）。
 */
function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ])
  )
}

function createWindow(): void {
  const bounds = storage.getWindowBounds()
  const isMac = process.platform === 'darwin'
  // 窗口/任务栏图标：开发时取项目 resources 目录；打包后由 extraResources 带入安装目录 resources
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'app-icon.png')
    : join(import.meta.dirname, '../../resources/app-icon.png')
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
    icon: iconPath,
    // 自定义标题栏：隐藏系统标题栏但保留窗口阴影/圆角/动画；
    // macOS 用 hiddenInset 保留交通灯，并让交通灯与自定义标题栏（h-9）垂直对齐
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    // 创建窗口前 themeSource 已就位，按解析后的主题设置底色避免闪白
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1117' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  // 最大化状态变化广播给渲染端，用于切换最大化/还原图标
  const sendMaximized = (v: boolean): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', v)
    }
  }
  mainWindow.on('maximize', () => sendMaximized(true))
  mainWindow.on('unmaximize', () => sendMaximized(false))

  // 终端缩放改用字号（见 TerminalView）；整页缩放强制复位到 100%。
  // Chromium 会按 origin 记住 zoom level，并在导航完成后重新应用，
  // 因此除创建时设置外，还要在页面加载完成后复位一次，避免历史缩放残留。
  // ⚠️ 不能在 did-finish-load（窗口尚未显示、show:false）时调 setZoomFactor：
  //    file:// 页面 + 隐藏窗口下，zoom 变更触发的重布局会让首帧永远不产出，
  //    ready-to-show 不触发 → 窗口永不显示（进程在、无页面）。dev 正常是因为
  //    loadURL(http) 下渲染端有 HMR 等后续活动会补触发首帧。
  //    故复位挪到 ready-to-show（此时首帧已产出）以及窗口可见时的 did-finish-load（reload 场景）。
  mainWindow.webContents.setZoomFactor(1)
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomFactor(1)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.webContents.setZoomFactor(1)
    }
  })

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

function saveBounds(): void {
  if (mainWindow && !mainWindow.isMinimized() && !mainWindow.isDestroyed()) {
    storage.setWindowBounds(mainWindow.getBounds())
  }
}

app.whenReady().then(() => {
  // 在创建窗口前应用主题偏好，renderer 的 prefers-color-scheme 随之生效
  nativeTheme.themeSource = storage.getPreferences().theme
  installMenu()
  registerIpc(() => mainWindow)
  createWindow()
  registerShortcuts(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
