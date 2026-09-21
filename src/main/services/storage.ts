import Store from 'electron-store'
import { safeStorage } from 'electron'
import type {
  AgentWorkspace,
  AiModelConfig,
  AiPermissionMode,
  AiSettings,
  ApiGroup,
  ApiHistoryEntry,
  ApiRequestEntry,
  McpServerConfig,
  NoteEntry,
  NoteGroup,
  Preferences,
  ScriptEntry,
  ScriptGroup,
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
  notes: NoteEntry[]
  scriptGroups: ScriptGroup[]
  noteGroups: NoteGroup[]
  apiRequests: ApiRequestEntry[]
  apiGroups: ApiGroup[]
  apiHistory: ApiHistoryEntry[]
  shortcuts: ShortcutConfig[]
  agentWorkspaces: AgentWorkspace[]
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
  monitorInterval: 2000,
  confirmCloseTab: true
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
      notes: [],
      scriptGroups: [],
      noteGroups: [],
      apiRequests: [],
      apiGroups: [],
      apiHistory: [],
      shortcuts: DEFAULT_SHORTCUTS,
      agentWorkspaces: []
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

  // ---------- 脚本分组 ----------
  listScriptGroups(): ScriptGroup[] {
    return this.store.get('scriptGroups')
  }

  saveScriptGroup(input: { id?: string; name: string }): ScriptGroup[] {
    const groups = this.store.get('scriptGroups')
    const prev = input.id ? groups.find((g) => g.id === input.id) : undefined
    const group: ScriptGroup = {
      id: input.id || crypto.randomUUID(),
      name: input.name.trim(),
      createdAt: prev?.createdAt ?? Date.now()
    }
    this.store.set(
      'scriptGroups',
      prev ? groups.map((g) => (g.id === group.id ? group : g)) : [...groups, group]
    )
    return this.listScriptGroups()
  }

  deleteScriptGroup(
    id: string,
    deleteScripts = false
  ): { groups: ScriptGroup[]; scripts: ScriptEntry[] } {
    const members = this.store
      .get('scripts')
      .filter((s) => s.groupId === id)
      .map((s) => s.id)
    const doomed = new Set(deleteScripts ? members : [])
    this.store.set(
      'scriptGroups',
      this.store.get('scriptGroups').filter((g) => g.id !== id)
    )
    this.store.set(
      'scripts',
      this.store
        .get('scripts')
        .filter((s) => !doomed.has(s.id))
        .map((s) => (s.groupId === id ? { ...s, groupId: undefined } : s))
    )
    return { groups: this.listScriptGroups(), scripts: this.listScripts() }
  }

  arrangeScripts(payload: {
    groupIds: string[]
    scripts: Array<{ id: string; groupId?: string }>
  }): { groups: ScriptGroup[]; scripts: ScriptEntry[] } {
    const groups = this.store.get('scriptGroups')
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const ordered = payload.groupIds
      .map((id) => groupById.get(id))
      .filter((g): g is ScriptGroup => Boolean(g))
    for (const g of groups) {
      if (!payload.groupIds.includes(g.id)) ordered.push(g)
    }
    this.store.set('scriptGroups', ordered)

    const scripts = this.store.get('scripts')
    const scriptById = new Map(scripts.map((s) => [s.id, s]))
    const next: ScriptEntry[] = []
    for (const item of payload.scripts) {
      const s = scriptById.get(item.id)
      if (!s) continue
      next.push(s.groupId === item.groupId ? s : { ...s, groupId: item.groupId })
    }
    for (const s of scripts) {
      if (!next.some((x) => x.id === s.id)) next.push(s)
    }
    this.store.set('scripts', next)

    return { groups: this.listScriptGroups(), scripts: this.listScripts() }
  }

  // ---------- 笔记 ----------
  listNotes (): NoteEntry[] {
    return this.store.get('notes')
  }

  /** 保存笔记（upsert）：不传 id 视为新增，默认语言 markdown */
  saveNote(input: NoteEntry): NoteEntry[] {
    const notes = this.store.get('notes')
    const now = Date.now()
    const prev = input.id ? notes.find((n) => n.id === input.id) : undefined
    const entry: NoteEntry = {
      ...input,
      id: input.id || crypto.randomUUID(),
      language: input.language || prev?.language || 'markdown',
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    const next = prev
      ? notes.map((n) => (n.id === entry.id ? entry : n))
      : [...notes, entry]
    this.store.set('notes', next)
    return next
  }

  deleteNote(id: string): NoteEntry[] {
    this.store.set(
      'notes',
      this.store.get('notes').filter((n) => n.id !== id)
    )
    return this.listNotes()
  }

  // ---------- 笔记分组 ----------
  listNoteGroups(): NoteGroup[] {
    return this.store.get('noteGroups')
  }

  saveNoteGroup(input: { id?: string; name: string }): NoteGroup[] {
    const groups = this.store.get('noteGroups')
    const prev = input.id ? groups.find((g) => g.id === input.id) : undefined
    const group: NoteGroup = {
      id: input.id || crypto.randomUUID(),
      name: input.name.trim(),
      createdAt: prev?.createdAt ?? Date.now()
    }
    this.store.set(
      'noteGroups',
      prev ? groups.map((g) => (g.id === group.id ? group : g)) : [...groups, group]
    )
    return this.listNoteGroups()
  }

  deleteNoteGroup(
    id: string,
    deleteNotes = false
  ): { groups: NoteGroup[]; notes: NoteEntry[] } {
    const members = this.store
      .get('notes')
      .filter((n) => n.groupId === id)
      .map((n) => n.id)
    const doomed = new Set(deleteNotes ? members : [])
    this.store.set(
      'noteGroups',
      this.store.get('noteGroups').filter((g) => g.id !== id)
    )
    this.store.set(
      'notes',
      this.store
        .get('notes')
        .filter((n) => !doomed.has(n.id))
        .map((n) => (n.groupId === id ? { ...n, groupId: undefined } : n))
    )
    return { groups: this.listNoteGroups(), notes: this.listNotes() }
  }

  arrangeNotes(payload: {
    groupIds: string[]
    notes: Array<{ id: string; groupId?: string }>
  }): { groups: NoteGroup[]; notes: NoteEntry[] } {
    const groups = this.store.get('noteGroups')
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const ordered = payload.groupIds
      .map((id) => groupById.get(id))
      .filter((g): g is NoteGroup => Boolean(g))
    for (const g of groups) {
      if (!payload.groupIds.includes(g.id)) ordered.push(g)
    }
    this.store.set('noteGroups', ordered)

    const notes = this.store.get('notes')
    const noteById = new Map(notes.map((n) => [n.id, n]))
    const next: NoteEntry[] = []
    for (const item of payload.notes) {
      const n = noteById.get(item.id)
      if (!n) continue
      next.push(n.groupId === item.groupId ? n : { ...n, groupId: item.groupId })
    }
    for (const n of notes) {
      if (!next.some((x) => x.id === n.id)) next.push(n)
    }
    this.store.set('notes', next)

    return { groups: this.listNoteGroups(), notes: this.listNotes() }
  }

  // ---------- 接口请求（内置的 API 调试功能） ----------
  listApiRequests(): ApiRequestEntry[] {
    return this.store.get('apiRequests')
  }

  /** 保存接口请求（upsert）：不传 id 视为新增 */
  saveApiRequest(input: ApiRequestEntry): ApiRequestEntry[] {
    const requests = this.store.get('apiRequests')
    const now = Date.now()
    const prev = input.id ? requests.find((r) => r.id === input.id) : undefined
    const entry: ApiRequestEntry = {
      ...input,
      id: input.id || crypto.randomUUID(),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    const next = prev
      ? requests.map((r) => (r.id === entry.id ? entry : r))
      : [...requests, entry]
    this.store.set('apiRequests', next)
    return next
  }

  deleteApiRequest(id: string): ApiRequestEntry[] {
    this.store.set(
      'apiRequests',
      this.store.get('apiRequests').filter((r) => r.id !== id)
    )
    return this.listApiRequests()
  }

  /**
   * 拖拽排序 / 换组后的整体重排：数组顺序即显示顺序。
   * - groupIds：分组的目标顺序（未列出的分组按原相对顺序附在其后）；
   * - requests：请求按目标顺序列出，groupId 为最终归属（undefined = 未分组）。
   * 只改 groupId，不碰请求内容本身，也不刷新 updatedAt（列表里显示的是「最近编辑」时间，
   * 拖一下顺序就跳成「刚刚」会很误导）。
   */
  arrangeApi(payload: {
    groupIds: string[]
    requests: Array<{ id: string; groupId?: string }>
  }): { groups: ApiGroup[]; requests: ApiRequestEntry[] } {
    const groups = this.store.get('apiGroups')
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const ordered = payload.groupIds
      .map((id) => groupById.get(id))
      .filter((g): g is ApiGroup => Boolean(g))
    for (const g of groups) {
      if (!payload.groupIds.includes(g.id)) ordered.push(g)
    }
    this.store.set('apiGroups', ordered)

    const requests = this.store.get('apiRequests')
    const requestById = new Map(requests.map((r) => [r.id, r]))
    const next: ApiRequestEntry[] = []
    for (const item of payload.requests) {
      const r = requestById.get(item.id)
      if (!r) continue
      next.push(r.groupId === item.groupId ? r : { ...r, groupId: item.groupId })
    }
    for (const r of requests) {
      if (!next.some((x) => x.id === r.id)) next.push(r)
    }
    this.store.set('apiRequests', next)

    return { groups: this.listApiGroups(), requests: this.listApiRequests() }
  }

  // ---------- 接口请求分组 ----------
  listApiGroups(): ApiGroup[] {
    return this.store.get('apiGroups')
  }

  /** 保存分组（upsert）：不传 id 视为新增 */
  saveApiGroup(input: { id?: string; name: string }): ApiGroup[] {
    const groups = this.store.get('apiGroups')
    const prev = input.id ? groups.find((g) => g.id === input.id) : undefined
    const group: ApiGroup = {
      id: input.id || crypto.randomUUID(),
      name: input.name.trim(),
      createdAt: prev?.createdAt ?? Date.now()
    }
    this.store.set(
      'apiGroups',
      prev ? groups.map((g) => (g.id === group.id ? group : g)) : [...groups, group]
    )
    return this.listApiGroups()
  }

  /**
   * 删除分组：默认只删分组本身，组内请求回到「未分组」；
   * deleteRequests 为 true 时连同组内请求一起删除（由用户在弹出的确认框里勾选）。
   * 两份数据一起返回 —— 渲染端无论如何都要同时更新它们。
   */
  deleteApiGroup(
    id: string,
    deleteRequests = false
  ): { groups: ApiGroup[]; requests: ApiRequestEntry[] } {
    const members = this.store
      .get('apiRequests')
      .filter((r) => r.groupId === id)
      .map((r) => r.id)
    const doomed = new Set(deleteRequests ? members : [])
    this.store.set(
      'apiGroups',
      this.store.get('apiGroups').filter((g) => g.id !== id)
    )
    this.store.set(
      'apiRequests',
      this.store
        .get('apiRequests')
        .filter((r) => !doomed.has(r.id))
        .map((r) => (r.groupId === id ? { ...r, groupId: undefined } : r))
    )
    return { groups: this.listApiGroups(), requests: this.listApiRequests() }
  }

  listApiHistory(): ApiHistoryEntry[] {
    return this.store.get('apiHistory')
  }

  /**
   * 覆盖写入整段历史（渲染端每次发送后把裁剪过的数组传回来）。
   * 历史是「最近 N 条」的滑动窗口，逐条增删反而更容易和界面状态不一致。
   */
  saveApiHistory(entries: ApiHistoryEntry[]): ApiHistoryEntry[] {
    this.store.set('apiHistory', entries)
    return this.listApiHistory()
  }

  clearApiHistory(): ApiHistoryEntry[] {
    this.store.set('apiHistory', [])
    return []
  }

  // ---------- 快捷键（应用内：主进程只存取配置，匹配与触发在渲染端） ----------
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
    // 尚无有效激活配置（首次添加 / 之前激活的被删）：自动激活刚保存的这条，
    // 否则新建后 AI 面板仍处「未选中」状态、发不出消息
    const settings = this.getAiSettings()
    const activeValid =
      settings.activeConfigId && next.some((c) => c.id === settings.activeConfigId)
    if (!activeValid) {
      this.store.set('aiSettings', { ...settings, activeConfigId: config.id })
    }
    return this.listAiConfigs()
  }

  deleteAiConfig(id: string): AiModelConfig[] {
    const remaining = this.store.get('aiConfigs').filter((c) => c.id !== id)
    this.store.set('aiConfigs', remaining)
    const settings = this.getAiSettings()
    // 删除的是当前激活配置：自动切到剩余第一个（没有则置空），
    // 避免 activeConfigId 悬空指向已删项导致面板切换失效
    if (settings.activeConfigId === id) {
      this.store.set('aiSettings', { ...settings, activeConfigId: remaining[0]?.id })
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
    const settings: AiSettings = { ...DEFAULT_AI_SETTINGS, ...rest, permissionMode }
    // 校正悬空的 activeConfigId（指向已删除的配置）：回退到剩余第一个，
    // 否则面板下拉框匹配不到 option、既显示空白又切不动
    if (settings.activeConfigId && !this.store.get('aiConfigs').some((c) => c.id === settings.activeConfigId)) {
      settings.activeConfigId = this.store.get('aiConfigs')[0]?.id
    }
    return settings
  }

  saveAiSettings(settings: Partial<AiSettings>): AiSettings {
    const next = { ...this.getAiSettings(), ...settings }
    this.store.set('aiSettings', next)
    return next
  }

  // ---------- Agent 工作区 ----------
  listAgentWorkspaces(): AgentWorkspace[] {
    return this.store.get('agentWorkspaces')
  }

  getAgentWorkspace(id: string): AgentWorkspace | undefined {
    return this.store.get('agentWorkspaces').find((w) => w.id === id)
  }

  /** 保存工作区（upsert）；相同 path 视为同一工作区，改名即更新 */
  saveAgentWorkspace(input: { id?: string; name: string; path: string }): AgentWorkspace[] {
    const workspaces = this.store.get('agentWorkspaces')
    const now = Date.now()
    const byPath = workspaces.find((w) => w.path === input.path)
    const prev = input.id ? workspaces.find((w) => w.id === input.id) : undefined
    const target = byPath ?? prev
    const next = target
      ? workspaces.map((w) =>
          w === target
            ? { ...w, name: input.name.trim() || w.name, updatedAt: now }
            : w
        )
      : [
          ...workspaces,
          {
            id: crypto.randomUUID(),
            name: input.name.trim(),
            path: input.path,
            createdAt: now,
            updatedAt: now
          }
        ]
    this.store.set('agentWorkspaces', next)
    return next
  }

  deleteAgentWorkspace(id: string): AgentWorkspace[] {
    const next = this.store.get('agentWorkspaces').filter((w) => w.id !== id)
    this.store.set('agentWorkspaces', next)
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
