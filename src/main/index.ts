import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeTheme, Tray } from 'electron'
import { registerIpc, openExternalSafe } from './ipc/index'
import { requestRendererFlush } from './ipc/system'
import { browserSessions } from './services/browser/session'
import { pluginHost } from './services/plugins/host'
import { storage } from './services/storage'
import { hostLogger } from './services/log/logger'
import { acpAgentService } from './services/ai/acp-agent'
import {
  registerWorkspaceMediaScheme,
  serveWorkspaceMedia
} from './services/ai/workspace-media'
import { resolveIconPath } from './services/system/icon'

// 工作区文件预览用的自定义协议必须在 app ready 之前登记（见 services/ai/workspace-media.ts）
registerWorkspaceMediaScheme()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 真正退出程序的标志位：仅当用户从托盘「退出」触发，关闭窗口时置位 */
let isQuiting = false

/**
 * 单实例锁：已有一个 Dogi 在运行时，再次启动的进程直接退出，
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
          // 默认角色：对当前聚焦的 webContents 切换 DevTools（之前为了 webview 强开主窗口，
          // 现已无 webview，恢复正常行为——聚焦哪层就开哪层的 DevTools）。
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ])
  )
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
  tray.setToolTip('Dogi')
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
    height: bounds?.height ?? 720,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 1024,
    minHeight: 640,
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
      // 关掉后台节流：应用最小化到托盘 / 被遮挡时，Chromium 默认会把渲染端定时器
      // 先压到 1 次/秒、约 5 分钟后进入 intensive throttling（1 次/分钟）并停掉 rAF ——
      // 终端输出、AI 流式渲染等全部停摆，表现就是「放后台过一会儿任务卡住」。
      // 这是常驻运维工作台，后台继续干活是核心场景（功耗换功能，值得）。
      backgroundThrottling: false
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
  // safeStorage 在 app ready 前不可用（构造期的迁移会被静默跳过），ready 后幂等补跑一次
  storage.migrateSshPrivateKeyAtRest()
  installMenu()
  // 文件预览协议要早于窗口创建（页面一加载就可能请求图片/视频）
  serveWorkspaceMedia()
  // 主机日志：早于 IPC 注册初始化，隧道自启（注册期同步触发）等早期事件的日志同样要落盘
  await hostLogger.init()
  registerIpc(() => mainWindow)
  createWindow()
  // 插件需在 IPC 注册后加载，使插件主进程 handler 可被路由
  await pluginHost.init()
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
  acpAgentService.dispose()
})

/**
 * 退出前关掉自动化用的浏览器。
 *
 * 那些是 Playwright 启动的 headless 子进程，不关就会变成孤儿进程挂在后台。
 * `close()` 是异步的，所以先拦一次退出、关完再真退；带超时兜底 ——
 * 个别浏览器进程卡死时不能把整个应用拖得退不掉。
 */
let browsersClosed = false
app.on('before-quit', (event) => {
  if (browsersClosed) return
  event.preventDefault()
  void Promise.race([
    // 先让渲染端把进行中的会话落盘（Agent 长任务中途退出不丢最后几秒的产出），
    // 再关浏览器子进程；两步各自都有超时，不会把退出拖住
    requestRendererFlush(mainWindow).then(() => browserSessions.closeAll()),
    new Promise((resolve) => setTimeout(resolve, 2500))
  ]).finally(() => {
    browsersClosed = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
