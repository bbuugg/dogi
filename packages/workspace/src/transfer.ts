/**
 * 数据导入 / 导出：把「接口请求 / 主机 / 脚本」整理成可移植的 JSON，或把 JSON 导回库里。
 *
 * 照搬 dogi 的 `src/main/services/transfer/index.ts`，但**换成纯函数**：这里只算
 * 「导出成什么」与「导入后数据变成什么」，真正落盘由 `AgentDomain` 调 `store.mutate`。
 * 好处是每条规则都能脱离 Electron / 文件系统单独验（见 `scripts/verify-transfer.mjs`）。
 *
 * ## 格式与 dogi 逐字段一致
 *
 * 外壳是 `{ version: 1, kind, exportedAt, groups, items }`，`kind` 名沿用 dogi 的
 * `hosts` / `api`（fizz 没有笔记，另加了 `scripts`）。所以 **dogi 导出的 `api.json`
 * 能直接导进来**，fizz 导出的包也能被 dogi 读回去。
 *
 * ## 两条硬规则（同 dogi）
 *
 * 1. **不导出凭据**。SSH 的密码 / 私钥 / 口令在服务端是加密落盘的、绑本机密钥
 *    （`SecretBox`），拷到别的机器解不开；`listSshHosts()` 给的本来就是脱敏视图
 *    （只有 `has*` 标记），所以导出天然不带 —— 导入后需要重新填。
 *    唯一的例外是**本机终端**配置：它本来就没有凭据。
 * 2. **导入按 id 覆盖**（upsert）。同一份数据导回来能真正恢复，而不是产生一堆重复项；
 *    覆盖前会统计「新增 / 覆盖 / 跳过」的条数回报给界面。
 *
 * ## 导入时的收敛（宁可丢一条，不写脏数据）
 *
 * 导入包是**用户给的文件**（可能是 dogi 的、手改的、甚至别的软件的），所以每条都当
 * 不可信输入：缺 `id` / 缺关键字段的条目跳过并计入 `skipped`（不中断整批）；
 * `groupId` 指向本次没导入的分组时**摘掉悬挂引用**（界面按「未分组」显示），
 * 而不是留一个指不到东西的 id。
 */
import type {
  ApiBodyType,
  ApiGroup,
  ApiHeaderPair,
  ApiProtocol,
  ApiRequestEntry,
  HostConfig,
  HostGroup,
  ScriptEntry,
  ScriptGroup,
  SshAuthType,
  SshCharset,
  TransferKind,
  TransferPayload
} from '@fizz/contracts/types'
import type { CoreData, StoredHost, StoredLocalHost, StoredSshHost } from './store'

/** 类型 → 包里的文件名（dogi 同款名字；`kind` 与文件名的对应关系是导入时的判据之一） */
export const FILE_OF: Record<TransferKind, string> = {
  hosts: 'hosts.json',
  api: 'api.json',
  scripts: 'scripts.json'
}

/** 三类数据的显示名（界面文案与错误信息共用一份） */
export const KIND_LABEL: Record<TransferKind, string> = {
  hosts: '主机',
  api: '接口请求',
  scripts: '脚本'
}

/** 文件名 → 类型（只认这三个名字，其它文件在 zip 里被忽略） */
const KIND_OF: Record<string, TransferKind> = Object.fromEntries(
  Object.entries(FILE_OF).map(([kind, file]) => [file, kind as TransferKind])
)

/** 认一下文件名对应哪一类；认不出返回 null（zip 里无关文件直接忽略） */
export function kindOfFile(fileName: string): TransferKind | null {
  return KIND_OF[fileName] ?? null
}

/** 全部类型（界面「全选」与默认勾选） */
export const ALL_TRANSFER_KINDS: TransferKind[] = ['api', 'hosts', 'scripts']

// ---------------------------------------------------------------------------
// 导出：把库里的数据整理成「干净」的可移植结构
// ---------------------------------------------------------------------------

/**
 * 导出时读的数据快照。
 *
 * 刻意让调用方（`AgentDomain`）用**已有的 list\* 方法**喂进来，而不是这里直接读
 * `CoreData`：主机那几条 list 方法顺手做了脱敏（`toSshView` / `toHostView`），
 * 这里再实现一遍「哪些字段不能出去」就等于把同一条安全规则写了两份。
 */
export interface TransferSnapshot {
  hosts: HostConfig[]
  hostGroups: HostGroup[]
  apiRequests: ApiRequestEntry[]
  apiGroups: ApiGroup[]
  scripts: ScriptEntry[]
  scriptGroups: ScriptGroup[]
}

/** 分组的可移植形状：只留 id / name / parentId / createdAt */
interface PortableGroup {
  id: string
  name: string
  parentId?: string
  createdAt: number
}

function groupOut(g: { id: string; name: string; parentId?: string; createdAt: number }): PortableGroup {
  return {
    id: g.id,
    name: g.name,
    ...(g.parentId ? { parentId: g.parentId } : {}),
    createdAt: g.createdAt
  }
}

/**
 * 主机的可移植形状：**只带连接元数据**。
 *
 * `hasPassword` / `hasPrivateKey` / `hasPassphrase` 一律不导出 —— 那是「本机存没存过」
 * 的派生标记，跟着包跑到别的机器上只会误导（那边必然没有），所以不带出去。
 * 本机终端（`kind: 'local'`）没有凭据，字段原样带走。
 */
function hostOut(h: HostConfig): Record<string, unknown> {
  if (h.kind === 'local') {
    return {
      id: h.id,
      kind: 'local',
      name: h.name,
      ...(h.shellId ? { shellId: h.shellId } : {}),
      ...(h.shellName ? { shellName: h.shellName } : {}),
      ...(h.args?.length ? { args: h.args } : {}),
      // 工作目录是这条终端自己的配置（与项目无关），随包往返
      ...(h.cwd ? { cwd: h.cwd } : {}),
      ...(h.autoCommand ? { autoCommand: h.autoCommand } : {}),
      // 归属分组要带出去，否则「导出 → 导入」回来主机全掉进未分组
      ...(h.groupId ? { groupId: h.groupId } : {}),
      createdAt: h.createdAt,
      updatedAt: h.updatedAt
    }
  }
  return {
    id: h.id,
    kind: 'ssh',
    name: h.name,
    host: h.host,
    port: h.port,
    username: h.username,
    authType: h.authType,
    // 跳板链属于拓扑信息（非凭据），随包导出，导入后连接方式保持一致
    ...(h.jumpHostId ? { jumpHostId: h.jumpHostId } : {}),
    ...(h.charset ? { charset: h.charset } : {}),
    ...(h.keepaliveInterval !== undefined ? { keepaliveInterval: h.keepaliveInterval } : {}),
    ...(h.groupId ? { groupId: h.groupId } : {}),
    createdAt: h.createdAt,
    updatedAt: h.updatedAt
  }
}

/**
 * 接口请求的可移植形状。
 *
 * 请求体形态与两张表单一起带走：只导正文等于把 `form-data` 请求导成空 raw
 * （同 dogi 的注释）。`rejectUnauthorized` 是「显式 false 才代表不校验」，
 * 缺省才代表正常校验 —— 原样带过去，别写死 true。
 */
function apiOut(r: ApiRequestEntry): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    method: r.method,
    url: r.url,
    headers: r.headers ?? [],
    body: r.body ?? '',
    ...(r.bodyType ? { bodyType: r.bodyType } : {}),
    ...(r.bodyUrlencoded ? { bodyUrlencoded: r.bodyUrlencoded } : {}),
    ...(r.bodyFormFields ? { bodyFormFields: r.bodyFormFields } : {}),
    ...(r.protocol ? { protocol: r.protocol } : {}),
    ...(r.subprotocols ? { subprotocols: r.subprotocols } : {}),
    ...(r.rejectUnauthorized !== undefined ? { rejectUnauthorized: r.rejectUnauthorized } : {}),
    ...(r.groupId ? { groupId: r.groupId } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

/** 脚本的可移植形状 */
function scriptOut(s: ScriptEntry): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    content: s.content ?? '',
    ...(s.description ? { description: s.description } : {}),
    ...(s.groupId ? { groupId: s.groupId } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  }
}

/** 组装某一类数据的导出内容（返回 payload + 条目数，条目数给界面报「导出了几条」） */
export function buildTransferPayload(
  kind: TransferKind,
  snap: TransferSnapshot
): { payload: TransferPayload; itemCount: number } {
  let groups: unknown[]
  let items: unknown[]
  switch (kind) {
    case 'hosts':
      // 主机分组（SSH 主机与本机终端共用，多级）。dogi 那边 `hosts.json` 的 groups 恒空，
      // 我们是超集：它导出的包照样能进（`groups` 为空 = 全部落未分组）。
      groups = snap.hostGroups.map(groupOut)
      items = snap.hosts.map(hostOut)
      break
    case 'api':
      groups = snap.apiGroups.map(groupOut)
      items = snap.apiRequests.map(apiOut)
      break
    case 'scripts':
      groups = snap.scriptGroups.map(groupOut)
      items = snap.scripts.map(scriptOut)
      break
  }
  return {
    payload: { version: 1, kind, exportedAt: Date.now(), groups, items },
    itemCount: items.length
  }
}

// ---------------------------------------------------------------------------
// 导入：校验 + 收敛
// ---------------------------------------------------------------------------

/**
 * 结构校验：不合法就抛给调用方当错误提示，宁可拒绝也不写脏数据。
 *
 * `kind` 必须与文件名对得上 —— 这条同时挡住了「把 hosts.json 改名成 api.json」这类
 * 误操作（内容与名字不符，写进去就是一堆解不开的条目）。
 *
 * 只用于 **zip 里的条目**：那里文件名是导出方写死的，对不上就是真的坏了。
 * 用户单独选一个 JSON 文件时走 `parseTransferDocument`（文件名不可信，见那边的注释）。
 */
export function parseTransferPayload(fileName: string, raw: string): { kind: TransferKind; payload: TransferPayload } {
  const kind = kindOfFile(fileName)
  if (!kind) throw new Error(`无法识别的文件：${fileName}（需要 ${Object.values(FILE_OF).join(' / ')}）`)
  const parsed = validateShape(fileName, raw)
  if (parsed.kind !== kind) {
    throw new Error(`${fileName} 的内容类型与文件名不符（文件里写的是 ${parsed.kind}）`)
  }
  return parsed
}

/**
 * 解析一份**单独的 JSON**：类型从内容里的 `kind` 读，不认文件名。
 *
 * 与 `parseTransferPayload` 分开是必要的：用户从 dogi 的 zip 里把 `api.json` 解出来、
 * 顺手改名成 `我的接口.json` 是完全正常的用法，按文件名认会白白拒掉。zip 里则相反 ——
 * 文件名是导出方写的，必须与内容对得上。
 */
export function parseTransferDocument(
  fileName: string,
  raw: string
): { kind: TransferKind; payload: TransferPayload } {
  return validateShape(fileName, raw)
}

/** 两份解析共用的形状校验：版本 / kind 取值 / groups+items 是数组 */
function validateShape(fileName: string, raw: string): { kind: TransferKind; payload: TransferPayload } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`${fileName} 不是有效的 JSON`)
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${fileName} 不是一个对象`)
  }
  const obj = json as Partial<TransferPayload>
  const kind = obj.kind
  if (kind !== 'hosts' && kind !== 'api' && kind !== 'scripts') {
    throw new Error(`${fileName} 不认识的数据类型：${String(kind)}`)
  }
  if (obj.version !== 1) throw new Error(`${fileName} 的数据版本不受支持（${String(obj.version)}）`)
  if (!Array.isArray(obj.groups) || !Array.isArray(obj.items)) {
    throw new Error(`${fileName} 结构不完整（缺少 groups / items）`)
  }
  return { kind, payload: obj as TransferPayload }
}

// ---------- 逐类收敛（不可信输入 → 能安全落盘的记录）----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 分组收敛：只认有 id 与非空 name 的 */
function pickGroup(raw: unknown): PortableGroup | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  const name = str(raw.name)
  if (!id || !name) return null
  return { id, name, parentId: str(raw.parentId), createdAt: num(raw.createdAt, Date.now()) }
}

const API_BODY_TYPES: ApiBodyType[] = ['none', 'raw', 'x-www-form-urlencoded', 'form-data']
const API_PROTOCOLS: ApiProtocol[] = ['http', 'ws']

/**
 * 键值对收敛：丢掉两栏都空的占位行（导出包里常有 `{ key: '', value: '' }`）。
 * `enabled` 只在原数据显式带了布尔值时才带过来 —— 缺省即启用，
 * 不无中生有写字段（写上去会让导出包凭空多出一堆 `enabled: true`）。
 */
function pickPairs(raw: unknown): ApiHeaderPair[] {
  if (!Array.isArray(raw)) return []
  const out: ApiHeaderPair[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const key = typeof item.key === 'string' ? item.key : ''
    const value = typeof item.value === 'string' ? item.value : ''
    if (!key && !value) continue
    out.push({
      key,
      value,
      ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {})
    })
  }
  return out
}

/** 表单字段收敛（比键值对多一个 `isFile` / `enabled`） */
function pickFormFields(raw: unknown): ApiRequestEntry['bodyFormFields'] {
  if (!Array.isArray(raw)) return []
  const out: NonNullable<ApiRequestEntry['bodyFormFields']> = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const key = typeof item.key === 'string' ? item.key : ''
    const value = typeof item.value === 'string' ? item.value : ''
    if (!key && !value) continue
    out.push({
      key,
      value,
      ...(item.isFile ? { isFile: true } : {}),
      ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {})
    })
  }
  return out
}

/**
 * 接口请求收敛。**必须有 id 与 url** —— 没有 url 的请求导进来点了也是白点，
 * 不如跳过并报数（同 dogi 的 `pickItem`）。
 *
 * ## `protocol` 里的 `https` 要落到 url 上
 *
 * dogi 的 `protocol` 兼作「url 没写协议头时补哪个」的提示，取值有 `'https'`；
 * 而 fizz 的 `ApiProtocol` 只有 `'http' | 'ws'`，协议归 url 自己带
 * （服务端 `withProtocol`：没有协议头就补 `http://`）。
 *
 * 所以 `protocol: 'https'` + 无协议头的 url 必须在**导入时**把 `https://` 补进 url ——
 * 否则这几条会被悄悄降级成 http（实测桌面上那份 dogi 导出里就有 2 条这种）。
 */
function pickApiItem(raw: unknown): ApiRequestEntry | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  const rawUrl = str(raw.url)
  if (!id || !rawUrl) return null

  const now = Date.now()
  const headers = pickPairs(raw.headers)
  const bodyType = API_BODY_TYPES.includes(raw.bodyType as ApiBodyType)
    ? (raw.bodyType as ApiBodyType)
    : undefined
  const protocol = API_PROTOCOLS.includes(raw.protocol as ApiProtocol)
    ? (raw.protocol as ApiProtocol)
    : undefined
  const subprotocols = Array.isArray(raw.subprotocols)
    ? raw.subprotocols.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : undefined
  const urlencoded = pickPairs(raw.bodyUrlencoded)
  const formFields = pickFormFields(raw.bodyFormFields)

  const schemeHint = typeof raw.protocol === 'string' ? raw.protocol.toLowerCase() : ''
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)
  const url = schemeHint === 'https' && !hasScheme ? `https://${rawUrl}` : rawUrl

  return {
    id,
    name: str(raw.name) ?? `${str(raw.method) ?? 'GET'} ${url}`,
    method: (str(raw.method) ?? 'GET').toUpperCase(),
    url,
    headers,
    body: typeof raw.body === 'string' ? raw.body : '',
    ...(bodyType ? { bodyType } : {}),
    ...(urlencoded.length ? { bodyUrlencoded: urlencoded } : {}),
    ...(formFields?.length ? { bodyFormFields: formFields } : {}),
    ...(protocol ? { protocol } : {}),
    ...(subprotocols?.length ? { subprotocols } : {}),
    // 「显式 false 才是不校验」—— 只有真的带了布尔值才写回去，缺省保持缺省
    ...(typeof raw.rejectUnauthorized === 'boolean'
      ? { rejectUnauthorized: raw.rejectUnauthorized }
      : {}),
    groupId: str(raw.groupId),
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now)
  }
}

/** 脚本收敛：必须有 id 与 name */
function pickScriptItem(raw: unknown): ScriptEntry | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  const name = str(raw.name)
  if (!id || !name) return null
  const now = Date.now()
  return {
    id,
    name,
    content: typeof raw.content === 'string' ? raw.content : '',
    ...(str(raw.description) ? { description: str(raw.description)! } : {}),
    groupId: str(raw.groupId),
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now)
  }
}

const SSH_AUTH_TYPES: SshAuthType[] = ['password', 'privateKey']
const SSH_CHARSETS: SshCharset[] = ['utf-8', 'gbk']

/**
 * 主机收敛：必须有 id 与 name；SSH 条目还必须有 host + username。
 *
 * 凭据**一律不带**（导出时就没带）—— 覆盖已有条目时也不能把人家本机存着的
 * 密码 / 私钥抹掉，所以下面 upsert 是「在旧记录上覆盖可移植字段」。
 *
 * 枚举与端口**逐项校验而不是硬 cast**：导入包是用户给的文件，`authType: "whatever"`
 * 直接塞进库里，界面那一栏会渲染成空白、`resolveSshHost` 也会拿着不认识的取值往下走。
 * 判据与 `saveSshHostEntry` 的归一化保持一致（端口 1~65535，否则回 22）。
 */
function pickHostItem(raw: unknown): StoredHost | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  const name = str(raw.name)
  if (!id || !name) return null
  const now = Date.now()

  if (raw.kind === 'local') {
    const args = Array.isArray(raw.args)
      ? raw.args.filter((a): a is string => typeof a === 'string' && a.length > 0)
      : []
    const local: StoredLocalHost = {
      id,
      kind: 'local',
      name,
      ...(str(raw.shellId) ? { shellId: str(raw.shellId)! } : {}),
      ...(str(raw.shellName) ? { shellName: str(raw.shellName)! } : {}),
      ...(args.length ? { args } : {}),
      // 工作目录是这条终端自己的配置（与项目无关），跟着配置一起导出 / 导入
      ...(str(raw.cwd) ? { cwd: str(raw.cwd)! } : {}),
      ...(str(raw.autoCommand) ? { autoCommand: str(raw.autoCommand)! } : {}),
      ...(str(raw.groupId) ? { groupId: str(raw.groupId)! } : {}),
      createdAt: num(raw.createdAt, now),
      updatedAt: num(raw.updatedAt, now)
    }
    return local
  }

  const host = str(raw.host)
  const username = str(raw.username)
  if (!host || !username) return null

  const port = num(raw.port, 22)
  const ssh: StoredSshHost = {
    id,
    name,
    host,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
    username,
    authType: SSH_AUTH_TYPES.includes(raw.authType as SshAuthType)
      ? (raw.authType as SshAuthType)
      : 'password',
    ...(str(raw.jumpHostId) ? { jumpHostId: str(raw.jumpHostId)! } : {}),
    ...(SSH_CHARSETS.includes(raw.charset as SshCharset) ? { charset: raw.charset as SshCharset } : {}),
    ...(typeof raw.keepaliveInterval === 'number' && Number.isFinite(raw.keepaliveInterval) && raw.keepaliveInterval >= 0
      ? { keepaliveInterval: Math.floor(raw.keepaliveInterval) }
      : {}),
    ...(str(raw.groupId) ? { groupId: str(raw.groupId)! } : {}),
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now)
  }
  return ssh
}

// ---------- 应用：算「导入后数据变成什么」（纯函数，不落盘）----------

export interface TransferPatch {
  /** 要写回 store 的字段补丁（只含本次真正动到的键） */
  patch: Partial<CoreData>
  added: number
  updated: number
  skipped: number
}

/**
 * 把一份 payload 应用到当前数据上，返回「新的数据 + 增删改统计」。
 *
 * 顺序是**先分组后条目**：条目里的 `groupId` 才指得到东西（同 dogi）。
 * 分组/条目都按 id upsert；`existing` 是导入前的 id 集合，用来分辨「新增」还是「覆盖」。
 */
export function applyTransferPayload(
  kind: TransferKind,
  payload: TransferPayload,
  data: CoreData
): TransferPatch {
  if (kind === 'hosts') return applyHosts(payload, data)
  if (kind === 'api') return applyApi(payload, data)
  return applyScripts(payload, data)
}

/**
 * 主机：先分组后条目，逐个 upsert；跳板引用指向不存在的条目时摘掉。
 *
 * 分组与 `applyApi` 同一套规则（多级、`parentId` 一起覆盖、父分组不在时降级为顶级），
 * 差别只在返回的补丁键是 `hostGroups`。dogi 的 `hosts.json` 不带分组（`groups` 为空），
 * 导进来就是「一台主机都没分组」，照样能用。
 */
function applyHosts(payload: TransferPayload, data: CoreData): TransferPatch {
  const groups = [...data.hostGroups]
  const groupIds = new Set(groups.map((g) => g.id))
  for (const raw of payload.groups) {
    const g = pickGroup(raw)
    if (!g) continue
    groupIds.add(g.id)
    const idx = groups.findIndex((x) => x.id === g.id)
    if (idx >= 0) {
      groups[idx] = {
        ...groups[idx],
        name: g.name,
        ...(g.parentId ? { parentId: g.parentId } : { parentId: undefined }),
        createdAt: groups[idx].createdAt
      }
    } else {
      groups.push({
        id: g.id,
        name: g.name,
        ...(g.parentId ? { parentId: g.parentId } : {}),
        createdAt: g.createdAt
      })
    }
  }
  // 父分组：必须在（本次导入后的）分组集合里，且不能指向自己
  for (let i = 0; i < groups.length; i++) {
    const parentId = groups[i].parentId
    if (parentId && (!groupIds.has(parentId) || parentId === groups[i].id)) {
      const { parentId: _drop, ...rest } = groups[i]
      groups[i] = rest
    }
  }

  const existing = new Set(data.sshHosts.map((h) => h.id))
  const incoming: StoredHost[] = []
  let skipped = 0

  for (const raw of payload.items) {
    const item = pickHostItem(raw)
    if (!item) {
      skipped++
      continue
    }
    // 悬挂引用：分组没跟着一起导入（且库里也没有）时按「未分组」处理
    if (item.groupId && !groupIds.has(item.groupId)) item.groupId = undefined
    incoming.push(item)
  }

  // 本次能落地的 id 集合（已有的 + 新来的），跳板只能指向这个集合里的条目
  const known = new Set([...existing, ...incoming.map((h) => h.id)])
  let added = 0
  let updated = 0
  const next = [...data.sshHosts]

  for (const item of incoming) {
    // 跳板指向不存在（或本机终端）的条目时摘掉，不留悬空引用
    if (item.kind !== 'local' && item.jumpHostId) {
      const jump = next.find((h) => h.id === item.jumpHostId)
      if (!jump || jump.kind === 'local' || !known.has(item.jumpHostId) || item.jumpHostId === item.id) {
        delete item.jumpHostId
      }
    }
    const idx = next.findIndex((h) => h.id === item.id)
    if (idx >= 0) {
      const prev = next[idx]
      // 覆盖可移植字段，但**保留本机的凭据密文**（导入包本来就不带凭据）
      next[idx] = mergeStoredHost(prev, item)
      updated++
    } else {
      next.push(item)
      added++
    }
  }

  return { patch: { hostGroups: groups, sshHosts: next }, added, updated, skipped }
}

/** 覆盖时保留旧记录的凭据密文与 createdAt；本机 / SSH 两种形态不互相覆盖（kind 变了就整体换） */
function mergeStoredHost(prev: StoredHost, incoming: StoredHost): StoredHost {
  if (prev.kind === 'local' || incoming.kind === 'local') {
    return { ...incoming, createdAt: prev.createdAt }
  }
  return {
    ...incoming,
    createdAt: prev.createdAt,
    ...(prev.password ? { password: prev.password } : {}),
    ...(prev.privateKey ? { privateKey: prev.privateKey } : {}),
    ...(prev.passphrase ? { passphrase: prev.passphrase } : {})
  }
}

/**
 * 接口请求：先分组后条目；分组支持多级（父分组不在时降级为顶级，不留悬空 parentId）
 *
 * ⚠️ 分组**要连 `parentId` 一起覆盖**，不能只改名字：本项目的导出是带层级的，
 * 只改名字会让「导出 → 导入」在多级分组上对不上（dogi 的导出压根不带 parentId，
 * 所以它那边没这个问题；我们是超集，就得自己保证往返一致）。
 * `createdAt` 则保留本地的 —— 那是「这条分组什么时候建的」，不该被导入包改写。
 */
function applyApi(payload: TransferPayload, data: CoreData): TransferPatch {
  const groups = [...data.apiGroups]
  const groupIds = new Set(groups.map((g) => g.id))
  for (const raw of payload.groups) {
    const g = pickGroup(raw)
    if (!g) continue
    groupIds.add(g.id)
    const idx = groups.findIndex((x) => x.id === g.id)
    if (idx >= 0) {
      groups[idx] = {
        ...groups[idx],
        name: g.name,
        ...(g.parentId ? { parentId: g.parentId } : { parentId: undefined }),
        createdAt: groups[idx].createdAt
      }
    } else {
      groups.push({ id: g.id, name: g.name, ...(g.parentId ? { parentId: g.parentId } : {}), createdAt: g.createdAt })
    }
  }
  // 父分组：必须在（本次导入后的）分组集合里，且不能指向自己
  for (let i = 0; i < groups.length; i++) {
    const parentId = groups[i].parentId
    if (parentId && (!groupIds.has(parentId) || parentId === groups[i].id)) {
      const { parentId: _drop, ...rest } = groups[i]
      groups[i] = rest
    }
  }

  const requests = [...data.apiRequests]
  let added = 0
  let updated = 0
  let skipped = 0

  for (const raw of payload.items) {
    const item = pickApiItem(raw)
    if (!item) {
      skipped++
      continue
    }
    // 悬挂引用：分组没跟着一起导入（且库里也没有）时按「未分组」处理
    if (item.groupId && !groupIds.has(item.groupId)) item.groupId = undefined
    const idx = requests.findIndex((r) => r.id === item.id)
    if (idx >= 0) {
      requests[idx] = { ...requests[idx], ...item }
      updated++
    } else {
      requests.push(item)
      added++
    }
  }
  return { patch: { apiGroups: groups, apiRequests: requests }, added, updated, skipped }
}

/** 脚本：分组只有一层；未分组脚本由渲染端恒排在最前 */
function applyScripts(payload: TransferPayload, data: CoreData): TransferPatch {
  const groups = [...data.scriptGroups]
  const groupIds = new Set(groups.map((g) => g.id))
  for (const raw of payload.groups) {
    const g = pickGroup(raw)
    if (!g) continue
    groupIds.add(g.id)
    const idx = groups.findIndex((x) => x.id === g.id)
    if (idx >= 0) groups[idx] = { ...groups[idx], name: g.name }
    else groups.push({ id: g.id, name: g.name, createdAt: g.createdAt })
  }

  const scripts = [...data.scripts]
  let added = 0
  let updated = 0
  let skipped = 0

  for (const raw of payload.items) {
    const item = pickScriptItem(raw)
    if (!item) {
      skipped++
      continue
    }
    if (item.groupId && !groupIds.has(item.groupId)) item.groupId = undefined
    const idx = scripts.findIndex((s) => s.id === item.id)
    if (idx >= 0) {
      scripts[idx] = { ...scripts[idx], ...item }
      updated++
    } else {
      scripts.push(item)
      added++
    }
  }

  return { patch: { scriptGroups: groups, scripts }, added, updated, skipped }
}
