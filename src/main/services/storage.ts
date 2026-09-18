import Store from 'electron-store'
import { safeStorage } from 'electron'
import type {
  AiModelConfig,
  AiPermissionMode,
  AiSettings,
  McpServerConfig,
  Preferences,
  ScriptEntry,
  ShortcutConfig,
  SshGroup,
  SshProfile
} from '@shared/types'
import { DEFAULT_SHORTCUTS } from '@shared/shortcuts'

interface StoreSchema {
  sshProfiles: SshProfile[]
  sshGroups: SshGroup[]
  aiConfigs: AiModelConfig[]
  mcpServers: McpServerConfig[]
  aiSettings: AiSettings
  preferences: Preferences
  scripts: ScriptEntry[]
  shortcuts: ShortcutConfig[]
  windowBounds?: { x?: number; y?: number; width: number; height: number }
}

const DEFAULT_AI_SETTINGS: AiSettings = { permissionMode: 'full' }
const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  colorTheme: 'neutral',
  customColor: '#3b82f6',
  terminalTheme: 'auto',
  copyOnSelect: true,
  rightClickPaste: true,
  commandPrediction: true,
  terminalFontSize: 13,
  localShell: 'default',
  minimizeToTray: true,
  monitorInterval: 2000
}

/** 密钥类字段加密前缀（safeStorage 密文 base64） */
const ENC_PREFIX = 'enc:'

class StorageService {
  private store = new Store<StoreSchema>({
    defaults: {
      sshProfiles: [],
      sshGroups: [],
      aiConfigs: [],
      mcpServers: [],
      aiSettings: DEFAULT_AI_SETTINGS,
      preferences: DEFAULT_PREFERENCES,
      scripts: [],
      shortcuts: DEFAULT_SHORTCUTS
    }
  })

  private encrypt(secret: string | undefined): string | undefined {
    if (!secret) return undefined
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return ENC_PREFIX + safeStorage.encryptString(secret).toString('base64')
      }
    } catch {
      // 加密失败时退回明文存储
    }
    return secret
  }

  private decrypt(stored: string | undefined): string | undefined {
    if (!stored) return undefined
    if (!stored.startsWith(ENC_PREFIX)) return stored
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      return undefined
    }
  }

  // ---------- 偏好（主题等） ----------
  getPreferences(): Preferences {
    return { ...DEFAULT_PREFERENCES, ...this.store.get('preferences') }
  }

  savePreferences(patch: Partial<Preferences>): Preferences {
    const next = { ...this.getPreferences(), ...patch }
    this.store.set('preferences', next)
    return next
  }

  // ---------- 窗口 ----------
  getWindowBounds(): StoreSchema['windowBounds'] {
    return this.store.get('windowBounds')
  }

  setWindowBounds(bounds: StoreSchema['windowBounds']): void {
    this.store.set('windowBounds', bounds)
  }

  // ---------- SSH 配置 ----------
  listSshProfiles(): SshProfile[] {
    return this.store.get('sshProfiles').map((p) => ({
      ...p,
      kind: p.kind ?? 'ssh',
      password: undefined,
      passphrase: undefined,
      privateKey: undefined,
      hasPassword: Boolean(p.password),
      hasPassphrase: Boolean(p.passphrase),
      hasPrivateKey: Boolean(p.privateKey)
    }))
  }

  /** 按 id 取配置（主进程内部使用：密钥字段已解密，禁止直接发给渲染端） */
  getSshProfile(id: string): SshProfile | undefined {
    const profile = this.store.get('sshProfiles').find((p) => p.id === id)
    if (!profile) return undefined
    return {
      ...profile,
      kind: profile.kind ?? 'ssh',
      password: this.decrypt(profile.password),
      passphrase: this.decrypt(profile.passphrase)
    }
  }

  /** 保存 SSH 配置（upsert）；password/privateKey/passphrase 为 undefined 时保留旧值 */
  saveSshProfile(input: SshProfile): SshProfile[] {
    const profiles = this.store.get('sshProfiles')
    const now = Date.now()
    const prev = input.id ? profiles.find((p) => p.id === input.id) : undefined
    const profile: SshProfile = {
      ...input,
      id: input.id || crypto.randomUUID(),
      kind: input.kind ?? 'ssh',
      password: input.password !== undefined ? this.encrypt(input.password) : prev?.password,
      privateKey:
        input.privateKey !== undefined ? input.privateKey : prev?.privateKey,
      passphrase:
        input.passphrase !== undefined ? this.encrypt(input.passphrase) : prev?.passphrase,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    const next = prev
      ? profiles.map((p) => (p.id === profile.id ? profile : p))
      : [...profiles, profile]
    this.store.set('sshProfiles', next)
    return this.listSshProfiles()
  }

  deleteSshProfile(id: string): SshProfile[] {
    this.store.set(
      'sshProfiles',
      this.store.get('sshProfiles').filter((p) => p.id !== id)
    )
    return this.listSshProfiles()
  }

  /**
   * 拖拽排序 / 换组后的整体重排：数组顺序即显示顺序。
   * - groupIds：分组的目标顺序（未列出的分组按原相对顺序附在其后）；
   * - profiles：连接按目标顺序列出，groupId 为最终归属（undefined = 未分组）。
   * 只改 groupId，不碰密码/私钥等加密字段。
   */
  arrangeSsh(payload: {
    groupIds: string[]
    profiles: Array<{ id: string; groupId?: string }>
  }): { groups: SshGroup[]; profiles: SshProfile[] } {
    const groups = this.store.get('sshGroups')
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const ordered = payload.groupIds
      .map((id) => groupById.get(id))
      .filter((g): g is SshGroup => Boolean(g))
    for (const g of groups) {
      if (!payload.groupIds.includes(g.id)) ordered.push(g)
    }
    this.store.set('sshGroups', ordered)

    const profiles = this.store.get('sshProfiles')
    const profileById = new Map(profiles.map((p) => [p.id, p]))
    const next: SshProfile[] = []
    for (const item of payload.profiles) {
      const p = profileById.get(item.id)
      if (!p) continue
      next.push(
        p.groupId === item.groupId ? p : { ...p, groupId: item.groupId, updatedAt: Date.now() }
      )
    }
    for (const p of profiles) {
      if (!next.some((x) => x.id === p.id)) next.push(p)
    }
    this.store.set('sshProfiles', next)

    return { groups: this.listSshGroups(), profiles: this.listSshProfiles() }
  }

  // ---------- SSH 分组 ----------
  listSshGroups(): SshGroup[] {
    return this.store.get('sshGroups')
  }

  /** 保存分组（upsert）：不传 id 视为新增；color 为 undefined 时保留原色，传 null 清除颜色 */
  saveSshGroup(input: { id?: string; name: string; color?: string | null }): SshGroup[] {
    const groups = this.store.get('sshGroups')
    const prev = input.id ? groups.find((g) => g.id === input.id) : undefined
    const group: SshGroup = {
      id: input.id || crypto.randomUUID(),
      name: input.name.trim(),
      color: input.color === undefined ? prev?.color : (input.color ?? undefined),
      createdAt: prev?.createdAt ?? Date.now()
    }
    this.store.set(
      'sshGroups',
      prev ? groups.map((g) => (g.id === group.id ? group : g)) : [...groups, group]
    )
    return this.listSshGroups()
  }

  /**
   * 删除分组：默认只删分组本身，组内连接回到「未分组」；
   * deleteProfiles 为 true 时连同组内连接一起删除（由用户在弹出的确认框里勾选）。
   */
  deleteSshGroup(id: string, deleteProfiles = false): SshGroup[] {
    const members = this.store
      .get('sshProfiles')
      .filter((p) => p.groupId === id)
      .map((p) => p.id)
    const doomed = new Set(deleteProfiles ? members : [])
    this.store.set(
      'sshGroups',
      this.store.get('sshGroups').filter((g) => g.id !== id)
    )
    this.store.set(
      'sshProfiles',
      this.store
        .get('sshProfiles')
        .filter((p) => !doomed.has(p.id))
        .map((p) => (p.groupId === id ? { ...p, groupId: undefined } : p))
    )
    return this.listSshGroups()
  }

  // ---------- 用户脚本 ----------
  listScripts(): ScriptEntry[] {
    return this.store.get('scripts')
  }

  /** 保存脚本（upsert）：不传 id 视为新增 */
  saveScript(input: ScriptEntry): ScriptEntry[] {
    const scripts = this.store.get('scripts')
    const now = Date.now()
    const prev = input.id ? scripts.find((s) => s.id === input.id) : undefined
    const entry: ScriptEntry = {
      ...input,
      id: input.id || crypto.randomUUID(),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    const next = prev
      ? scripts.map((s) => (s.id === entry.id ? entry : s))
      : [...scripts, entry]
    this.store.set('scripts', next)
    return next
  }

  deleteScript(id: string): ScriptEntry[] {
    this.store.set(
      'scripts',
      this.store.get('scripts').filter((s) => s.id !== id)
    )
    return this.listScripts()
  }

  // ---------- 快捷键（全局，系统级） ----------
  getShortcuts(): ShortcutConfig[] {
    const stored = this.store.get('shortcuts')
    // 合并缺省，确保新增动作有条目（旧的存储不含该动作时不丢配置）
    const byAction = new Map(stored.map((s) => [s.action, s]))
    return DEFAULT_SHORTCUTS.map((d) => byAction.get(d.action) ?? d)
  }

  saveShortcuts(shortcuts: ShortcutConfig[]): ShortcutConfig[] {
    const next = DEFAULT_SHORTCUTS.map((d) => {
      const found = shortcuts.find((s) => s.action === d.action)
      return found ?? d
    })
    this.store.set('shortcuts', next)
    return next
  }

  // ---------- AI 模型配置 ----------
  listAiConfigs(): AiModelConfig[] {
    return this.store.get('aiConfigs').map((c) => ({
      ...c,
      apiKey: undefined,
      hasApiKey: Boolean(c.apiKey)
    }))
  }

  getAiConfig(id: string): AiModelConfig | undefined {
    const config = this.store.get('aiConfigs').find((c) => c.id === id)
    if (!config) return undefined
    return { ...config, apiKey: this.decrypt(config.apiKey) }
  }

  saveAiConfig(input: AiModelConfig): AiModelConfig[] {
    const configs = this.store.get('aiConfigs')
    const now = Date.now()
    const prev = input.id ? configs.find((c) => c.id === input.id) : undefined
    const config: AiModelConfig = {
      ...input,
      id: input.id || crypto.randomUUID(),
      apiKey: input.apiKey !== undefined ? this.encrypt(input.apiKey) : prev?.apiKey,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    const next = prev
      ? configs.map((c) => (c.id === config.id ? config : c))
      : [...configs, config]
    this.store.set('aiConfigs', next)
    return this.listAiConfigs()
  }

  deleteAiConfig(id: string): AiModelConfig[] {
    this.store.set(
      'aiConfigs',
      this.store.get('aiConfigs').filter((c) => c.id !== id)
    )
    const settings = this.getAiSettings()
    if (settings.activeConfigId === id) {
      this.store.set('aiSettings', { ...settings, activeConfigId: undefined })
    }
    return this.listAiConfigs()
  }

  // ---------- AI 设置 ----------
  getAiSettings(): AiSettings {
    // 兼容旧版 autoApprove 布尔配置：关闭自动执行 -> 确认模式
    const stored = (this.store.get('aiSettings') ?? {}) as Partial<AiSettings> & {
      autoApprove?: boolean
    }
    const { autoApprove, ...rest } = stored
    const permissionMode: AiPermissionMode =
      rest.permissionMode ?? (autoApprove === false ? 'confirm' : 'full')
    return { ...DEFAULT_AI_SETTINGS, ...rest, permissionMode }
  }

  saveAiSettings(settings: Partial<AiSettings>): AiSettings {
    const next = { ...this.getAiSettings(), ...settings }
    this.store.set('aiSettings', next)
    return next
  }

  // ---------- MCP servers ----------
  listMcpServers(): McpServerConfig[] {
    return this.store.get('mcpServers')
  }

  saveMcpServer(input: McpServerConfig): McpServerConfig[] {
    const servers = this.store.get('mcpServers')
    const server: McpServerConfig = {
      ...input,
      id: input.id || crypto.randomUUID()
    }
    const next = input.id
      ? servers.map((s) => (s.id === server.id ? server : s))
      : [...servers, server]
    this.store.set('mcpServers', next)
    return next
  }

  deleteMcpServer(id: string): McpServerConfig[] {
    this.store.set(
      'mcpServers',
      this.store.get('mcpServers').filter((s) => s.id !== id)
    )
    return this.listMcpServers()
  }

  // ---------- 插件数据（按 pluginId 分区，键为 pluginId.key） ----------
  getPluginData<T>(pluginId: string, key: string): T | undefined {
    return this.store.get(`pluginData.${pluginId}.${key}`) as T | undefined
  }

  setPluginData<T>(pluginId: string, key: string, value: T): void {
    this.store.set(`pluginData.${pluginId}.${key}`, value)
  }
}

export const storage = new StorageService()
