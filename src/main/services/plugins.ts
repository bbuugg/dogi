import { app } from 'electron'
import { readFile, readdir, writeFile, stat, cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import type {
  PluginManifest,
  PluginInfo,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginPermission
} from '@shared/plugin'
import { storage } from './storage'
import { executeHttp } from './http'

/**
 * 插件宿主（主进程侧）：
 * - 启动时扫描 userData/plugins 目录，读取每个插件的 plugin.json 并加载其主进程入口；
 * - 为插件提供命名空间隔离的 handler 注册（plugin:invoke 路由）；
 * - 提供内置 http / storage 能力，按 manifest 声明的权限放行；
 * - 支持运行时管理：启用/禁用（持久化）、卸载、从文件/目录安装。
 *
 * 渲染端通过 IPC 拉取 manifest 与渲染端源码（经 blob import 运行），
 * 因此插件无需打包进主应用，实现真正的运行时加载。
 */
class PluginHost {
  private manifests = new Map<string, PluginManifest>()
  /** pluginId:name -> handler */
  private handlers = new Map<string, (...args: unknown[]) => unknown>()
  /** 启用状态（id -> 是否启用），缺省启用；与插件代码分离存储，避免被内置同步覆盖 */
  private enabled = new Map<string, boolean>()
  /** 各插件主进程入口加载错误（用于管理页展示） */
  private loadErrors = new Map<string, string>()
  /** 已激活主进程入口的插件 id */
  private activatedMain = new Set<string>()

  private pluginsDir(): string {
    return join(app.getPath('userData'), 'plugins')
  }

  private enabledFile(): string {
    return join(this.pluginsDir(), '.enabled.json')
  }

  private isEnabled(id: string): boolean {
    return this.enabled.get(id) !== false
  }

  private async loadEnabledConfig(): Promise<void> {
    try {
      const file = this.enabledFile()
      if (!existsSync(file)) return
      const raw = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>
      if (raw && typeof raw === 'object') {
        for (const [id, v] of Object.entries(raw)) {
          if (typeof v === 'boolean') this.enabled.set(id, v)
        }
      }
    } catch {
      // 配置损坏则忽略，回退到全部启用
    }
  }

  private async saveEnabledConfig(): Promise<void> {
    try {
      const obj: Record<string, boolean> = {}
      for (const [id, v] of this.enabled) obj[id] = v
      await mkdir(this.pluginsDir(), { recursive: true })
      await writeFile(this.enabledFile(), JSON.stringify(obj, null, 2), 'utf-8')
    } catch (e) {
      console.error('[plugins] 保存启用配置失败', e)
    }
  }

  private toInfo(m: PluginManifest): PluginInfo {
    return { ...m, enabled: this.isEnabled(m.id), error: this.loadErrors.get(m.id) }
  }

  /**
   * 加载并激活某插件的主进程入口。
   * bust=true 时在 URL 上追加时间戳以绕过 ESM 模块缓存（重载场景）。
   */
  private async activateMain(manifest: PluginManifest, bust = false): Promise<void> {
    if (!manifest.main) return
    const mainPath = join(this.pluginsDir(), manifest.id, manifest.main)
    if (!existsSync(mainPath)) return
    const url = pathToFileURL(mainPath).href + (bust ? `?t=${Date.now()}` : '')
    const mod = await import(url)
    const activate = mod.activate ?? mod.default?.activate
    if (typeof activate === 'function') {
      await activate(this.buildMainApi(manifest))
      this.activatedMain.add(manifest.id)
    }
  }

  /** 注销某插件已注册的全部主进程 handler */
  private unregisterHandlers(id: string): void {
    for (const key of [...this.handlers.keys()]) {
      if (key.startsWith(id + ':')) this.handlers.delete(key)
    }
  }

  /** 重扫插件目录，刷新 manifest 集合（新增/删除的插件、变更的元信息） */
  private async rescan(dir: string): Promise<void> {
    const found = new Map<string, PluginManifest>()
    if (existsSync(dir)) {
      let entries: string[] = []
      try {
        entries = (await readdir(dir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        entries = []
      }
      for (const name of entries) {
        try {
          const manifestPath = join(dir, name, 'plugin.json')
          if (!existsSync(manifestPath)) continue
          const manifest: PluginManifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
          if (!manifest.id || !manifest.name) continue
          found.set(manifest.id, manifest)
        } catch (e) {
          console.error(`[plugins] 扫描插件失败：${name}`, e)
        }
      }
    }
    // 目录中已不存在的插件：移除并清理
    for (const id of [...this.manifests.keys()]) {
      if (!found.has(id)) {
        this.manifests.delete(id)
        this.activatedMain.delete(id)
        this.loadErrors.delete(id)
        this.unregisterHandlers(id)
      }
    }
    for (const [id, m] of found) this.manifests.set(id, m)
  }

  /** 把仓库内置插件（开发期 <appPath>/plugins）同步到 userData/plugins（始终覆盖，随应用发布） */
  private async seedBuiltinPlugins(dir: string): Promise<void> {
    try {
      const src = join(app.getAppPath(), 'plugins')
      if (!existsSync(src)) return
      const builtins = (await readdir(src, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
      for (const name of builtins) {
        const dest = join(dir, name)
        // 内置插件随应用发布：始终用仓库最新版本覆盖，确保 dev 期改动即时生效；
        // 用户在 userData 自行安装的其他插件（不在仓库 plugins 内）不受影响。
        // 过滤 node_modules 与源码目录（webview 模式插件只需 dist + preload + manifest）
        await cp(join(src, name), dest, {
          recursive: true,
          force: true,
          filter: (s) => {
            const parts = s.replace(/\\/g, '/').split('/')
            return !parts.some((p) => p === 'node_modules' || p === 'src' || p === '.git')
          }
        })
        console.log(`[plugins] 已同步内置插件到 userData：${name}`)
      }
    } catch (e) {
      console.error('[plugins] 播种内置插件失败', e)
    }
  }

  /**
   * 已「内置化」的旧插件 id：这些插件的能力已经做成了应用内置功能（功能区 + 主区域页面），
   * 对应的插件目录要从 userData/plugins 清掉，否则插件列表里会留一个功能重复的残留项。
   *
   * 播种只做「覆盖 / 新增」，不会删除仓库里已不存在的插件，所以这里显式清理一次。
   */
  private static readonly RETIRED_PLUGINS = ['api-client']

  /** 清理已内置化的旧插件目录（仅限本应用自己管理的 userData/plugins 目录） */
  private async removeRetiredPlugins(dir: string): Promise<void> {
    for (const id of PluginHost.RETIRED_PLUGINS) {
      const target = join(dir, id)
      if (!existsSync(target)) continue
      try {
        await rm(target, { recursive: true, force: true })
        console.log(`[plugins] 已清理已内置化的旧插件：${id}`)
      } catch (e) {
        console.error(`[plugins] 清理旧插件失败：${id}`, e)
      }
    }
  }

  /** 扫描并加载所有插件的主进程入口（在 registerIpc 之后调用） */
  async init(): Promise<void> {
    const dir = this.pluginsDir()
    // 内置插件同步到 userData（始终覆盖）
    await this.seedBuiltinPlugins(dir)
    // 已内置化的旧插件：清掉 userData 里的残留副本
    await this.removeRetiredPlugins(dir)
    // 读取启用配置（与插件目录分离，禁用状态持久化）
    await this.loadEnabledConfig()
    // 扫描 manifest
    await this.rescan(dir)
    // 依次激活启用的插件主进程入口
    for (const manifest of this.manifests.values()) {
      if (!this.isEnabled(manifest.id)) continue
      try {
        await this.activateMain(manifest)
      } catch (e) {
        this.loadErrors.set(manifest.id, e instanceof Error ? e.message : String(e))
        console.error(`[plugins] 加载插件主进程失败：${manifest.id}`, e)
      }
    }
  }

  /**
   * 重新加载插件（无需重启应用）：
   * 1) 重新同步仓库内置插件源码（dev 下改 <appPath>/plugins 即生效）；
   * 2) 重扫目录，刷新 manifest（新增/删除/改元信息）；
   * 3) 以绕过 ESM 缓存的 URL 重新执行主进程入口。
   * 传 id 只重载该插件；不传则重载全部。
   */
  async reload(id?: string): Promise<PluginInfo[]> {
    const dir = this.pluginsDir()
    await this.seedBuiltinPlugins(dir)
    await this.removeRetiredPlugins(dir)
    await this.rescan(dir)
    const targets = id ? [id] : [...this.manifests.keys()]
    for (const pid of targets) {
      const manifest = this.manifests.get(pid)
      if (!manifest) continue
      // 先注销旧 handler，避免残留
      this.unregisterHandlers(pid)
      this.activatedMain.delete(pid)
      this.loadErrors.delete(pid)
      if (!this.isEnabled(pid)) continue
      try {
        await this.activateMain(manifest, true)
        console.log(`[plugins] 已重新加载插件：${pid}`)
      } catch (e) {
        this.loadErrors.set(pid, e instanceof Error ? e.message : String(e))
        console.error(`[plugins] 重新加载插件失败：${pid}`, e)
      }
    }
    return this.listManifests()
  }

  /** 列出所有插件（含启用状态与加载错误），供管理页与渲染端使用 */
  listManifests(): PluginInfo[] {
    return [...this.manifests.values()].map((m) => this.toInfo(m))
  }

  /** 启用/禁用插件：禁用时注销其主进程 handler；启用时按需激活主进程入口 */
  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo[]> {
    this.enabled.set(id, enabled)
    await this.saveEnabledConfig()
    const manifest = this.manifests.get(id)
    if (enabled) {
      if (manifest && !this.activatedMain.has(id)) {
        try {
          await this.activateMain(manifest)
        } catch (e) {
          this.loadErrors.set(id, e instanceof Error ? e.message : String(e))
        }
      }
    } else {
      // 注销该插件注册的全部主进程 handler，并标记未激活
      this.unregisterHandlers(id)
      this.activatedMain.delete(id)
    }
    return this.listManifests()
  }

  /** 卸载插件：删除目录、注销 handler、清除状态 */
  async uninstall(id: string): Promise<PluginInfo[]> {
    const dir = join(this.pluginsDir(), id)
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (e) {
      console.error(`[plugins] 卸载删除目录失败：${id}`, e)
    }
    this.manifests.delete(id)
    this.activatedMain.delete(id)
    this.loadErrors.delete(id)
    this.enabled.delete(id)
    await this.saveEnabledConfig()
    this.unregisterHandlers(id)
    return this.listManifests()
  }

  /**
   * 从文件/目录安装插件：支持直接选择插件根目录，或选择 .zip 压缩包
   * （经系统 tar 解压，Windows 10+ / macOS / Linux 自带）。
   */
  async install(sourcePath: string): Promise<PluginInfo[]> {
    let workDir: string
    const st = await stat(sourcePath)
    if (st.isDirectory()) {
      workDir = sourcePath
    } else if (sourcePath.toLowerCase().endsWith('.zip')) {
      workDir = join(app.getPath('temp'), `opsdesk-plugin-${Date.now()}`)
      await mkdir(workDir, { recursive: true })
      await this.extractZip(sourcePath, workDir)
    } else {
      throw new Error('仅支持插件目录或 .zip 压缩包')
    }
    const pluginDir = await this.findPluginJson(workDir)
    if (!pluginDir) {
      throw new Error('未找到 plugin.json（请确认选择的是插件根目录或正确的压缩包）')
    }
    const manifest: PluginManifest = JSON.parse(await readFile(join(pluginDir, 'plugin.json'), 'utf-8'))
    if (!manifest.id || !manifest.name) throw new Error('plugin.json 缺少 id 或 name')
    const dest = join(this.pluginsDir(), manifest.id)
    if (existsSync(dest)) throw new Error(`插件 ${manifest.id} 已存在，请先卸载`)
    await cp(pluginDir, dest, { recursive: true, force: true })
    this.manifests.set(manifest.id, manifest)
    this.loadErrors.delete(manifest.id)
    if (this.isEnabled(manifest.id)) {
      try {
        await this.activateMain(manifest)
      } catch (e) {
        this.loadErrors.set(manifest.id, e instanceof Error ? e.message : String(e))
      }
    }
    return this.listManifests()
  }

  /** 用系统 tar 解压 zip（无额外依赖） */
  private extractZip(zip: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('tar', ['-xf', zip, '-C', dest], (err) =>
        err ? reject(err) : resolve()
      )
    })
  }

  /** 在目录树中查找 plugin.json 所在目录（容忍压缩包顶层包装目录），最多 6 层 */
  private async findPluginJson(dir: string): Promise<string | null> {
    const stack: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }]
    while (stack.length) {
      const { path: cur, depth } = stack.pop()!
      if (depth >= 6) continue
      let entries
      try {
        entries = await readdir(cur, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const p = join(cur, e.name)
        if (e.isDirectory()) stack.push({ path: p, depth: depth + 1 })
        else if (e.name === 'plugin.json') return cur
      }
    }
    return null
  }

  /** 读取插件渲染端源码（供渲染端 blob import，仅 renderer 为字符串时有效） */
  async getRendererCode(id: string): Promise<string | null> {
    const manifest = this.manifests.get(id)
    if (!manifest?.renderer) return null
    // webview 模式的 renderer 是对象，不走 blob import
    if (typeof manifest.renderer !== 'string') return null
    const file = join(this.pluginsDir(), id, manifest.renderer)
    try {
      await stat(file)
      return await readFile(file, 'utf-8')
    } catch {
      return null
    }
  }

  /**
   * 获取 webview 模式插件的 HTML 入口与 preload 脚本的绝对路径。
   * 仅 renderer.type === 'webview' 时返回有效结果，否则返回 null。
   */
  getWebviewInfo(id: string): { entry: string; preload: string | null } | null {
    const manifest = this.manifests.get(id)
    if (!manifest?.renderer || typeof manifest.renderer === 'string') return null
    if (manifest.renderer.type !== 'webview') return null
    const pluginDir = join(this.pluginsDir(), id)
    const entry = join(pluginDir, manifest.renderer.entry)
    const preload = manifest.renderer.preload
      ? join(pluginDir, manifest.renderer.preload)
      : null
    return { entry, preload }
  }

  private permissionsOf(id: string): Set<PluginPermission> {
    return new Set(this.manifests.get(id)?.permissions ?? [])
  }

  /** 渲染端调用插件自有主进程 handler */
  async invoke(pluginId: string, name: string, args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(`${pluginId}:${name}`)
    if (!handler) throw new Error(`插件 ${pluginId} 未注册 handler: ${name}`)
    return handler(...args)
  }

  /** 渲染端发起 HTTP 请求（需 http 权限） */
  async http(pluginId: string, req: PluginHttpRequest): Promise<PluginHttpResponse> {
    if (!this.permissionsOf(pluginId).has('http')) {
      throw new Error(`插件 ${pluginId} 未声明 http 权限`)
    }
    return executeHttp(req)
  }

  async storageGet<T>(pluginId: string, key: string): Promise<T | undefined> {
    if (!this.permissionsOf(pluginId).has('storage')) {
      throw new Error(`插件 ${pluginId} 未声明 storage 权限`)
    }
    return storage.getPluginData<T>(pluginId, key)
  }

  async storageSet<T>(pluginId: string, key: string, value: T): Promise<void> {
    if (!this.permissionsOf(pluginId).has('storage')) {
      throw new Error(`插件 ${pluginId} 未声明 storage 权限`)
    }
    storage.setPluginData(pluginId, key, value)
  }

  private buildMainApi(manifest: PluginManifest) {
    return {
      id: manifest.id,
      permissions: manifest.permissions ?? [],
      log: (...args: unknown[]) => console.log(`[plugin:${manifest.id}]`, ...args),
      /** 注册命名空间化的主进程 handler（最终 channel 为 pluginId:name） */
      registerHandler: (name: string, handler: (...args: unknown[]) => unknown) => {
        this.handlers.set(`${manifest.id}:${name}`, handler)
      },
      http: (req: PluginHttpRequest) => this.http(manifest.id, req),
      storage: {
        get: <T>(key: string) => this.storageGet<T>(manifest.id, key),
        set: <T>(key: string, value: T) => this.storageSet(manifest.id, key, value)
      }
    }
  }
}

export const pluginHost = new PluginHost()
