/**
 * 应用内自动更新（`electron-updater` 封装）。
 *
 * ## 产品约定
 *
 * - **静默检查**：启动后延迟一会儿在后台查一次（之后每 6 小时再查一次），
 *   不弹窗、不打断当前工作；
 * - **绝不自动下载**：发现新版本只把状态推给界面（`available`），下载必须由用户点；
 *   下载中可以取消，下完也要用户点头才装（`autoDownload = false`）。
 * - **不碰预发布版**：`allowPrerelease = false`，正式通道之外的一律不推送。
 *
 * ## 为什么单独一层而不是散在 IPC 里
 *
 * `autoUpdater` 是**全局单例**，事件订阅只能有一份（重复 `on` 会让同一次更新广播多次、
 * 内存也涨）。所以这里做成本模块的单例：状态机 + 广播出口都在这里，
 * `index.ts` 的 `registerWindowIpc` 只做「渲染端能问什么 / 能让它做什么」的转发。
 *
 * ## 三条纪律
 *
 * 1. **必须 `app.isPackaged` 守卫**：开发态（`electron .`）没有 `app-update.yml`，
 *    调 `checkForUpdates()` 只会抛「Skip checkForUpdates because application is not packed」。
 *    非打包态一律报 `supported: false`，界面据此把入口藏起来。
 * 2. **静默检查失败只记日志、不抛给用户**：断网 / GitHub 限流 / 仓库还没发过 release
 *    都是常态，不是错误 —— 它绝不能影响主流程，更不能在界面上变成一条红字。
 *    只有**用户手动点**的检查失败才把文案带回去。
 * 3. **状态迁移只在 promise 的 catch 里做**（`error` 事件只记日志）：事件与 reject 的
 *    先后顺序不是契约，两边都改状态会互相覆盖。
 *
 * ## 安装前不冲刷渲染端
 *
 * 与 dogi 不同，这里没有 `requestRendererFlush` 那样的握手：本项目的会话真源是**进程内
 * 后端**（消息落盘在 server 侧、随每次写入即持久化），渲染端持有的只是流式现场，
 * 退出丢掉它与「用户直接点退出」是同一个代价 —— 而 `quitAndInstall` 走的正是
 * `app.quit()`，`before-quit` / `will-quit` 那套收尾（`backendManager.stop()`、
 * `killAllPtySessions()`）照常执行。所以这里直接装，不另造一条链路。
 *
 * ⚠️ `electron-updater` 是 CJS 包，而主进程产物是 **ESM**（见 vite.main.mts）。
 * ESM 里对 CJS 的具名导入依赖 cjs-module-lexer 的静态分析，**不保证**解析得出
 * `exports.autoUpdater` —— 所以一律走 default import 再解构。
 *
 * ⚠️ `CancellationToken` **必须**取自本包的转出，**绝不能**写成
 * `import { CancellationToken } from 'builder-util-runtime'`：那个包不是本项目的直接
 * 依赖，主进程产物里是裸导入，只会在 `out/main` 往上逐级的 `node_modules` 里找，
 * 看不见嵌套副本 —— 打包后启动即报 `Cannot find package 'builder-util-runtime'`。
 */
import { app } from 'electron'
import type { AppUpdateState, AppUpdateStatus } from '../shared/window'
import updaterPkg from 'electron-updater'

const { autoUpdater, CancellationToken } = updaterPkg

/** 启动后多久开始静默检查（ms）：别和窗口首屏抢网 */
const SILENT_CHECK_DELAY = 8000
/** 常驻托盘的应用可能几天不重启，隔一段时间再静默查一次（同样只查不下载） */
const SILENT_CHECK_INTERVAL = 6 * 60 * 60 * 1000

/** 当前状态（单例持有，IPC 只读它 / 改它） */
let state: AppUpdateState = 'idle'
/** 最近一次发现的新版本号（available / downloading / downloaded 时有值） */
let latestVersion: string | null = null
/** 下载进度百分比（只有 downloading 时有意义） */
let percent = 0
/** 出错文案（检查 / 下载失败时给界面显示；正常为 null） */
let error: string | null = null
/**
 * 进行中下载的取消令牌；为 null 表示当前没在下载（据此判断是否可取消）。
 * 类型直接取 `downloadUpdate` 的入参类型：`CancellationToken` 是带私有成员的 class，
 * 只要声明来源与 electron-updater 不是同一份，TS 就会判定两者不兼容。
 */
type DownloadToken = NonNullable<Parameters<typeof autoUpdater.downloadUpdate>[0]>
let downloadToken: DownloadToken | null = null
/** 上报出口（`registerWindowIpc` 注入 broadcaster） */
let broadcast: ((status: AppUpdateStatus) => void) | null = null
/** 事件订阅只能挂一次 */
let initialized = false

/**
 * 是否可用：只有打包态才有 `app-update.yml`。
 *
 * Linux 额外要求 AppImage：deb / rpm 装的版本 electron-updater 装不了（它只会去替换
 * AppImage 文件），那种情况下报「不支持」比报一堆权限错误诚实。
 */
export function updaterSupported(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'linux' && !process.env.APPIMAGE) return false
  return true
}

/** 当前状态快照（给 `appUpdateStatus` 用） */
export function updaterStatus(): AppUpdateStatus {
  return {
    state,
    current: app.getVersion(),
    latest: latestVersion,
    supported: updaterSupported(),
    percent,
    error
  }
}

function setState(next: AppUpdateState, patch: Partial<AppUpdateStatus> = {}): void {
  state = next
  if ('latest' in patch) latestVersion = patch.latest ?? null
  if ('percent' in patch) percent = patch.percent ?? 0
  if ('error' in patch) error = patch.error ?? null
  broadcast?.(updaterStatus())
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 绑定事件并注入广播出口。**只能调一次**（在 `registerWindowIpc` 里）。
 *
 * 开发态只记下广播出口、不挂事件：免得 dev 里手动调 `checkForUpdates()` 抛一堆看不懂的栈。
 */
export function initUpdater(report: (status: AppUpdateStatus) => void): void {
  broadcast = report
  if (initialized || !updaterSupported()) return
  initialized = true

  // 绝不自动下载：发现即提示，由用户点击后再后台下（且可取消）；装仍要用户点头
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // 不推预发布版（产品约定）
  autoUpdater.allowPrerelease = false
  // 也不降级：本地版本比远端新（自己装了高版本）时不要把用户拽回去
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => {
    setState('checking', { error: null })
  })

  autoUpdater.on('update-available', (info) => {
    console.info('[updater] 发现新版本', info.version, '，等待用户点击后下载')
    setState('available', { latest: info.version, percent: 0, error: null })
  })

  autoUpdater.on('update-not-available', () => {
    setState('up-to-date', { latest: null, percent: 0, error: null })
  })

  autoUpdater.on('download-progress', (progress) => {
    // 取消之后可能还有一两帧在途的进度事件：那时 downloadToken 已经清掉，
    // 不拦的话界面会被这几帧重新拉回「下载中」并卡在那里
    if (!downloadToken) return
    // 进度事件很密（几百条），取整后同一档不重复广播
    const next = Math.min(100, Math.max(0, Math.round(progress.percent)))
    if (next === percent) return
    setState('downloading', { percent: next })
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.info('[updater] 新版本', info.version, '已就绪，重启即可安装')
    downloadToken = null
    setState('downloaded', { latest: info.version, percent: 100, error: null })
  })

  // 用户取消下载：回到「有新版本待下载」，界面继续提示，可再次点击下载
  autoUpdater.on('update-cancelled', (info) => {
    console.info('[updater] 已取消下载', info?.version ?? '')
    downloadToken = null
    setState('available', { percent: 0, error: null })
  })

  autoUpdater.on('error', (err) => {
    // 只记日志：状态迁移统一由 checkForUpdates / downloadUpdate 的 catch 负责，
    // 两边都改状态会互相覆盖（而且事件与 reject 的先后顺序不是契约）
    console.warn('[updater] autoUpdater error:', describeError(err))
  })
}

/**
 * 检查更新。**永不抛**。
 *
 * `manual = true`（用户点了「检查更新」）时失败会把文案带回界面；
 * 静默检查失败只在日志里留一笔 —— 断网 / 仓库还没发过 release 是常态。
 */
export async function checkForUpdates(manual = false): Promise<AppUpdateStatus> {
  if (!updaterSupported()) return updaterStatus()
  // 检查中 / 下载中 / 已下完不重入：
  // - 下载中再查会打断当前的更新会话；
  // - **已下完再查会把 `downloaded` 冲掉**，用户就点不到「重启并安装」了（本地已下好的
  //   安装包还在，但状态没了就再也回不去 —— 只能重启应用重下一遍）。
  // ⚠️ 先收进一个 boolean 再判断：直接写 `state === 'checking'` 会让 TS 把下面那句
  // 「事件没来就兜一层」的 `state === 'checking'` 判成不可能分支（模块级 let 的窄化
  // 不会因为中间那句 await 而失效）。
  const busy = state === 'checking' || state === 'downloading' || state === 'downloaded'
  if (busy) return updaterStatus()

  try {
    await autoUpdater.checkForUpdates()
    // 结果由 update-available / update-not-available 事件落到状态里；
    // 两个事件都可能不来（比如请求被中途掐掉），这里兜一层，别把界面留在「检查中」
    if (state === 'checking') setState('idle')
  } catch (err) {
    const message = describeError(err)
    console.warn('[updater] 检查更新失败：', message)
    setState('idle', { error: manual ? message : null })
  }
  return updaterStatus()
}

/**
 * 开始后台下载已发现的新版本。**只有用户点「下载」才会走到这里**
 * （因为 `autoDownload = false`，发现新版时只进 `available` 态）。
 *
 * 用一份 `CancellationToken` 关联这次下载，`cancelDownload()` 调它的 `cancel()`
 * 中止（electron-updater 会据此抛 `CancellationError` 并触发 `update-cancelled`）。
 */
export function startDownload(): AppUpdateStatus {
  if (!updaterSupported()) return updaterStatus()
  // 只从「待下载」起步；下载中 / 已下完 / 检查中都不重入
  if (state !== 'available') return updaterStatus()

  downloadToken = new CancellationToken()
  setState('downloading', { percent: 0, error: null })
  void autoUpdater.downloadUpdate(downloadToken).catch((err: unknown) => {
    // 取消走 update-cancelled 事件（那时 downloadToken 已被清掉），不落到这；
    // 其余失败回落到「待下载」，让用户能重试
    if (!downloadToken) return
    downloadToken = null
    const message = describeError(err)
    console.warn('[updater] 下载更新失败：', message)
    setState('available', { percent: 0, error: message })
  })
  return updaterStatus()
}

/** 取消正在进行的下载，回到「有新版本待下载」（界面继续提示） */
export function cancelDownload(): AppUpdateStatus {
  if (state !== 'downloading' || !downloadToken) return updaterStatus()
  downloadToken.cancel()
  downloadToken = null
  return updaterStatus()
}

/** 启动后的静默检查：延迟一会儿，别和窗口首屏抢网；失败无声。之后定时再查（同样只查不下载） */
export function scheduleSilentCheck(): void {
  if (!updaterSupported()) return
  const first = setTimeout(() => {
    void checkForUpdates()
  }, SILENT_CHECK_DELAY)
  // 别拿一个定时器吊住退出（before-quit 会等所有句柄）
  first.unref?.()

  const repeat = setInterval(() => {
    // 正在下载就别插一脚（会打断当前的更新会话）
    if (state === 'downloading' || state === 'downloaded') return
    void checkForUpdates()
  }, SILENT_CHECK_INTERVAL)
  repeat.unref?.()
}

/**
 * 退出并安装已下载的更新。
 *
 * 调用方（IPC 层）**必须先置 `quitting`**：`quitAndInstall` 内部走 `app.quit()`，
 * 主窗口的 close 处理会按 `closeToTray` 偏好把它拦成「收起到托盘」，窗口关不掉
 * 就装不上（与标题栏 Window 菜单的「关闭」是同一套路）。
 *
 * 两个参数与 dogi 同口径（`isSilent = false`、`isForceRunAfter = false`）：NSIS 侧就是
 * 不带 `/S`、不带 `--force-run` —— 安装器按它自己的流程走（装过一次的安装目录它记得），
 * 不额外强制拉起新版本。想改成「全静默 + 装完自动拉起」就是 `quitAndInstall(true, true)`。
 */
export function quitAndInstall(): boolean {
  if (!updaterSupported() || state !== 'downloaded') return false
  console.info('[updater] 准备重启安装更新…')
  autoUpdater.quitAndInstall(false, false)
  return true
}
