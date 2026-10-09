import Store from 'electron-store'
import { safeStorage } from 'electron'
import type {
  AgentConversation,
  AgentWorkspace,
  ConversationContextSummary,
  AiModelConfig,
  AiPermissionMode,
  AiSettings,
  ApiGroup,
  ApiHistoryEntry,
  ApiRequestEntry,
  McpServerConfig,
  NoteEntry,
  NoteGroup,
  NoteSession,
  Preferences,
  ScriptEntry,
  ScriptGroup,
  ShortcutConfig,
  SkillSettings,
  SshGroup,
  SshKnownHost,
  SshProfile,
  SshTunnel
} from '@shared/types'
import { DEFAULT_MAX_RETRIES } from '@shared/ai-timeouts'
import { DEFAULT_SHORTCUTS } from '@shared/shortcuts'
import { applyDirMissing } from './ai/workspace-health'
import {
  conversationStore,
  terminalConversationStore,
  type SaveConversationInput
} from './conversation-store'

interface StoreSchema {
  sshProfiles: SshProfile[]
  sshGroups: SshGroup[]
  sshTunnels: SshTunnel[]
  /** 已信任的主机密钥指纹（TOFU；指纹变化时连接硬失败） */
  sshKnownHosts: SshKnownHost[]
  aiConfigs: AiModelConfig[]
  mcpServers: McpServerConfig[]
  aiSettings: AiSettings
  preferences: Preferences
  scripts: ScriptEntry[]
  notes: NoteEntry[]
  scriptGroups: ScriptGroup[]
  noteGroups: NoteGroup[]
  /** 上次打开的笔记文件夹与文件（重启后恢复；缺省视为没打开过） */
  noteSession?: NoteSession
  apiRequests: ApiRequestEntry[]
  apiGroups: ApiGroup[]
  apiHistory: ApiHistoryEntry[]
  shortcuts: ShortcutConfig[]
  agentWorkspaces: AgentWorkspace[]
  /**
   * @deprecated 会话已拆到 `<userData>/agent-conversations/` 下的独立文件
   * （见 `services/conversation-store.ts`）。
   *
   * 保留这个字段**只为一次性迁移**（构造期读取旧存档并搬进文件，然后删掉本键），
   * 之后所有读写一律走 `conversationStore` —— 别再往这里写，那会把几 MB 的会话历史
   * 重新塞回「每次 get/set 都要全量读盘 + 校验」的主 store 里。
   */
  agentConversations?: AgentConversation[]
  /** 技能的用户选择（启停 / 额外根目录）——技能内容本身在磁盘上，不进这里 */
  skillSettings: SkillSettings
  windowBounds?: { x?: number; y?: number; width: number; height: number }
  /** 一次性迁移的执行标记（key = 迁移名），跑过就不重复跑 */
  migrations?: Record<string, boolean>
}

const DEFAULT_SKILL_SETTINGS: SkillSettings = { disabled: [], extraDirs: [] }

const DEFAULT_AI_SETTINGS: AiSettings = { permissionMode: 'full', maxRetries: DEFAULT_MAX_RETRIES }
const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  colorTheme: 'neutral',
  customColor: '#3b82f6',
  terminalTheme: 'auto',
  copyOnSelect: true,
  rightClickPaste: true,
  commandPrediction: true,
  commandHistory: true,
  terminalFontSize: 13,
  localShell: 'default',
  minimizeToTray: true,
  monitorInterval: 2000,
  confirmCloseTab: true,
  // 笔记默认「手动保存」：改动先留在编辑器里，由用户点保存 / Ctrl+S 落盘
  noteSaveMode: 'manual',
  noteAutoSaveDelay: 2,
  notifyOnAgentFinish: true,
  hiddenActivities: [],
  browserChannel: 'auto',
  /**
   * 给 AI 用的浏览器工具：默认 `in-app` —— 用应用自带的浏览器（无窗口运行、画面镜像到
   * 界面里的浏览器面板）。想彻底不给浏览器能力就设 `off`，想换本机窗口就设 `system`。
   */
  browserToolMode: 'in-app'
}

/** 密钥类字段加密前缀（safeStorage 密文 base64） */
const ENC_PREFIX = 'enc:'

class StorageService {
  private store = new Store<StoreSchema>({
    defaults: {
      sshProfiles: [],
      sshGroups: [],
      sshTunnels: [],
      sshKnownHosts: [],
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
      agentWorkspaces: [],
      // ⚠️ 这里**刻意不给 `agentConversations` 设默认值**：会话在独立文件里，
      // 给了默认值会让 `store.get` 永远返回 `[]`，迁移判据（键是否存在）就失效了
      skillSettings: DEFAULT_SKILL_SETTINGS
    }
  })

  constructor() {
    this.migrateBrowserToolMode()
    this.migrateSshPrivateKeyAtRest()
    this.migrateAgentConversationsToFiles()
  }

  /**
   * 一次性迁移：会话历史上是**整个数组**塞在主 store 里的 `agentConversations` 键
   * （实测能到 4.76MB，占整个配置文件的 97%）。现在改成一会话一文件
   * （见 `services/conversation-store.ts`），这里把存量逐个搬进文件，然后删掉主 store 的键。
   *
   * 搬运是幂等的（同名文件直接覆盖），中途失败下次启动会重跑；键删掉之后这段就再也不进。
   */
  private migrateAgentConversationsToFiles(): void {
    const legacy = this.store.get('agentConversations')
    if (!Array.isArray(legacy)) return
    if (legacy.length > 0) {
      // 先把全部会话写进文件，**确认都成功**才删源数据：
      // 中途失败（磁盘满等）就保留原数组，下次启动重跑 —— 写文件是幂等的覆盖写
      try {
        conversationStore.importLegacy(legacy)
      } catch {
        return
      }
    }
    this.store.delete('agentConversations')
  }

  /**
   * 一次性迁移：把旧的「内置 Playwright MCP 开关」（布尔 `playwrightMcpEnabled`）
   * 折算成三态 `browserToolMode`（off / in-app / system）。
   *
   * 旧语义：`true` = 用外部 Playwright MCP（拉起本机窗口）；`false` / 未设置 = 用应用
   * 自带的浏览器。新语义里 `off` 是「一个浏览器工具都不给」—— 所以**旧的 false 不能
   * 映射成 off**，那会把老用户手里的自带浏览器能力静默关掉。映射规则：
   * `true → 'system'`，其余（含未设置）一律 `'in-app'`，即老用户的行为一点不变。
   *
   * ⚠️ 必须换一个新的 migration key：上一次「默认改关闭」的迁移
   * （`builtinMcpDefaultOff`）已经在老用户身上跑过了，沿用它这段代码永远不会执行。
   * 那段旧迁移已被本次取代（读取旧布尔值、写新值、顺手清掉旧字段）。
   */
  private migrateBrowserToolMode(): void {
    if (this.store.get('migrations')?.browserToolMode) return
    // 读的是**旧结构**：新类型里已经没有 playwrightMcpEnabled 了，只能按裸记录处理
    const prefs = {
      ...(this.store.get('preferences') as unknown as Record<string, unknown>)
    }
    if (prefs.browserToolMode === undefined) {
      prefs.browserToolMode = prefs.playwrightMcpEnabled === true ? 'system' : 'in-app'
    }
    delete prefs.playwrightMcpEnabled
    this.store.set('preferences', prefs as unknown as Preferences)
    this.store.set('migrations', {
      ...(this.store.get('migrations') ?? {}),
      browserToolMode: true
    })
  }

  /**
   * 一次性迁移：把历史上明文入库的私钥补成 safeStorage 密文。
   * 加密不可用时（如 Linux 未就绪 / 无 keyring）直接返回且**不写迁移标记**，
   * 下次启动或下一次保存（saveSshProfile 里会再兜底调用）继续尝试；
   * 保持明文的条目功能不受影响 —— decrypt 对无前缀值原样透传。
   *
   * 构造期会先跑一次，但 Windows 上 safeStorage 在 app ready 前不可用，
   * 构造期那次会被静默跳过；主进程在 whenReady 后再显式补跑一次（幂等）。
   */
  migrateSshPrivateKeyAtRest(): void {
    if (this.store.get('migrations')?.sshPrivateKeyAtRest) return
    try {
      if (!safeStorage.isEncryptionAvailable()) return
      let changed = 0
      const next = this.store.get('sshProfiles').map((p) => {
        if (!p.privateKey || p.privateKey.startsWith(ENC_PREFIX)) return p
        const encrypted = this.encrypt(p.privateKey)
        if (!encrypted || encrypted === p.privateKey) return p
        changed++
        return { ...p, privateKey: encrypted }
      })
      if (changed > 0) this.store.set('sshProfiles', next)
      this.store.set('migrations', {
        ...(this.store.get('migrations') ?? {}),
        sshPrivateKeyAtRest: true
      })
    } catch {
      // 保持明文可读即可，下次再试
    }
  }

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
      passphrase: this.decrypt(profile.passphrase),
      // 私钥同样加密落盘（历史明文条目由 migrateSshPrivateKeyAtRest 兜底补密）
      privateKey: this.decrypt(profile.privateKey)
    }
  }

  /** 保存 SSH 配置（upsert）；password/privateKey/passphrase 为 undefined 时保留旧值 */
  saveSshProfile(input: SshProfile): SshProfile[] {
    // 顺手补齐历史明文私钥 → 密文（幂等；构造期可能因 safeStorage 未就绪而跳过，这里兜底）
    this.migrateSshPrivateKeyAtRest()
    const profiles = this.store.get('sshProfiles')
    const now = Date.now()
    const prev = input.id ? profiles.find((p) => p.id === input.id) : undefined
    const profile: SshProfile = {
      ...input,
      id: input.id || crypto.randomUUID(),
      kind: input.kind ?? 'ssh',
      password: input.password !== undefined ? this.encrypt(input.password) : prev?.password,
      privateKey:
        input.privateKey !== undefined ? this.encrypt(input.privateKey) : prev?.privateKey,
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

  deleteSshProfile(id: string): { profiles: SshProfile[]; clearedJumps: number } {
    this.store.set(
      'sshProfiles',
      this.store.get('sshProfiles').filter((p) => p.id !== id)
    )
    const clearedJumps = this.clearJumpRefs(new Set([id]))
    return { profiles: this.listSshProfiles(), clearedJumps }
  }

  /**
   * 删除主机后清掉其它主机对它们的跳板引用。
   * 悬空引用只会让连接在跳板解析时报错，显式清掉更符合直觉（调用方负责提示用户）。
   */
  private clearJumpRefs(removedIds: Set<string>): number {
    if (removedIds.size === 0) return 0
    let cleared = 0
    const next = this.store.get('sshProfiles').map((p) => {
      if (!p.jumpProfileId || !removedIds.has(p.jumpProfileId)) return p
      cleared++
      return { ...p, jumpProfileId: undefined, updatedAt: Date.now() }
    })
    if (cleared > 0) this.store.set('sshProfiles', next)
    return cleared
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
    // 组内主机被一并删除时，清掉别处对它们的跳板引用（静默处理，保持本接口返回类型不变）
    this.clearJumpRefs(doomed)
    return this.listSshGroups()
  }

  // ---------- SSH 隧道（本地转发 -L / 远程转发 -R / SOCKS5 动态 -D） ----------
  listSshTunnels(): SshTunnel[] {
    return this.store.get('sshTunnels')
  }

  /** 保存隧道（upsert）：不传 id 视为新增；沿用「旧记录兜底」约定合并未带字段 */
  saveSshTunnel(input: SshTunnel): SshTunnel[] {
    const tunnels = this.store.get('sshTunnels')
    const now = Date.now()
    const prev = input.id ? tunnels.find((t) => t.id === input.id) : undefined
    const entry: SshTunnel = {
      ...prev,
      ...input,
      id: input.id || crypto.randomUUID(),
      bindHost: input.bindHost?.trim() || prev?.bindHost || '127.0.0.1',
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    this.store.set(
      'sshTunnels',
      prev ? tunnels.map((t) => (t.id === entry.id ? entry : t)) : [...tunnels, entry]
    )
    return this.listSshTunnels()
  }

  deleteSshTunnel(id: string): SshTunnel[] {
    this.store.set(
      'sshTunnels',
      this.store.get('sshTunnels').filter((t) => t.id !== id)
    )
    return this.listSshTunnels()
  }

  // ---------- 主机密钥指纹（known_hosts，TOFU 校验） ----------
  listSshKnownHosts(): SshKnownHost[] {
    return this.store.get('sshKnownHosts')
  }

  /** 记录主机密钥指纹（同 host:port 存在则覆盖 —— 供「重置后重连」重新信任） */
  recordSshKnownHost(entry: SshKnownHost): void {
    const list = this.store
      .get('sshKnownHosts')
      .filter((k) => !(k.host === entry.host && k.port === entry.port))
    this.store.set('sshKnownHosts', [...list, entry])
  }

  /** 移除某主机的指纹记录（「重置主机指纹」；下次连接重新 TOFU 记录） */
  deleteSshKnownHost(host: string, port: number): void {
    this.store.set(
      'sshKnownHosts',
      this.store.get('sshKnownHosts').filter((k) => !(k.host === host && k.port === port))
    )
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
      // 旧记录兜底：编辑页保存只带草稿字段，groupId 等未带字段继承旧记录
      ...prev,
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
  /**
   * 上次打开的笔记目录与文件（重启后恢复）。
   * 字段是后加的，老存档里没有 → 缺省返回空会话；
   * 旧格式（folder 单值 / 只打开单个文件）读取时迁移成 folders 数组。
   */
  getNoteSession(): NoteSession {
    const raw = this.store.get('noteSession') as
      | { folders?: unknown; files?: unknown; folder?: unknown }
      | undefined
    if (!raw) return { folders: [], files: [] }
    const folders = Array.isArray(raw.folders)
      ? raw.folders.filter((f): f is string => typeof f === 'string' && f.length > 0)
      : typeof raw.folder === 'string' && raw.folder
        ? [raw.folder]
        : []
    return {
      folders,
      files: Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === 'string') : []
    }
  }

  /**
   * 保存笔记会话：只覆盖传入的部分（folders 或 files）。
   * ⚠️ 必须用 `'x' in patch` 判断（同 saveAgentConversation），不能用 ?? 合并 ——
   * 关掉最后一个目录 / 关掉全部标签时要能显式存回空数组，否则清不掉。
   */
  saveNoteSession(patch: { folders?: string[]; files?: string[] }): NoteSession {
    const next = this.getNoteSession()
    if ('folders' in patch) next.folders = patch.folders ?? []
    if ('files' in patch) next.files = patch.files ?? []
    this.store.set('noteSession', next)
    return next
  }

  listNotes (): NoteEntry[] {
    return this.store.get('notes')
  }

  /** 保存笔记（upsert）：不传 id 视为新增，默认语言 markdown */
  saveNote(input: NoteEntry): NoteEntry[] {
    const notes = this.store.get('notes')
    const now = Date.now()
    const prev = input.id ? notes.find((n) => n.id === input.id) : undefined
    const entry: NoteEntry = {
      // 先铺旧记录再铺入参：编辑页保存只带草稿字段（标题 / 正文 / 语言），
      // groupId 等元数据必须继承，否则一保存就掉出分组
      ...prev,
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

  /**
   * 批量把本地文件导入成笔记：每个文件一篇 Markdown 笔记，追加到列表末尾。
   *
   * 为什么不复用 saveNote：saveNote 的 upsert 语义（id 为空即新建）不回传新建的 id，
   * 而导入后要立刻打开第一篇，所以这里显式生成 id 并返回。
   */
  importNotes(items: { title: string; content: string }[]): {
    notes: NoteEntry[]
    createdIds: string[]
  } {
    const now = Date.now()
    const created: NoteEntry[] = items.map((item, i) => ({
      id: crypto.randomUUID(),
      title: item.title,
      content: item.content,
      language: 'markdown',
      createdAt: now + i,
      updatedAt: now + i
    }))
    const next = [...this.store.get('notes'), ...created]
    this.store.set('notes', next)
    return { notes: next, createdIds: created.map((n) => n.id) }
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
      // 旧记录兜底：编辑页保存只带草稿字段，groupId 等未带字段继承旧记录
      ...prev,
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
      /** 旧版单 ACP 配置（v0.1 时代），迁移为预定义列表 */
      acpAgent?: { command: string; args: string[] }
      /** 旧版全局 Agent 后端开关（早已迁移为按工作区），迁移时清掉 */
      agentBackend?: string
    }
    const { autoApprove, acpAgent: legacyAcp, agentBackend: _legacyBackend, ...rest } = stored
    // 旧字段 `activeAcpId`（默认 ACP 预置）已随架构调整移除（ACP 绑定在会话创建时确定）
    delete (rest as { activeAcpId?: string }).activeAcpId
    const permissionMode: AiPermissionMode =
      rest.permissionMode ?? (autoApprove === false ? 'confirm' : 'full')
    const settings: AiSettings = { ...DEFAULT_AI_SETTINGS, ...rest, permissionMode }
    // 迁移旧版单 ACP 配置（acpAgent）为预定义列表，并写回存储只迁移一次
    if (legacyAcp?.command && !settings.acpAgents?.length) {
      settings.acpAgents = [
        {
          id: crypto.randomUUID(),
          name: '外部 ACP agent',
          command: legacyAcp.command,
          args: legacyAcp.args ?? []
        }
      ]
      this.store.set('aiSettings', settings)
    }
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

  // ---------- 技能（启停 / 额外根目录） ----------

  getSkillSettings(): SkillSettings {
    const saved = this.store.get('skillSettings')
    // 旧版本 / 手改过的配置文件可能缺字段：读的时候兜一下，别让 UI 拿到 undefined
    return {
      disabled: Array.isArray(saved?.disabled) ? saved.disabled.filter((v) => typeof v === 'string') : [],
      extraDirs: Array.isArray(saved?.extraDirs) ? saved.extraDirs.filter((v) => typeof v === 'string') : []
    }
  }

  saveSkillSettings(settings: Partial<SkillSettings>): SkillSettings {
    const next: SkillSettings = { ...this.getSkillSettings(), ...settings }
    next.disabled = [...new Set(next.disabled)]
    next.extraDirs = [...new Set(next.extraDirs)]
    this.store.set('skillSettings', next)
    return next
  }

  // ---------- Agent 工作区 ----------
  listAgentWorkspaces(): AgentWorkspace[] {
    return this.store.get('agentWorkspaces')
  }

  getAgentWorkspace(id: string): AgentWorkspace | undefined {
    return this.store.get('agentWorkspaces').find((w) => w.id === id)
  }

  /**
   * 保存工作区（upsert）；相同 path 视为同一工作区，改名即更新。
   *
   * ⚠️ **`path` 也要跟着改**：这个函数是「重命名」与「换个目录」**共同的落点**
   * （编辑对话框两者都能改，见 `AgentPanel` 的工作区编辑弹窗），而目录被删 / 被移走之后，
   * 用户唯一的出路就是把工作区指到新位置 —— 原先更新分支只改 `name`，
   * 路径改动被**静默丢掉**（用户改完、界面没变、也没有任何提示）。
   */
  saveAgentWorkspace(input: {
    id?: string
    name: string
    path: string
  }): AgentWorkspace[] {
    const workspaces = this.store.get('agentWorkspaces')
    const now = Date.now()
    const byPath = workspaces.find((w) => w.path === input.path)
    const prev = input.id ? workspaces.find((w) => w.id === input.id) : undefined
    const target = byPath ?? prev
    if (!target) {
      const next = [
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
    const renamed = workspaces.map((w) =>
      w === target
        ? { ...w, name: input.name.trim() || w.name, path: input.path, updatedAt: now }
        : w
    )
    /**
     * 换了目录 → **旧目录的结论作废**，顺手把 `dirMissing` 清掉。
     *
     * 不清的话侧栏要顶着一个过期的红图标等下一轮巡检（最多 30s）才恢复，
     * 看起来就像「改路径根本没生效」。这与巡检自己发现「目录已恢复」是同一件事，
     * 只是这里不用等 —— 用户刚刚亲手指定了一个新目录。
     * 复用 `applyDirMissing`（它负责「本来就正常就返回原数组」），别在这里再写一遍判断。
     */
    const next =
      target.path === input.path ? renamed : applyDirMissing(renamed, target.id, false)
    this.store.set('agentWorkspaces', next)
    return next
  }

  deleteAgentWorkspace(id: string): AgentWorkspace[] {
    const next = this.store.get('agentWorkspaces').filter((w) => w.id !== id)
    this.store.set('agentWorkspaces', next)
    // 工作区没了，它的会话也一并清掉，避免留下永远看不到的孤儿数据
    conversationStore.deleteByWorkspace(id)
    return next
  }

  /**
   * 写「目录不在了」这个标记（**只由巡检调用**，见 `services/ai/workspace-health.ts`）。
   * 返回**是否真的翻转了** —— 没变就别写：本 store 每次 `set` 都要全量读盘 + AJV 校验，
   * 30s 一轮的巡检若每次都无脑写，等于凭空给自己加了一份周期性磁盘开销。
   *
   * 「什么算变化」的三条语义（幂等 / 不动 `updatedAt` / 恢复时删字段）**全在
   * `applyDirMissing` 里**，这里只负责把结果落盘 —— 一份实现，免得存储层与巡检各判一套。
   */
  markAgentWorkspaceDirMissing(id: string, missing: boolean): boolean {
    const workspaces = this.store.get('agentWorkspaces')
    const next = applyDirMissing(workspaces, id, missing)
    // 引用不变 = 没变化（见 applyDirMissing 的约定），这一下就是「省掉一次全量落盘」的全部
    if (next === workspaces) return false
    this.store.set('agentWorkspaces', next)
    return true
  }

  // ---------- Agent 会话（独立文件存储，见 services/conversation-store.ts） ----------
  /**
   * 全部会话。
   *
   * 这里只是转发 —— 会话**不在**本 store 里（它的体量占了原配置文件的 97%，
   * 而 conf 每次 get/set 都要全量读盘 + AJV 校验，放这儿会把主进程拖垮），
   * 详见 `conversation-store.ts` 顶部的说明。
   */
  listAgentConversations(): AgentConversation[] {
    return conversationStore.list()
  }

  /**
   * 按 id 取单条会话。
   *
   * `agent:chat` 每次提问都要拿会话形态（kind），**必须走这个而不是 list 一遍再 find**
   * —— 会话文件加起来有几 MB，为了读一个 kind 把所有会话读进来是纯浪费。
   */
  getAgentConversation(id: string): AgentConversation | undefined {
    return conversationStore.get(id)
  }

  /** 保存会话（upsert）：不传 id 视为新建；返回保存后的单个会话 */
  saveAgentConversation(input: SaveConversationInput): AgentConversation {
    return conversationStore.save(input)
  }

  deleteAgentConversation(id: string): void {
    conversationStore.delete(id)
  }

  /**
   * **从此签出（分支）**：复制某条会话成一条新会话，原会话不动。
   * 返回 undefined = 不能分支（不存在 / 是 ACP 会话，消息在 agent 那边）。
   */
  forkAgentConversation(id: string, upToMessageId?: string): AgentConversation | undefined {
    return conversationStore.fork(id, upToMessageId)
  }

  /**
   * 设置 / 清除会话的上下文摘要检查点（**手动压缩的落库口**）。
   *
   * `null` = 清除，回到全文历史。原始消息一条不动，所以清除是无损、可逆的。
   * 会话不存在时返回 undefined（调用方据此报「会话不存在」）。
   */
  setAgentContextSummary(
    id: string,
    summary: ConversationContextSummary | null
  ): AgentConversation | undefined {
    return conversationStore.setContextSummary(id, summary)
  }

  // ---------- 终端 AI 助手会话（独立文件目录，见 conversation-store.ts 的 terminalConversationStore） ----------
  /**
   * 终端助手的会话与工作区会话**物理分目录**（`terminal-conversations/`）：
   * 「终端会话不入 AI Agent 列表」由存储边界保证，不依赖每个消费方记得过滤。
   */
  listTerminalConversations(): AgentConversation[] {
    return terminalConversationStore.list()
  }

  getTerminalConversation(id: string): AgentConversation | undefined {
    return terminalConversationStore.get(id)
  }

  saveTerminalConversation(input: SaveConversationInput): AgentConversation {
    return terminalConversationStore.save({ ...input, scope: 'terminal' })
  }

  deleteTerminalConversation(id: string): void {
    terminalConversationStore.delete(id)
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
