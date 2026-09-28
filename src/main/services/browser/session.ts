import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page
} from 'playwright'
import type {
  BrowserChannel,
  BrowserFrame,
  BrowserInputEvent,
  BrowserSessionState,
  BrowserViewportMode
} from '@shared/types'
import {
  DEFAULT_BROWSER_VIEWPORT,
  MOBILE_PLATFORM,
  browserUserAgent,
  browserViewportPreset,
  type BrowserViewportPreset
} from '@shared/browser'
import { nextButtonsMask, toCdpCommand } from './input'
import { launchAttempts } from './resolver'

/**
 * 浏览器会话：一个浏览器面板 = 一个会话（Agent 会话页的内嵌面板，与
 * `browser_*` 工具操作的会话同池同 id，见 @shared/browser）。
 *
 * 画面走 CDP screencast（`Page.startScreencast`）而不是 Electron 的 WebContentsView ——
 * 因为 Playwright 只能控制它自己启动的浏览器，而那个浏览器不是 Electron 的 webContents。
 * 代价是输入要自己转发，好处是浏览器可以完全无窗口（headless）跑在后台，
 * 面板里看到的是一路帧流。
 *
 * 所有对外事件都**自带 sessionId**（AGENTS.md 4.2）：主进程产生的流式事件必须
 * 能被渲染端按归属路由，不能依赖「先建映射再收事件」的时序。
 */

/**
 * 两帧之间的最小间隔（ms）：Chromium 只在页面变化时推帧，滚动/动画时可能推满帧率。
 *
 * ⚠️ `Page.startScreencast` 的帧**恒等于视口的 CSS 尺寸**，与 deviceScaleFactor 无关 ——
 * 实测 context dsf=1 与 dsf=2 都出 390×844，且 `maxWidth`/`maxHeight` 只会缩不会放
 * （`tmp/probe-dsf.mjs`）。所以帧的数据量只由视口预设决定，别再按 dpr 去算「物理像素」。
 */
const MIN_FRAME_INTERVAL = 33

// ---------------------------------------------------------------------------
// 持久化 profile
// ---------------------------------------------------------------------------

/**
 * 持久化 profile 的根目录（`userData/browser-profiles`），由 `registerBrowserIpc` 注入。
 *
 * 本模块刻意保持与 Electron 解耦（`scripts/verify-agent-browser-tools.mjs` 会在纯 Node 下
 * 直接跑这份源码），拿不到 `app.getPath`，所以走和事件 broadcaster 同款的
 * 「注册时注入一次」模式（AGENTS.md 4.2 的归属思想）。
 *
 * 没注入（探针 / 单测）时回退为**临时上下文**：会话一关登录态即失，不落任何盘。
 */
let profilesRoot: string | null = null

export function setBrowserProfilesRoot(dir: string): void {
  profilesRoot = dir
}

/** 会话的持久化 profile 目录；未配置根目录时返回 null = 用临时上下文 */
function profileDirOf(sessionId: string): string | null {
  if (!profilesRoot) return null
  // 会话 id 含 `:`（agent-browser:<uuid>），文件系统里换成安全的字符；uuid 本身不需要防碰撞
  return join(profilesRoot, sessionId.replace(/[^a-zA-Z0-9._-]/g, '-'))
}

export interface BrowserSessionHandlers {
  onFrame: (frame: BrowserFrame) => void
  onState: (state: BrowserSessionState) => void
  onClosed: (sessionId: string, reason: string) => void
}

export class BrowserSession {
  readonly id: string

  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private cdp: CDPSession | null = null

  private readonly handlers: BrowserSessionHandlers
  private buttonsMask = 0
  private channelLabel: string | null = null
  private title = ''
  private loading = false
  private canGoBack = false
  private canGoForward = false
  private viewportMode: BrowserViewportMode = DEFAULT_BROWSER_VIEWPORT
  /** 页面视口（CSS px）：来自预设，**不跟随面板尺寸**（理由见 @shared/browser 的预设表） */
  private viewport = { width: 1280, height: 800 }
  private lastFrameAt = 0
  private screencasting = false
  private closed = false
  /** context / browser 级监听是否已挂（只挂一次，见 bindSessionListeners） */
  private contextBound = false
  /** 已绑过页面级监听的 page（同一个页面可能被接管两次，见 bindPage） */
  private boundPages = new WeakSet<Page>()
  /**
   * 宿主浏览器**自己报的** UA（建页时读一次）。
   * 切视口时据它派生手机 UA：桌面 UA 原样用、版本号跟着走，见 @shared/browser。
   */
  private desktopUserAgent = ''
  /**
   * 最近一帧画面。screencast 只在页面**变化**时推帧，所以面板重挂载（切标签页回来）
   * 时静止页面既没有新帧也没有状态推送 —— 留着这一帧，重挂载时补一次即可出图。
   */
  private lastFrame: BrowserFrame | null = null

  constructor(id: string, handlers: BrowserSessionHandlers) {
    this.id = id
    this.handlers = handlers
  }

  // ---------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------

  /**
   * 启动浏览器。按 `launchAttempts` 的顺序逐个尝试，第一个成功的即采用 ——
   * 比事先猜「这台机器有没有 Edge」可靠。
   */
  async start(
    channel: BrowserChannel,
    mode: BrowserViewportMode = DEFAULT_BROWSER_VIEWPORT
  ): Promise<void> {
    if (this.browser) return

    const preset = browserViewportPreset(mode)
    this.viewportMode = preset.mode
    this.applyViewport(preset)

    const attempts = launchAttempts(channel)
    const failures: string[] = []

    for (const attempt of attempts) {
      try {
        this.channelLabel = attempt.label
        const contextOptions = {
          viewport: this.viewport,
          // deviceScaleFactor 建 context 时定死，之后只能靠 CDP 改（见 applyDeviceScaleFactor）
          deviceScaleFactor: preset.dpr,
          // 页面常常是本地/内网地址，证书自签很常见
          ignoreHTTPSErrors: true
        }
        const profileDir = profileDirOf(this.id)
        if (profileDir) {
          // 持久化上下文：登录态（cookie / localStorage / IndexedDB）活得过会话重启 ——
          // `newContext()` 每次都是「无痕窗口」，关标签 / 重开应用就等于登出。
          // profile 按会话 id 一份（一个 Agent 会话一份浏览器，互不串台）；
          // 关标签 / browser_close / 应用退出都不删它，只有删会话（manager.purge）才落盘清理。
          this.context = await chromium.launchPersistentContext(profileDir, {
            headless: true,
            ...attempt.options,
            ...contextOptions
          })
          this.browser = this.context.browser()
        } else {
          this.browser = await chromium.launch({ headless: true, ...attempt.options })
          this.context = await this.browser.newContext(contextOptions)
        }
        // 持久化上下文启动即带一个起始页（上次异常退出还可能恢复出多页）：收敛到第一页，
        // 多余的关掉，避免帧流 / 导航作用在不确定的那页上
        const existing = this.context.pages()
        this.page = existing[0] ?? (await this.context.newPage())
        for (const extra of existing.slice(1)) void extra.close().catch(() => {})
        this.bindPage(this.page)
        // 先记下宿主真实 UA（切模式时据它派生），再起 screencast 拿到 CDP 会话下发覆盖
        this.desktopUserAgent = await this.readUserAgent()
        this.lastFrame = null
        await this.startScreencast()
        await this.applyPageEmulation()
        // context / browser 级监听放最后：这时首屏已是 this.page，
        // 不会被 context 的 page 事件误判成「新标签页」
        this.bindSessionListeners()
        this.pushState()
        return
      } catch (err) {
        failures.push(`${attempt.label}: ${errText(err)}`)
        this.browser = null
        this.context = null
        this.page = null
      }
    }

    throw new Error(`没有可用的浏览器。${failures.join('；')}`)
  }

  async close(reason = '用户关闭'): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.stopScreencast().catch(() => {})
    // browser.close() 会连带关掉 context / page，不必逐个关
    await this.browser?.close().catch(() => {})
    this.browser = null
    this.context = null
    this.page = null
    this.cdp = null
    this.lastFrame = null
    this.handlers.onClosed(this.id, reason)
  }

  isAlive(): boolean {
    return !this.closed && Boolean(this.page) && !this.page!.isClosed()
  }

  /**
   * 把最新一帧再推一次。
   *
   * screencast 只在**页面变化**时推帧，所以面板重挂载（切标签页回来）后，
   * 静止的页面既等不到新帧、也等不到状态推送 —— 面板会一直停在「浏览器还没打开」。
   * 渲染端挂载时主动拉一次状态，顺带补这一帧，画面立刻就回来了。
   */
  replayLastFrame(): void {
    if (this.closed || !this.lastFrame) return
    this.handlers.onFrame(this.lastFrame)
  }

  getPage(): Page {
    if (!this.page) throw new Error('浏览器尚未启动')
    return this.page
  }

  // ---------------------------------------------------------------------
  // 页面事件绑定
  // ---------------------------------------------------------------------

  /**
   * context / browser 级监听**只挂一次**。
   *
   * 之前这些挂在 `bindPage` 里，而每接管一个新标签页都会再调一次 `bindPage` ——
   * 监听器越积越多，同一个新页面会被接管好几遍（并发 `startScreencast`）。
   * 挂载时机放在 `start()` 末尾：那时 `this.page` 已经是首屏，context 的 `page`
   * 事件不会把首屏自己误当成「新标签页」。
   */
  private bindSessionListeners(): void {
    if (this.contextBound) return
    this.contextBound = true

    // 页面内的 target=_blank / window.open：直接切到新页面，否则用户点了没反应
    this.context?.on('page', (p) => void this.adoptPage(p))
    this.browser?.on('disconnected', () => {
      if (!this.closed) void this.close('浏览器进程已退出')
    })
  }

  /**
   * 接管新标签页（`target=_blank` / `window.open`）。
   *
   * 必须**换一条 CDP 会话**：`this.cdp` 是 `newCDPSession(page)` 绑在旧页面上的，
   * 复用它等于让画面、导航历史、UA 覆盖继续作用在旧页 —— 点击在新页、画面却还是旧页。
   * UA / 视口也不会自己跟过去：CDP 的模拟覆盖是**按 target** 的，新 target 一律回到默认。
   */
  private async adoptPage(p: Page): Promise<void> {
    if (this.closed || p === this.page) return
    // 先用**旧会话**停掉旧页的画面流再丢引用：否则旧页仍在推帧，它的监听器会把
    // 旧页画面混进新页的帧流里（两页画面来回闪）
    await this.stopScreencast().catch(() => {})
    this.cdp = null
    this.lastFrame = null
    this.lastFrameAt = 0

    this.page = p
    this.bindPage(p)
    await this.startScreencast()
    // 新 target 不继承旧页的覆盖：视口 / DPR / UA 重新下发一遍
    await this.applyPageEmulation()
    await this.refreshNavigation()
  }

  private bindPage(page: Page): void {
    // 同一个页面可能被接管两次（弹窗关掉后退回「打开者」），重复绑定会让状态刷新跑两遍
    if (this.boundPages.has(page)) return
    this.boundPages.add(page)

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      this.loading = false
      void this.refreshNavigation()
    })
    page.on('load', () => {
      this.loading = false
      void this.refreshNavigation()
    })
    page.on('domcontentloaded', () => {
      this.loading = false
      void this.refreshNavigation()
    })
    page.on('close', () => {
      // 关掉的不是当前页（被接管前的旧页）就不管事 —— 有些站点在新标签页打开后
      // 会自己把原页关掉，那不该把整个会话带走
      if (this.closed || page !== this.page) return
      // 当前页关了：还有活着的「打开者」就退回它（弹窗登录 / 支付回调常自己 window.close()），
      // 找不到才认为这次浏览器会话结束
      void page.opener().then((opener) => {
        if (opener && !opener.isClosed()) return this.adoptPage(opener)
        return this.close('页面已关闭')
      })
    })
  }

  /** 把当前预设的视口 / DPR / UA 下发到当前页面（首屏、切模式、接管新页共用一条路径） */
  private async applyPageEmulation(): Promise<void> {
    if (!this.page) return
    const preset = browserViewportPreset(this.viewportMode)
    await this.page.setViewportSize(this.viewport).catch(() => {})
    await this.applyDeviceScaleFactor(preset.dpr)
    await this.applyUserAgent(preset.mode)
  }

  /** 用 CDP 读导航历史：Playwright 没有 canGoBack / canGoForward 的等价 API */
  private async refreshNavigation(): Promise<void> {
    if (!this.page || !this.cdp) return
    try {
      const history = await this.cdp.send('Page.getNavigationHistory')
      this.canGoBack = history.currentIndex > 0
      this.canGoForward = history.currentIndex < history.entries.length - 1
    } catch {
      // screencast 未启动时没有 CDP 会话，忽略即可
    }
    this.title = await this.page.title().catch(() => '')
    this.pushState()
  }

  private pushState(): void {
    if (this.closed) return
    this.handlers.onState(this.state())
  }

  state(): BrowserSessionState {
    return {
      sessionId: this.id,
      url: this.page?.url() ?? '',
      title: this.title,
      loading: this.loading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      viewport: { ...this.viewport },
      viewportMode: this.viewportMode,
      channel: this.channelLabel
    }
  }

  // ---------------------------------------------------------------------
  // screencast
  // ---------------------------------------------------------------------

  private async startScreencast(): Promise<void> {
    if (!this.page || !this.context) return
    await this.stopScreencast().catch(() => {})
    if (!this.cdp) {
      try {
        this.cdp = await this.context.newCDPSession(this.page)
      } catch {
        return
      }
    }

    this.cdp.on('Page.screencastFrame', (ev) => {
      // ⚠️ 无论这一帧是否转发给渲染端，都必须 ack —— 不 ack Chromium 就停推，
      // 表现为「画面卡在第一帧再也不动」。
      void this.cdp?.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {})

      const meta = ev.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined
      const frame: BrowserFrame = {
        sessionId: this.id,
        data: ev.data,
        width: meta?.deviceWidth ?? this.viewport.width,
        height: meta?.deviceHeight ?? this.viewport.height
      }
      // 缓存**最新**一帧（含被节流掉的那些）：面板重挂载时用它立刻回画面
      this.lastFrame = frame

      const now = Date.now()
      if (now - this.lastFrameAt < MIN_FRAME_INTERVAL) return
      this.lastFrameAt = now
      this.handlers.onFrame(frame)
    })

    try {
      await this.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        // 等于视口尺寸 = 明确「不缩放」（maxWidth 只缩不放，见 MIN_FRAME_INTERVAL 的注释）
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
        everyNthFrame: 1
      })
      this.screencasting = true
    } catch {
      // 画面流起不来不影响会话存活；工具侧的导航 / 快照仍可用
    }
  }

  private async stopScreencast(): Promise<void> {
    if (!this.screencasting || !this.cdp) return
    this.screencasting = false
    await this.cdp.send('Page.stopScreencast').catch(() => {})
  }

  /** 由预设算出页面视口，启动与切换模式共用一份算法 */
  private applyViewport(preset: BrowserViewportPreset): void {
    this.viewport = { width: preset.width, height: preset.height }
  }

  /**
   * 切换视口预设（PC / 手机）：**尺寸 + DPR + UA** 一起切。
   *
   * ⚠️ `deviceScaleFactor` 建 context 时就写死了，Playwright 的 `setViewportSize`
   * 只会把**它自己记的那个值**重新下发一遍，所以换 DPR 得自己补一条 CDP override，
   * 而且必须在 `setViewportSize` **之后**发（否则被它覆盖回去）。
   * 失败也不影响布局正确性 —— 页面尺寸照样是新的，只是 DPR 停在旧值。
   */
  async setViewportMode(mode: BrowserViewportMode): Promise<void> {
    if (this.viewportMode === mode) return
    const preset = browserViewportPreset(mode)
    this.viewportMode = preset.mode
    this.applyViewport(preset)

    if (this.page) {
      await this.applyPageEmulation()
      // 帧的输出尺寸跟着变，必须重开 screencast（maxWidth/maxHeight 只在 start 时生效）
      await this.startScreencast()
      // UA 只对**之后的请求**生效：按 UA 分流的站点（m.xxx 跳转、服务端模板）
      // 不重新导航就一直是老页面 —— 而「切了视口却还是老样子」正是最迷惑的状态。
      await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    }
    this.pushState()
  }

  private async applyDeviceScaleFactor(dpr: number): Promise<void> {
    if (!this.cdp) return
    await this.cdp
      .send('Emulation.setDeviceMetricsOverride', {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: dpr,
        mobile: false
      })
      .catch(() => {})
  }

  /** UA 跟随视口预设（规则与理由见 @shared/browser 的 browserUserAgent） */
  private async applyUserAgent(mode: BrowserViewportMode): Promise<void> {
    if (!this.cdp) return
    await this.cdp
      .send('Emulation.setUserAgentOverride', {
        userAgent: browserUserAgent(mode, this.desktopUserAgent),
        ...(mode === 'mobile' ? { platform: MOBILE_PLATFORM } : {})
      })
      .catch(() => {})
  }

  /** 读宿主浏览器**自己报的** UA，作为桌面/手机两份 UA 的共同基准 */
  private async readUserAgent(): Promise<string> {
    const ua = await this.page?.evaluate(() => navigator.userAgent).catch(() => '')
    // headless 的 UA 带 "HeadlessChrome"，不少站点见它就直接降级/拦，
    // 在共享层统一抹掉（桌面、手机两份都会经过它）
    return (ua ?? '').replace(/HeadlessChrome/g, 'Chrome')
  }

  // ---------------------------------------------------------------------
  // 导航
  // ---------------------------------------------------------------------

  async navigate(url: string): Promise<void> {
    if (!this.page) throw new Error('浏览器尚未启动')
    const target = normalizeUrl(url)
    this.loading = true
    this.pushState()
    try {
      await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch {
      // 导航失败不算会话失败：状态里 loading 复位即可，调用方（工具 / 地址栏）自会收到回执
    } finally {
      this.loading = false
      await this.refreshNavigation()
    }
  }

  async goBack(): Promise<void> {
    await this.page?.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await this.refreshNavigation()
  }

  async goForward(): Promise<void> {
    await this.page?.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await this.refreshNavigation()
  }

  async reload(): Promise<void> {
    await this.page?.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await this.refreshNavigation()
  }

  // ---------------------------------------------------------------------
  // 输入转发
  // ---------------------------------------------------------------------

  async dispatchInput(input: BrowserInputEvent): Promise<void> {
    if (!this.cdp) return
    if (input.kind === 'mouse') {
      this.buttonsMask = nextButtonsMask(this.buttonsMask, input.type, input.button)
    }
    const command = toCdpCommand(input, this.buttonsMask)
    if (!command) return
    await this.cdp.send(command.method as never, command.params as never).catch(() => {})
  }
}

/** 用户可能在地址栏里只敲了域名 —— 补 http://（cURL 导入同款处理，见 AGENTS.md 6.7） */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  return `https://${trimmed}`
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0]
}

// ---------------------------------------------------------------------------
// 会话池
// ---------------------------------------------------------------------------

export class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>()

  get(id: string): BrowserSession | undefined {
    return this.sessions.get(id)
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  list(): string[] {
    return [...this.sessions.keys()]
  }

  create(id: string, handlers: BrowserSessionHandlers): BrowserSession {
    const existing = this.sessions.get(id)
    if (existing) return existing
    const session = new BrowserSession(id, handlers)
    this.sessions.set(id, session)
    return session
  }

  async close(id: string, reason?: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await session.close(reason)
  }

  /**
   * 关闭会话并**删除**它的持久化 profile（登录态一并清除）。
   *
   * 只在「会话本身被删除」时调用（删 Agent 会话 / 删工作区）——
   * 关标签、`browser_close` 工具、应用退出都必须**保留** profile，
   * 登录态要活得过它们，否则持久化就失去意义。
   */
  async purge(id: string): Promise<void> {
    await this.close(id, '会话已删除').catch(() => {})
    const dir = profileDirOf(id)
    if (!dir) return
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  /** 应用退出时调用：不留孤儿浏览器进程 */
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((s) => s.close('应用退出').catch(() => {})))
  }
}

export const browserSessions = new BrowserSessionManager()
