/**
 * 应用内自动更新（`electron-updater` 封装）。
 *
 * ## 产品约定（用户明确要求）
 *
 * - **静默检查**：启动后后台查一次，不弹窗、不打断当前工作；
 * - **不自动下载**：发现新版先提示（红徽章），由用户主动点击才开始后台下载，且可随时取消；
 *   下完再问用户要不要装（`autoDownload = false`）。
 * - **不碰预发布版**：`allowPrerelease = false`，正式通道之外的一律不推送。
 *
 * ## 为什么单独一层而不是散在 IPC 里
 *
 * `autoUpdater` 是**全局单例**，事件订阅只能有一份（重复 `on` 会让同一次更新广播多次、
 * 内存也涨）。所以这里做成本模块的单例：状态机 + 广播出口都在这里，
 * `ipc/updater.ts` 只做「渲染端能问什么 / 能让它做什么」的转发。
 *
 * ## 三条硬约束（改之前先读）
 *
 * 1. **必须 `app.isPackaged` 守卫**：开发态（`electron .`）没有 `app-update.yml`，
 *    调 `checkForUpdates()` 只会抛「Skip checkForUpdates because application is not packed」。
 *    非打包态一律报 `unsupported`，界面据此把按钮置灰。
 * 2. **失败只记日志、不抛给用户**：检查更新失败（断网 / GitHub 限流 / 未发布新版本）
 *    是常态，不是错误 —— 它绝不能影响主流程，更不能弹红条。
 * 3. **安装前必须先冲刷渲染端**：直接 `quitAndInstall()` 会让进行中的会话丢最后几秒
 *    产出（与 `main/index.ts` 的 `before-quit` 同一套纪律），所以走
 *    `requestRendererFlush` 再装。
 */
import { app } from 'electron'
import type { AppUpdateState, AppUpdateStatus } from '@shared/types'
import { hostLogger } from './log/logger'

/**
 * `electron-updater` 是 CJS 包，而本项目主进程产物是 **ESM**（package.json `type: module`）。
 * ESM 里对 CJS 的具名导入依赖 cjs-module-lexer 的静态分析，**不保证**解析得出
 * `exports.autoUpdater` —— 所以一律走 default import 再解构（见 tsconfig 的 esModuleInterop）。
 *
 * `CancellationToken` **必须**取自本包的转出（`main.js` 里的
 * `__exportStar(require("./types"), exports)`），**绝不能**写成
 * `import { CancellationToken } from 'builder-util-runtime'`：
 * 那个包不是本项目的直接依赖，npm 只把它作为 electron-updater 的依赖**嵌套**装在
 * `node_modules/electron-updater/node_modules/` 下；而主进程产物里是裸导入，
 * 只会在 `out/main` 往上逐级的 `node_modules` 里找，**看不见嵌套副本** ——
 * 打包后启动即报 `Cannot find package 'builder-util-runtime'`
 * （dev 能跑，只因顶层恰好有个 devDependency 侧的旧副本）。走本包转出则永远跟随它自己的解析。
 */
import updaterPkg from 'electron-updater'

const { autoUpdater, CancellationToken } = updaterPkg

/** 启动后多久开始静默检查（ms）：别和窗口首屏抢网 */
const SILENT_CHECK_DELAY = 8000

/** 当前状态（单例持有，IPC 只读它 / 改它） */
let state: AppUpdateState = 'idle'
/** 最近一次发现的新版本号（downloaded / available 时有值） */
let latestVersion: string | null = null
/**
 * 进行中下载的取消令牌；为 null 表示当前没在下载（据此判断是否可取消）。
 * 类型直接取 `downloadUpdate` 的入参类型：`CancellationToken` 是带私有成员的 class，
 * 只要声明来源与 electron-updater 不是同一份，TS 就会判定两者不兼容。
 */
type DownloadToken = NonNullable<Parameters<typeof autoUpdater.downloadUpdate>[0]>
let downloadToken: DownloadToken | null = null
/** 上报出口（`registerUpdaterIpc` 注入 broadcaster） */
let broadcast: ((status: AppUpdateStatus) => void) | null = null

/** 是否可用：只有打包态才有 `app-update.yml` */
export function updaterSupported(): boolean {
  return app.isPackaged
}

/** 当前状态快照（给 `updater:status` 用） */
export function updaterStatus(): AppUpdateStatus {
  return {
    state,
    current: app.getVersion(),
    latest: latestVersion,
    supported: updaterSupported()
  }
}

function setState(next: AppUpdateState, latest: string | null = latestVersion): void {
  state = next
  latestVersion = latest
  broadcast?.(updaterStatus())
}

/**
 * 绑定事件并注入广播出口。**只能调一次**（`ipc/index.ts` 里注册）。
 */
export function initUpdater(report: (status: AppUpdateStatus) => void): void {
  broadcast = report

  // 开发态不挂事件：免得 dev 里手动调 checkForUpdates 抛一堆看不懂的栈
  if (!updaterSupported()) return

  // 不自动下载：发现即提示，由用户点击后再后台下（且可取消）；装仍要用户点头
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // 不推预发布版（产品约定）
  autoUpdater.allowPrerelease = false
  // 也不降级：本地版本比远端新（自己 dev 装了高版本）时不要把用户拽回去
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => {
    hostLogger.info('app', '正在检查更新…')
    setState('checking')
  })

  autoUpdater.on('update-available', (info) => {
    hostLogger.info('app', `发现新版本 ${info.version}，等待用户点击后下载`)
    setState('available', info.version)
  })

  // 用户取消下载：回到「有新版本待下载」，红徽章继续提示，可再次点击下载
  autoUpdater.on('update-cancelled', (info) => {
    hostLogger.info('app', `已取消下载 ${info?.version ?? ''}`)
    downloadToken = null
    setState('available', latestVersion)
  })

  autoUpdater.on('update-not-available', () => {
    hostLogger.info('app', '已是最新版本')
    setState('up-to-date')
  })

  autoUpdater.on('download-progress', (progress) => {
    // 进度变化很密，只更新状态不落盘日志（否则 host.log 被刷爆）
    setState('downloading')
    if (progress.percent >= 100) hostLogger.info('app', '新版本下载完成')
  })

  autoUpdater.on('update-downloaded', (info) => {
    hostLogger.info('app', `新版本 ${info.version} 已就绪，重启即可安装`)
    setState('downloaded', info.version)
  })

  autoUpdater.on('error', (err) => {
    // 检查更新失败是常态（断网 / 限流 / 没发布过）——只记日志，绝不弹窗
    const message = err instanceof Error ? err.message : String(err)
    hostLogger.warn('app', '检查更新失败', message)
    setState('idle')
  })
}

/**
 * 检查更新。**永不抛**：失败已在 `error` 事件里记过日志。
 *
 * @param manual 用户手动点的（会走一遍完整检查）；启动静默检查用同一个入口即可。
 */
export async function checkForUpdates(): Promise<AppUpdateStatus> {
  if (!updaterSupported()) {
    return updaterStatus()
  }
  if (state === 'checking' || state === 'downloading') {
    return updaterStatus()
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    hostLogger.warn('app', '检查更新失败', err instanceof Error ? err.message : String(err))
  }
  return updaterStatus()
}

/**
 * 开始后台下载已发现的新版本。由渲染端（点红徽章 / 设置页版本号）触发：
 * 因为 `autoDownload = false`，发现新版时只进 `available` 态，不下。
 *
 * 用一份 `CancellationToken` 关联这次下载，`cancelDownload()` 调它的 `cancel()`
 * 中止（electron-updater 会据此抛 `CancellationError` 并触发 `update-cancelled`）。
 */
export function startDownload(): AppUpdateStatus {
  if (!updaterSupported()) return updaterStatus()
  // 只从「待下载」起步；下载中 / 已下完 / 检查中都不重入
  if (state !== 'available') return updaterStatus()
  downloadToken = new CancellationToken()
  setState('downloading', latestVersion)
  void autoUpdater.downloadUpdate(downloadToken).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    hostLogger.warn('app', '下载更新失败', message)
    // 取消走 update-cancelled 事件，不会落到这；其余失败才回落到待下载
    if (downloadToken) {
      downloadToken = null
      setState('available', latestVersion)
    }
  })
  return updaterStatus()
}

/** 取消正在进行的下载，回到「有新版本待下载」（红徽章继续提示） */
export function cancelDownload(): AppUpdateStatus {
  if (state !== 'downloading' || !downloadToken) return updaterStatus()
  downloadToken.cancel()
  downloadToken = null
  return updaterStatus()
}

/** 启动后的静默检查：延迟一会儿，别和窗口首屏抢网；失败无声 */
export function scheduleSilentCheck(): void {
  if (!updaterSupported()) return
  const timer = setTimeout(() => {
    void checkForUpdates()
  }, SILENT_CHECK_DELAY)
  // 别拿一个定时器吊住退出（before-quit 会等所有句柄）
  timer.unref?.()
}

/**
 * 退出并安装已下载的更新。
 *
 * `onFlushed` 由调用方（IPC 层）注入：先让渲染端把进行中的状态落盘，
 * 再交给 electron-updater 重启 —— 顺序反了会丢最后一次会话产出。
 */
export function quitAndInstall(onFlushed: () => Promise<void>): void {
  if (!updaterSupported() || state !== 'downloaded') return
  hostLogger.info('app', '准备重启安装更新…')
  void onFlushed().finally(() => {
    // isSilent = false → 装完由 NSIS 直接启动新版本
    autoUpdater.quitAndInstall(false, false)
  })
}