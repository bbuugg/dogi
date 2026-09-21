import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Tray } from 'electron'
import { registerIpc, openExternalSafe } from './ipc/index'
import { pluginHost } from './services/plugins/host'
import { storage } from './services/storage'
import { acpAgentService } from './services/ai/acp-agent'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 真正退出程序的标志位：仅当用户从托盘「退出」触发，关闭窗口时置位 */
let isQuiting = false

/** 启动画面：主窗口首帧准备好之前先亮它，用户看不到主窗口「先默认配色、再变设置配色」的闪烁 */
let splashWindow: BrowserWindow | null = null
/** 渲染端是否已报首屏就绪（数据加载完 + 主题已应用） */
let rendererReady = false
/** 主窗口是否已可安全显示（ready-to-show 已触发，首帧已产出） */
let windowReadyToShow = false
let mainWindowRevealed = false

/** 启动画面的最短呈现时长：太短会一闪而过，反而比直接切过去更晃眼 */
const SPLASH_MIN_MS = 450
/** 兜底：渲染端迟迟不报就绪（加载报错等）也要放出主窗口，不能永远卡在启动画面 */
const SPLASH_TIMEOUT_MS = 8000

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
          // 不用 { role: 'toggleDevTools' }：该角色操作的是当前聚焦的 webContents，
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

/**
 * 启动画面的 logo：把项目图标读进来转成 data URL 内联。
 * 图标缺失 / 解码失败时返回 null，调用方退回纯色块 logo（不至于开天窗）。
 */
function splashLogoDataUrl(): string | null {
  try {
    const image = nativeImage.createFromPath(resolveIconPath())
    return image.isEmpty() ? null : image.toDataURL()
  } catch {
    return null
  }
}

/**
 * 启动画面的 HTML。
 *
 * 用 data URL 而不是单独文件 / 多入口构建：内容极小（图标 + 标题 + 进度条动画），
 * 不引任何脚本，内联最省事（CSP 也允许 data URL 的 img/font）。
 */
function splashHtml(isDark: boolean, logo: string | null): string {
  const bg = isDark ? '#0f1117' : '#ffffff'
  const fg = isDark ? '#e8eaf0' : '#1b1d23'
  const muted = isDark ? '#7c8296' : '#8b90a0'
  const track = isDark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.07)'
  const accent = '#4f7cff'
  // 图标本身是圆形深色底，直接铺 64px 即可；取不到图时退回一个渐变圆角方块
  const logoBlock = logo
    ? `<img class="logo" src="${logo}" alt="">`
    : `<div class="logo-fallback">O</div>`
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
    background:${bg};color:${fg};user-select:none;
    font:500 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
  .logo{width:64px;height:64px;object-fit:contain}
  .logo-fallback{width:52px;height:52px;border-radius:14px;display:flex;align-items:center;
    justify-content:center;background:linear-gradient(135deg,${accent},#8b5cf6);color:#fff;
    font-size:24px;font-weight:700;box-shadow:0 8px 24px rgba(79,124,255,.35)}
  .title{font-size:15px;font-weight:600;letter-spacing:.3px}
  .sub{font-size:11px;color:${muted};margin-top:-8px}
  .track{width:168px;height:3px;border-radius:2px;background:${track};overflow:hidden;margin-top:6px}
  .bar{width:40%;height:100%;border-radius:2px;background:${accent};
    animation:slide 1.1s ease-in-out infinite}
  @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
</style></head>
<body>
  ${logoBlock}
  <div class="title">OpsDesk</div>
  <div class="sub">AI 运维终端</div>
  <div class="track"><div class="bar"></div></div>
</body></html>`
}

function createSplashWindow(): void {
  const isDark = nativeTheme.shouldUseDarkColors
  splashWindow = new BrowserWindow({
    width: 360,
    height: 240,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: true,
    center: true,
    // 与主窗口同底色，且创建前 themeSource 已就位，启动画面自身也不会闪
    backgroundColor: isDark ? '#0f1117' : '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false }
  })
  // 整段 HTML 用 base64 传输：页面里嵌着图标的 data URL（含 + / = 等字符），
  // 直接拼进 data:text/html 得逐个转义，base64 一次编码更省事也更稳
  const html = splashHtml(isDark, splashLogoDataUrl())
  splashWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    // 启动画面加载失败会显示成空白小窗，留下日志便于排查
    console.error('[splash] 启动画面加载失败：', code, desc)
  })
  void splashWindow.loadURL(
    `data:text/html;base64,${Buffer.from(html, 'utf-8').toString('base64')}`
  )
  splashWindow.on('closed', () => {
    splashWindow = null
  })
  console.log('[splash] 启动画面已显示')
}

/** 渲染端报告首屏就绪（IPC `app:ready`） */
function markRendererReady(): void {
  if (rendererReady) return
  rendererReady = true
  // 再压一小段：让启动画面有完整的呈现，而不是刚出现就被主窗口顶掉
  setTimeout(revealMainWindow, SPLASH_MIN_MS)
}

/**
 * 撤下启动画面并显示主窗口。
 *
 * 两个条件缺一不可：
 * - 渲染端已就绪 —— 否则会露出主窗口「先按默认配色渲染、再变成设置配色」的那一帧；
 * - ready-to-show 已触发 —— 否则 show 出来的是一张空窗。
 * 主窗口先显示、启动画面后销毁，避免出现「两个窗口都没了」的瞬间。
 */
function revealMainWindow(): void {
  if (mainWindowRevealed || !rendererReady || !windowReadyToShow) return
  mainWindowRevealed = true

  const window = mainWindow
  if (window && !window.isDestroyed()) {
    window.show()
    // ⚠️ 复位 zoom 必须在 show 之后：隐藏窗口下调 setZoomFactor 会让首帧永不产出
    window.webContents.setZoomFactor(1)
  }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
  console.log('[splash] 主窗口已显示，撤下启动画面')
}

function createWindow(): void {
  // （重新）建窗口时这几个标志都要复位：新窗口得自己走一遍「首帧 + 渲染端就绪」
  rendererReady = false
  windowReadyToShow = false
  mainWindowRevealed = false
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
    // 这里不直接 show：交给 revealMainWindow 等渲染端「主题已应用」的报告，
    // 否则用户会看到主窗口先按默认配色渲染一帧、再跳成设置里的配色
    windowReadyToShow = true
    revealMainWindow()
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
  registerIpc(() => mainWindow, markRendererReady)
  // 先亮启动画面，主窗口在后台加载（show: false），等渲染端报就绪后再一并揭示
  createSplashWindow()
  createWindow()
  // 兜底：渲染端迟迟不报就绪时也要放出主窗口，不能永远停在启动画面
  setTimeout(() => {
    rendererReady = true
    windowReadyToShow = true
    revealMainWindow()
  }, SPLASH_TIMEOUT_MS)
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
