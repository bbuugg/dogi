import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { app, BrowserWindow, Menu, nativeTheme, Tray, webContents } from 'electron'
import { registerIpc, openExternalSafe } from './ipc'
import { registerShortcuts } from './shortcuts'
import { pluginHost } from './services/plugins'
import { storage } from './services/storage'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 真正退出程序的标志位：仅当用户从托盘「退出」触发，关闭窗口时置位 */
let isQuiting = false

/**
 * 单实例锁：已有一个 OpsDesk 在运行时，再次启动的进程直接退出，
 * 并通过 second-instance 事件把已有实例的主窗口调到前台。
 * 锁由 Electron 按应用 userData 目录互斥，打包与 dev 各自独立（userData 不同则互不影响）。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    // 未最大化时闪一下任务栏图标以提醒；已最大化则直接聚焦
    mainWindow.flashFrame(!mainWindow.isMaximized())
    mainWindow.show()
    mainWindow.focus()
  })
}

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
          {
            label: 'Reload',
            // 不注册加速键：Ctrl+R 必须透传给终端（vim 的 redo / readline 反向搜索），
            // 避免菜单在窗口层抢先拦截按键。需要刷新时点菜单项（仅 DevTools 打开时生效）
            registerAccelerator: false,
            click: (_item, win) => {
              if (win instanceof BrowserWindow && !win.isDestroyed() && win.webContents.isDevToolsOpened()) {
                win.webContents.reload()
              }
            }
          },
          {
            label: 'Force Reload',
            registerAccelerator: false,
            click: (_item, win) => {
              if (win instanceof BrowserWindow && !win.isDestroyed() && win.webContents.isDevToolsOpened()) {
                win.webContents.reloadIgnoringCache()
              }
            }
          },
          // 不用 { role: 'toggleDevTools' }：该角色默认操作当前焦点所在的 webContents，
          // 当 webview 获得焦点时会打开 webview 的 devtools 而非宿主的。
          // 这里显式操作主窗口的 webContents，确保快捷键始终打开宿主 DevTools。
          {
            label: 'Toggle Developer Tools',
            accelerator: 'CommandOrControl+Shift+I',
            registerAccelerator: true,
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.toggleDevTools()
              }
            }
          },
          // 打开 webview 插件的 DevTools：查找主窗口内所有 webview 的 webContents，
          // 取第一个（当前激活的插件 webview）打开/关闭其 DevTools。
          {
            label: 'Toggle Webview DevTools',
            accelerator: 'CommandOrControl+Shift+Alt+I',
            registerAccelerator: true,
            click: () => {
              if (!mainWindow || mainWindow.isDestroyed()) return
              const all = webContents.getAllWebContents()
              // 排除主窗口自身的 webContents，剩下的就是 webview 的
              for (const wc of all) {
                if (wc === mainWindow.webContents) continue
                const url = wc.getURL?.() ?? ''
                // webview 加载的是 file:// 协议的插件 HTML
                if (url.startsWith('file://')) {
                  wc.toggleDevTools()
                  return
                }
              }
            }
          },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ])
  )
}

/**
 * 解析应用图标路径。打包后由 extraResources 把 app-icon.png 带到安装目录的
 * resources/ 下；兼容 extraResources 旧写法（多嵌套一层 resources/）作为兜底。
 * 返回第一个存在的路径，避免图标缺失导致 new Tray() 抛错、角标建不出来。
 */
function resolveIconPath(): string {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'app-icon.png'),
        join(process.resourcesPath, 'resources', 'app-icon.png')
      ]
    : [join(import.meta.dirname, '../../resources/app-icon.png')]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

/**
 * 显示并聚焦主窗口（从托盘图标恢复时调用）。
 */
function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 创建系统托盘图标与右键菜单。点击图标在「显示/隐藏」间切换；
 * 右键菜单提供「显示主窗口」与「退出」。退出会真正关闭程序。
 */
function createTray(): void {
  const iconPath = resolveIconPath()
  try {
    tray = new Tray(iconPath)
  } catch (e) {
    // 图标缺失/加载失败时记录错误，避免静默失败；最小化后仍能靠窗口隐藏存活，
    // 但无角标可点击恢复（正常打包下 iconPath 必然存在，不会走到这里）
    console.error('[tray] 创建托盘图标失败，图标路径：', iconPath, e)
    tray = null
    return
  }
  tray.setToolTip('OpsDesk')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      // { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide()
    else showMainWindow()
  })
}

function createWindow(): void {
  const bounds = storage.getWindowBounds()
  const isMac = process.platform === 'darwin'
  // 窗口/任务栏图标：开发时取项目 resources 目录；打包后由 extraResources 带入安装目录 resources
  const iconPath = resolveIconPath()
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
      spellcheck: false,
      // 启用 <webview> 标签：webview 模式插件需要
      webviewTag: true
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

  // 外部链接交给系统浏览器（仅放行常见协议，避免未知协议触发系统弹窗）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })

  // 禁止 F5 刷新页面（会毁掉终端会话）。Ctrl+R / Ctrl+Shift+R **不拦截**：
  // 它们要透传给终端——shell 的反向搜索、vim 的 redo（撤销 u 的恢复）都依赖 ^R；
  // 页面本身没有内置刷新快捷键，菜单 Reload 加速键已禁用，不会误触重载。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (mainWindow?.webContents.isDevToolsOpened()) return
    if (input.key === 'F5') event.preventDefault()
  })

  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)
  // 关闭时：未真正退出且开启了「最小化到托盘」则隐藏而非销毁，
  // 程序继续在托盘运行；从托盘「退出」会置 isQuiting 让窗口真正关闭。
  mainWindow.on('close', (e) => {
    if (!isQuiting && storage.getPreferences().minimizeToTray) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
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

app.whenReady().then(async () => {
  // 在创建窗口前应用主题偏好，renderer 的 prefers-color-scheme 随之生效
  nativeTheme.themeSource = storage.getPreferences().theme
  installMenu()
  registerIpc(() => mainWindow)
  createWindow()
  // 插件需在 IPC 注册后加载，使插件主进程 handler 可被路由
  await pluginHost.init()
  registerShortcuts(() => mainWindow, () => storage.getShortcuts())
  createTray()

  app.on('activate', () => {
    // 窗口已存在（仅隐藏到托盘）时恢复显示；否则重新创建
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })
})

// 真正退出前置位标志，确保关闭事件不再被拦截（否则会再次最小化到托盘）
app.on('before-quit', () => {
  isQuiting = true
})

// 退出时销毁托盘图标，避免残留在系统托盘区
app.on('will-quit', () => {
  tray?.destroy()
  tray = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
