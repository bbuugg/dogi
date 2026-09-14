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
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 960,
    minHeight: 600,
    show: false,
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

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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
