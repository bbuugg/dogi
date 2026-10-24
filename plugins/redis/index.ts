/**
 * Redis 客户端 —— **从 dogi 项目 `plugins/redis-client`（main.js）迁移**，并按 Fizz 的
 * 插件界面机制重做形态。
 *
 * ## 它长什么样
 *
 * | 位置 | 内容 |
 * | --- | --- |
 * | 左侧图标栏 | 「Redis」一颗 |
 * | **侧栏** | **连接管理器**：列出所有连接（含状态）、新增 / 编辑 / 删除 / 连接 / 断开 |
 * | **主视图区标签页** | 每个连接一个「Key 浏览」页（侧栏里点连接就开出来） |
 *
 * 「一个连接一个标签」靠 `ctx.ui.view` 的**参数**（`params: { conn }`）实现：同一个面
 * 用不同参数开出多屏，宿主把参数原样带回 `render` / `onAction`（见 SKILL.md 3.5）。
 *
 * ## 连接存在哪（⚠️ 密码是明文）
 *
 * 存在**插件自己目录**下的 `.redis-connections.json`（`~/.fizz/plugins/`）。
 *
 * 为什么不是「设置项」：设置项是**插件声明的、一份固定的表单**，而连接是用户随时增删改的
 * **一组条目**（数量不定），塞不进那种形态。框架目前也**没有** `ctx.storage` 之类的
 * 持久化服务，所以这里由插件自己写文件 —— 若以后加了 `ctx.storage`，这一处应迁过去。
 *
 * ⚠️ 因此**密码以明文落盘**（设置项那种 SecretBox 加密用不上）。这是本机自用工具的取舍，
 * 但要心里有数：不要把生产库的高权限账号填进来。
 *
 * ## 客户端实现：来自 dogi
 *
 * `RedisClient` 与 RESP 编解码沿用 dogi 那份（它只用 `node:net` / `node:tls`，零依赖 ——
 * 用户级插件目录没有 node_modules，npm 的 redis 包在那儿解析不到）。
 */
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// RESP2 客户端（来自 dogi：命令串行 + 增量解析，尽量小）
// ---------------------------------------------------------------------------

const INCOMPLETE = Symbol('incomplete')

/** 把命令参数编成 RESP 数组帧 */
function encodeCommand(args: (string | Buffer)[]): Buffer {
  // 显式标成 `Buffer[]`：Node 的 Buffer 带了 `ArrayBufferLike` 泛型，不标的话数组会被
  // 推断成 `Buffer<ArrayBuffer>[]`，而入参里的 Buffer 是 `Buffer<ArrayBufferLike>`（装不进去）
  const frames: Buffer[] = [Buffer.from(`*${args.length}\r\n`)]
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8')
    frames.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'))
  }
  return Buffer.concat(frames)
}

class RedisClient {
  private readonly cfg: RedisTarget
  private socket: { write: (b: Buffer) => void; destroy: () => void } | null = null
  private buf = Buffer.alloc(0)
  private pending: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null
  private chain: Promise<unknown> = Promise.resolve()
  /** 是我们自己关的吗（用来区分「主动断开」与「被对端断掉」） */
  private selfClose = false
  connected = false
  currentDb: number
  error: Error | null = null
  /** 不是我们关的、那次断开的原因（侧栏的状态徽章要把它说出来） */
  droppedReason: string | null = null

  constructor(cfg: RedisTarget) {
    this.cfg = cfg
    this.currentDb = cfg.db
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { host, port, username, password, db, tls, timeoutMs } = this.cfg
      const opts = { host: host || '127.0.0.1', port: port || 6379, timeout: timeoutMs || 10000 }
      const sock = tls ? tlsConnect({ ...opts, rejectUnauthorized: false }) : netConnect(opts)
      this.socket = sock as unknown as { write: (b: Buffer) => void; destroy: () => void }
      ;(sock as unknown as { setKeepAlive: (v: boolean) => void }).setKeepAlive(true)
      ;(sock as unknown as { setNoDelay: (v: boolean) => void }).setNoDelay(true)

      let done = false
      sock.on('error', (err: Error) => {
        this.error = err
        this.connected = false
        if (!done) {
          done = true
          reject(new Error(`连接失败：${err.message}`))
        }
      })
      sock.once('connect', () => {
        // 认证：优先 ACL(username password)，其次仅 password
        const args: string[] = []
        if (username) args.push('AUTH', username, password ?? '')
        else if (password) args.push('AUTH', password)
        args.push('PING')
        this.connected = true
        this.command(...args)
          .then(async () => {
            if (this.currentDb > 0) await this.command('SELECT', String(db))
            done = true
            resolve()
          })
          .catch((e: Error) => {
            this.connected = false
            if (!done) {
              done = true
              this.close()
              reject(e)
            }
          })
      })
      sock.on('data', (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk])
        if (this.connected) this.flush()
      })
      sock.on('close', () => {
        this.connected = false
        // 只有「不是我们主动关的」才算掉线：原因要显示给用户（对端重启 / 网络断了）
        if (!this.selfClose) {
          this.droppedReason = this.error?.message || '连接被对端关闭'
        }
      })
    })
  }

  /** 进队执行一条命令（严格串行：一次只允许一个在途命令） */
  command(...args: string[]): Promise<unknown> {
    const run = () => this.send(args)
    const res = this.chain.then(run, run)
    this.chain = res.catch(() => undefined)
    return res
  }

  private send(args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) return reject(new Error('连接已断开'))
      this.pending = { resolve, reject }
      try {
        this.socket.write(encodeCommand(args))
      } catch (e) {
        this.pending = null
        reject(new Error(`写入失败：${(e as Error).message}`))
      }
      this.flush()
    })
  }

  private parse(at: number): { val: unknown; next: number } | typeof INCOMPLETE {
    const nl = this.buf.indexOf('\r\n', at)
    if (nl < 0) return INCOMPLETE
    const head = this.buf.toString('utf8', at, nl)
    const after = nl + 2
    switch (head[0]) {
      case '+':
        return { val: { _simple: head.slice(1) }, next: after }
      case '-':
        return { val: { _error: head.slice(1) }, next: after }
      case ':':
        return { val: parseInt(head.slice(1), 10), next: after }
      case '$': {
        const len = parseInt(head.slice(1), 10)
        if (len === -1) return { val: null, next: after }
        if (this.buf.length < after + len + 2) return INCOMPLETE
        return { val: this.buf.subarray(after, after + len), next: after + len + 2 }
      }
      case '*': {
        const count = parseInt(head.slice(1), 10)
        if (count === -1) return { val: null, next: after }
        if (count > 5_000_000) throw new Error('回复数组过长，疑似异常')
        const arr: unknown[] = []
        let cur = after
        for (let i = 0; i < count; i++) {
          const r = this.parse(cur)
          if (r === INCOMPLETE) return INCOMPLETE
          arr.push(r.val ?? null)
          cur = r.next
        }
        return { val: arr, next: cur }
      }
      default:
        throw new Error(`未知 RESP 类型：${head[0]}`)
    }
  }

  private flush(): void {
    while (this.pending) {
      let r: { val: unknown; next: number } | typeof INCOMPLETE
      try {
        r = this.parse(0)
      } catch (e) {
        const p = this.pending
        this.pending = null
        this.connected = false
        this.close()
        p.reject(e as Error)
        return
      }
      if (r === INCOMPLETE) break
      this.buf = this.buf.subarray(r.next)
      const p = this.pending
      this.pending = null
      const val = r.val as { _error?: string; _simple?: string } | null
      if (val && val._error) p.reject(new Error(val._error))
      else if (val && val._simple) p.resolve(val._simple)
      else p.resolve(r.val)
    }
  }

  close(): void {
    this.selfClose = true
    this.connected = false
    if (this.pending) {
      this.pending.reject(new Error('连接已关闭'))
      this.pending = null
    }
    try {
      this.socket?.destroy()
    } catch {
      /* 已关就算了 */
    }
    this.socket = null
  }
}

// ---------------------------------------------------------------------------
// 值处理 / 格式化（同样来自 dogi）
// ---------------------------------------------------------------------------

/** 是不是「非法 UTF-8」的二进制值 */
function isBinaryBuf(buf: unknown): boolean {
  if (!Buffer.isBuffer(buf)) return false
  return !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
}

/** Buffer → 人可读文本；二进制的给出 hex（这样界面上不会糊成一团乱码） */
function textVal(buf: unknown): string {
  if (buf == null) return ''
  if (!Buffer.isBuffer(buf)) return String(buf)
  return isBinaryBuf(buf) ? buf.toString('hex') : buf.toString('utf8')
}

/**
 * 解析 `INFO` 文本：`# 小节` + `key:value`。小节键统一**小写**（Redis 里是 `# Server`
 * 这种首字母大写），否则查 `sections.server` 取不到值。
 */
function parseInfo(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let cur = 'misc'
  const ensure = (name: string): Record<string, string> => {
    const key = String(name || 'misc').trim().toLowerCase() || 'misc'
    if (!sections[key]) sections[key] = {}
    return sections[key]
  }
  for (const line of String(text || '').split('\n')) {
    const l = line.trim()
    if (!l) continue
    if (l.startsWith('#')) {
      cur = l.slice(1).trim()
      ensure(cur)
      continue
    }
    const i = l.indexOf(':')
    if (i < 0) continue
    ensure(cur)[l.slice(0, i)] = l.slice(i + 1)
  }
  return sections
}

function fmtBytes(n: number | null): string {
  if (n == null) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function fmtUptime(sec: unknown): string {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return '-'
  const d = Math.floor(n / 86400)
  const h = Math.floor((n % 86400) / 3600)
  const m = Math.floor((n % 3600) / 60)
  return d > 0 ? `${d}天 ${h}小时` : h > 0 ? `${h}小时 ${m}分` : `${m}分`
}

function ttlLabel(ttl: unknown): string {
  const t = Number(ttl)
  if (!Number.isFinite(t)) return '-'
  if (t === -1) return '永不过期'
  if (t === -2) return '不存在'
  if (t < 60) return `${t}s`
  if (t < 3600) return `${Math.floor(t / 60)}m ${t % 60}s`
  if (t < 86400) return `${Math.floor(t / 3600)}h ${Math.floor((t % 3600) / 60)}m`
  return `${Math.floor(t / 86400)}d`
}

// ---------------------------------------------------------------------------
// 连接数据（持久化到插件自己目录下的 JSON）
// ---------------------------------------------------------------------------

interface RedisTarget {
  host: string
  port: number
  username: string
  password: string
  db: number
  tls: boolean
  /** 连接超时（毫秒，dogi 默认 10000） */
  timeoutMs: number
}

/** 一条连接配置（用户可在侧栏里增删改） */
interface Conn extends RedisTarget {
  id: string
  name: string
  /** Key 浏览页打开时的 MATCH 表达式（界面上还能改，改了以界面上的为准） */
  pattern?: string
}

/**
 * jiti 通常把插件转成 **CJS** 执行，那时模块里会有 `__filename`（实测就是插件文件的真实
 * 路径）。ESM 形态下没有这个绑定 —— `typeof` 对未声明的标识符**不抛错**，所以下面的
 * 判空在两种形态下都安全。
 *
 * 顺带记一笔反直觉的事实：`import.meta.url` 在 jiti 下是 `data:text/javascript;base64,…`
 * （jiti 用 eval 跑模块），喂给 `fileURLToPath` 会抛 `The URL must be of scheme file` ——
 * 而它是**模块级**表达式，一抛就是整个插件加载失败。所以这里不碰它。
 */
declare const __filename: string | undefined

/**
 * 连接文件的位置：**插件自己旁边**（真机上就是 `~/.fizz/plugins/.redis-connections.json`）。
 *
 * 兜底顺序：`__filename` → 用户级插件目录。写得啰嗦是因为「插件在哪」这件事在 jiti 下
 * 没有唯一可靠的问法（见上面那段实测）。
 */
const DATA_FILE = ((): string => {
  const dirs: string[] = []
  if (typeof __filename === 'string' && __filename) dirs.push(dirname(__filename))
  dirs.push(join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.fizz', 'plugins'))
  return join(dirs[0], '.redis-connections.json')
})()

let conns: Conn[] | null = null
/** 各连接的客户端（按 id；配置变了就丢弃重建） */
const clients = new Map<string, { client: RedisClient; key: string }>()
/** 各连接最近一次出错的原因（侧栏的状态徽章显示它） */
const errors = new Map<string, string>()

/**
 * 一个连接的管理面板状态（对齐 dogi：一个连接 = 一个面板，内部再分「数据 / 信息 / 命令行」）。
 *
 * 全是**每连接独立**的：两个连接各开一个标签页，各自的模式、过滤词、点开的 key、命令行
 * 输出互不干扰（宿主靠 `params.conn` 区分，插件靠这张表区分）。
 */
interface Browse {
  keys: { key: string; type: string; binary: boolean }[]
  cursor: number
  done: boolean
  pattern: string
  opened: string | null
  pendingDelete: string | null
  /** 面板当前哪一屏：数据 / 信息 / 命令行 */
  mode: 'data' | 'info' | 'cli'
  /** 删集合条目的模式：开着时点一行 = 删它（没有「确认弹窗」形态，就做成两步） */
  entryDelete: boolean
  /** 命令行输出：最新在前，封顶 50 条（dogi 同款） */
  log: { ok: boolean; text: string }[]
  /** 「信息」屏的过滤词 */
  infoFilter: string
  /** 「信息」屏是否看原始文本（否则看分节概览） */
  infoRaw: boolean
}
const browsing = new Map<string, Browse>()

function browseOf(conn: Conn): Browse {
  let state = browsing.get(conn.id)
  if (!state) {
    state = {
      keys: [],
      cursor: 0,
      done: false,
      pattern: conn.pattern?.trim() || '*',
      opened: null,
      pendingDelete: null,
      mode: 'data',
      entryDelete: false,
      log: [],
      infoFilter: '',
      infoRaw: false
    }
    browsing.set(conn.id, state)
  }
  return state
}

/** 命令行里「会改动数据」的命令：命中就在执行后自动刷新（dogi 同款白名单） */
const WRITE_CMD =
  /^(SET|DEL|HSET|HDEL|LPUSH|RPUSH|LSET|LREM|SADD|SREM|ZADD|ZREM|EXPIRE|PERSIST|RENAME)$/i

/** 命令行分词（支持引号包起来的带空格参数） */
function tokenize(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** 切 DB（并把「最后用的 DB」记回连接配置，dogi 同款） */
async function selectDb(conn: Conn, db: number): Promise<void> {
  await withConn(conn, (c) => c.command('SELECT', String(db)))
  conn.db = db
  await saveConns()
}

/** 命令行：跑一条，把结果记进输出日志 */
async function execCommand(conn: Conn, line: string): Promise<void> {
  const state = browseOf(conn)
  const args = tokenize(line.trim())
  if (!args.length) return
  const cmd = args[0].toUpperCase()
  const write = WRITE_CMD.test(cmd)
  try {
    const value = await withConn(conn, (c) => c.command(...args))
    state.log.unshift({ ok: true, text: `$ ${args.join(' ')}\n${stringifyReply(value)}` })
    // 写命令之后列表已经变了 —— 自动拉一遍（dogi 也是这么做的）
    if (write) {
      await scanKeys(conn, true)
      if (state.opened) {
        // 当前 key 被删了 / 结构变了：回到列表，免得停在一个不存在的值上
        const still = state.keys.find((k) => k.key === state.opened)
        if (!still) state.opened = null
      }
    }
  } catch (e) {
    state.log.unshift({
      ok: false,
      text: `$ ${args.join(' ')}\n(error) ${e instanceof Error ? e.message : String(e)}`
    })
  }
  if (state.log.length > 50) state.log.length = 50
}

/** 把任意回复画成一行文字（命令行输出用） */
function stringifyReply(value: unknown): string {
  if (value == null) return '(nil)'
  if (Array.isArray(value)) {
    if (!value.length) return '(empty array)'
    return value
      .map((item, i) => `${String(i + 1)}) ${Buffer.isBuffer(item) ? textVal(item) : String(item)}`)
      .join('\n')
  }
  if (Buffer.isBuffer(value)) return textVal(value)
  if (typeof value === 'object') {
    const v = value as { _simple?: string; _error?: string }
    if (v._simple) return v._simple
    if (v._error) return `(error) ${v._error}`
    return JSON.stringify(value)
  }
  return String(value)
}

async function loadConns(): Promise<Conn[]> {
  if (conns) return conns
  try {
    const text = await readFile(DATA_FILE, 'utf8')
    const parsed = JSON.parse(text)
    conns = Array.isArray(parsed)
      ? parsed
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map((item) => normalizeConn(item))
      : []
  } catch {
    // 没有文件 / 文件坏了 = 「还没有连接」，不是错误
    conns = []
  }
  return conns
}

/** 从任意对象读出一条连接（落盘的东西也当不可信输入：只留认识的字段、类型收敛） */
function normalizeConn(raw: Record<string, unknown>): Conn {
  const str = (v: unknown, fallback = ''): string =>
    typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : fallback
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    id: str(raw.id) || randomUUID(),
    name: str(raw.name) || '未命名连接',
    host: str(raw.host, '127.0.0.1'),
    port: num(raw.port, 6379),
    username: str(raw.username),
    password: str(raw.password),
    db: num(raw.db, 0),
    // 弹窗里给的是字符串（'true' / 'false'），落盘的也可能是布尔 —— 两种都认
    tls: raw.tls === true || raw.tls === 'true',
    timeoutMs: num(raw.timeoutMs, 10000),
    ...(str(raw.pattern) ? { pattern: str(raw.pattern) } : {})
  }
}

async function saveConns(): Promise<void> {
  if (!conns) return
  const text = JSON.stringify(conns, null, 2)
  try {
    await writeFile(DATA_FILE, text, 'utf8')
  } catch (err) {
    throw new Error(`连接写不进 ${DATA_FILE}：${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// 连接与命令
// ---------------------------------------------------------------------------

/** 配置的指纹：变了就重连 */
function keyOf(conn: Conn): string {
  return JSON.stringify([conn.host, conn.port, conn.username, conn.password, conn.db, conn.tls])
}

async function clientFor(conn: Conn): Promise<RedisClient> {
  const key = keyOf(conn)
  const held = clients.get(conn.id)
  if (held && held.key === key && held.client.connected) return held.client
  if (held) held.client.close()
  const client = new RedisClient(conn)
  await client.connect()
  clients.set(conn.id, { client, key })
  errors.delete(conn.id)
  return client
}

/**
 * 跑一批命令；**只有连接真的断了**才记进状态徽章。
 *
 * 这里踩过一次：早先任何命令报错都记进 `errors`，于是「改名的目标 key 已存在」这种
 * **应用级**错误也会让侧栏显示「出错」—— 连接其实好好的。判据是「客户端还连着吗」：
 * `-ERR …` 这类回复不会断开连接，socket 出错 / 解析失败才会（`connected` 变 false）。
 */
async function withConn<T>(conn: Conn, run: (c: RedisClient) => Promise<T>): Promise<T> {
  const client = await clientFor(conn)
  try {
    return await run(client)
  }   catch (e) {
    // ⚠️ 只有**连接真的断了**才关它：Redis 的 `-ERR …` 回复（如「目标 key 已存在」）
    // 是应用级报错，连接还是好的 —— 早先一律 `close()`，于是改个名失败就把连接关了，
    // 侧栏徽章也跟着变成「未连接」（其实它一点事都没有）。
    if (!client.connected) {
      client.close()
      clients.delete(conn.id)
      errors.set(conn.id, e instanceof Error ? e.message : String(e))
    }
    throw e
  }
}

async function scanKeys(conn: Conn, reset: boolean): Promise<void> {
  const state = browseOf(conn)
  await withConn(conn, async (c) => {
    const res = (await c.command(
      'SCAN',
      String(reset ? 0 : state.cursor),
      'MATCH',
      state.pattern || '*',
      'COUNT',
      '200'
    )) as unknown[]
    const next = Number(textVal(res?.[0])) || 0
    const raw = Array.isArray(res?.[1]) ? (res[1] as unknown[]) : []
    if (reset) state.keys = []
    /**
     * 已收录的 key 名 —— **必须判重**。
     *
     * ⚠️ Redis 的 `SCAN` 文档明确写着「同一个元素可能被返回多次」（它只保证
     * 「遍历开始时就存在的元素至少返回一次」，不保证恰好一次）；而「继续加载」
     * 又是往**同一个数组**追加的。不判重的话列表里会出现两条同 key 的项，
     * 界面上按 `id: item.key` 做 React 列表标识 → 直接报
     * `Encountered two children with the same key`，还可能丢项 / 重复渲染。
     *
     * 顺带也省掉重复项的 `TYPE` 往返（每条 key 都要问一次类型）。
     */
    const seen = new Set(state.keys.map((item) => item.key))
    for (const k of raw) {
      // 非法 UTF-8 的 key 名会被整体 hex 化，那**不是**真 key（拿它去 GET/DEL 只会落空）——
      // 标出来，界面上这一项就不带点击动作，免得点一个永远取不到数据的死条目。
      const binary = isBinaryBuf(k)
      const name = textVal(k)
      if (seen.has(name)) continue
      seen.add(name)
      let type = 'unknown'
      try {
        type = textVal(await c.command('TYPE', k as string))
      } catch {
        /* 类型取不到就留 unknown */
      }
      state.keys.push({ key: name, type, binary })
    }
    state.cursor = next
    state.done = next === 0
  })
}

// ---------------------------------------------------------------------------
// 界面：块
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>
type Args = Record<string, string | number | boolean>

const STATUS_TONE = { on: 'success', off: 'muted', bad: 'danger' } as const

function connStatus(conn: Conn): { label: string; tone: string } {
  const held = clients.get(conn.id)
  if (errors.has(conn.id)) return { label: `出错：${errors.get(conn.id)}`, tone: STATUS_TONE.bad }
  if (held?.client.connected) return { label: '已连接', tone: STATUS_TONE.on }
  // 连过又掉了：**把掉线原因说出来**（对端关的 / 网络断了）—— 只说「未连接」，
  // 用户看不出是「压根没连」还是「刚刚断了」。
  if (held?.client.droppedReason) {
    return { label: `已断开：${held.client.droppedReason}`, tone: STATUS_TONE.bad }
  }
  return { label: '未连接', tone: STATUS_TONE.off }
}

/**
 * 连接的字段（新增 / 编辑共用）。
 *
 * 这两个动作走**弹窗**（动作结果里返回 `openDialog`，由宿主用 shadcn Dialog 渲染），
 * 而不是面里的 `form` 块 —— 用户预期「新增 / 编辑一条配置」是弹个窗，不是侧栏换一屏。
 */
function connFields(conn: Conn | null) {
  return [
    { id: 'name', label: '名称', value: conn?.name ?? '', placeholder: '本机 Redis' },
    { id: 'host', label: '地址', value: conn?.host ?? '127.0.0.1', placeholder: '127.0.0.1' },
    { id: 'port', label: '端口', value: String(conn?.port ?? 6379), placeholder: '6379' },
    { id: 'username', label: '用户名（ACL，可空）', value: conn?.username ?? '' },
    { id: 'password', label: '密码（可空）', value: conn?.password ?? '', secret: true },
    { id: 'db', label: '数据库编号（0-15）', value: String(conn?.db ?? 0), placeholder: '0' },
    // 这两个是 dogi 连接表单里就有、这里补上的：TLS 走 `node:tls`，超时直接给 socket
    { id: 'tls', label: 'TLS：true / false', value: conn?.tls ? 'true' : 'false' },
    {
      id: 'timeoutMs',
      label: '连接超时（毫秒）',
      value: String(conn?.timeoutMs ?? 10000),
      placeholder: '10000'
    }
  ]
}

/**
 * 连接行的样子**对齐会话行**：名字 + 地址 + 状态徽章，行尾 hover 浮出「编辑 / 删除」
 * 两个图标按钮；点行本身 = 在主视图打开这个连接的管理面板。
 *
 * 没有「连接 / 断开」按钮 —— 连接是**用的时候自动建**的（打开面板、跑一条命令都会连），
 * 状态看徽章就够了；多一排按钮只会让人犹豫「要不要先点一下连接」。
 */
async function managerBlocks(): Promise<Block[]> {
  const list = await loadConns()
  const blocks: Block[] = []

  if (list.length === 0) {
    blocks.push({
      kind: 'note',
      text: '还没有连接 —— 点右上角的 + 加一个（连接存在插件目录的 .redis-connections.json，密码明文）。',
      tone: 'muted'
    })
  } else {
    blocks.push({
      kind: 'list',
      items: list.map((conn) => {
        const status = connStatus(conn)
        return {
          id: conn.id,
          label: conn.name,
          // 不显示 `host:port/db`：侧栏只有两百来像素宽，那串等宽字会把名字挤没，
          // 而地址信息在面板头（点开连接就能看到）—— 这里只留名字。
          // 徽章空间有限：出错原因很长就截断，完整的在面板里能看到
          badge: status.label.length > 14 ? `${status.label.slice(0, 14)}…` : status.label,
          tone: status.tone as 'success' | 'muted' | 'danger',
          actionId: 'openTab',
          args: { conn: conn.id },
          actions: [
            {
              actionId: 'edit',
              icon: 'pencil',
              label: `编辑「${conn.name}」`,
              args: { conn: conn.id }
            },
            {
              actionId: 'askDeleteConn',
              icon: 'trash',
              label: `删除「${conn.name}」`,
              args: { conn: conn.id },
              danger: true
            }
          ]
        }
      })
    })
  }

  // 「新增连接」不在这里了 —— 它是顶栏那颗加号（见 `headerActions`）
  return blocks
}

async function keyListBlocks(conn: Conn): Promise<Block[]> {
  const state = browseOf(conn)
  const blocks: Block[] = [
    {
      kind: 'input',
      id: 'pattern',
      label: '过滤',
      value: state.pattern || '*',
      placeholder: 'orders:*',
      actionId: 'filter',
      submitLabel: '过滤'
    },
    { kind: 'buttons', items: [{ actionId: 'refresh', label: '刷新' }] }
  ]
  try {
    if (state.keys.length === 0 && !state.done) await scanKeys(conn, true)
    if (state.keys.length === 0) {
      const err = errors.get(conn.id)
      blocks.push({
        kind: 'note',
        text: err ? `连不上或取不到：${err}` : '这个库里没有匹配到的 key。',
        tone: err ? 'danger' : 'muted'
      })
      return blocks
    }
    blocks.push({
      kind: 'list',
      label: `Key（已加载 ${state.keys.length}）`,
      items: state.keys.slice(0, 500).map((item) => ({
        id: item.key,
        label: item.key,
        detail: item.type,
        ...(item.binary
          ? { badge: '二进制名', tone: 'warn' as const }
          : { actionId: 'openKey', args: { key: item.key } })
      }))
    })
    if (!state.done) {
      blocks.push({ kind: 'buttons', items: [{ actionId: 'more', label: '再加载 200 个' }] })
    } else {
      // 扫完了才说「共 N 个」：没扫完时报数会让人以为是总数
      blocks.push({
        kind: 'note',
        text: `已扫完，共 ${state.keys.length} 个 key。`,
        tone: 'muted'
      })
    }
  } catch (e) {
    blocks.push({ kind: 'note', text: e instanceof Error ? e.message : String(e), tone: 'danger' })
  }
  return blocks
}

async function keyDetailBlocks(conn: Conn, key: string): Promise<Block[]> {
  const blocks: Block[] = []
  try {
    const info = await withConn(conn, async (c) => {
      const type = textVal(await c.command('TYPE', key))
      const ttl = Number(await c.command('TTL', key))
      return { type, ttl: Number.isFinite(ttl) ? ttl : -1 }
    })
    blocks.push({
      kind: 'kv',
      rows: [
        { label: 'key', value: key },
        { label: '类型', value: info.type },
        { label: 'TTL', value: ttlLabel(info.ttl) }
      ]
    })

    if (browseOf(conn).pendingDelete === key) {
      // 破坏性动作两步：没有确认弹框，就把「确认」做成第二次点击
      blocks.push({ kind: 'note', text: `确认删除「${key}」？这一步不可撤销。`, tone: 'danger' })
      blocks.push({
        kind: 'buttons',
        items: [
          { actionId: 'confirmDelete', label: '确认删除', args: { key } },
          { actionId: 'cancelDelete', label: '取消' }
        ]
      })
      return blocks
    }

    blocks.push(...(await valueBlocks(conn, key, info.type)))

    const actions: { actionId: string; label: string; args?: Args }[] = [
      { actionId: 'back', label: '返回列表' },
      { actionId: 'askDelete', label: '删除这个 key', args: { key } }
    ]
    // 只有集合类型有「条目」：string 是一整块、stream 只读（与 dogi 的 EDITABLE 同款）
    if (EDITABLE.has(info.type)) {
      actions.push(
        browseOf(conn).entryDelete
          ? { actionId: 'exitDeleteEntry', label: '退出「删条目」' }
          : { actionId: 'enterDeleteEntry', label: '删条目（点一行就删）' }
      )
    }
    blocks.push({ kind: 'buttons', items: actions })

    // TTL 预设（dogi 同款：1 分钟 / 10 分钟 / 1 小时 / 1 天 / 永不过期）
    blocks.push({
      kind: 'buttons',
      items: [
        { actionId: 'setTtl', label: 'TTL 1 分钟', args: { ttl: 60 } },
        { actionId: 'setTtl', label: '10 分钟', args: { ttl: 600 } },
        { actionId: 'setTtl', label: '1 小时', args: { ttl: 3600 } },
        { actionId: 'setTtl', label: '1 天', args: { ttl: 86400 } },
        { actionId: 'setTtl', label: '永不过期', args: { ttl: 0 } }
      ]
    })
    blocks.push({
      kind: 'input',
      id: 'newKey',
      label: '改名',
      value: key,
      actionId: 'rename',
      submitLabel: '改名'
    })
  } catch (e) {
    blocks.push({ kind: 'note', text: e instanceof Error ? e.message : String(e), tone: 'danger' })
    blocks.push({ kind: 'buttons', items: [{ actionId: 'back', label: '返回列表' }] })
  }
  return blocks
}

/** 取值封顶（与 dogi 的 `VCAP` 对齐）：误点开一个百万成员的 key 也不至于把界面拖死 */
const VCAP = 500

/** 能逐条改的类型（与 dogi 的 `EDITABLE` 同款：string 整体改、stream 只读） */
const EDITABLE = new Set(['hash', 'list', 'set', 'zset'])

/** 「只画了前 N 条」的提示（dogi 里 zset 漏了这个字段，这里每种类型都给） */
function truncatedNote(shown: number, total: number, unit: string): Block[] {
  if (total <= shown) return []
  return [
    {
      kind: 'note',
      text: `仅展示前 ${shown} ${unit}（共 ${total}）—— 剩下的用命令行查。`,
      tone: 'warn'
    }
  ]
}

/**
 * 集合类的一行（点它 = 改这一条；开着「删条目」模式时 = 删它）。
 *
 * 一行只能挂一个动作（块的语义如此），所以「编辑」与「删除」用**模式切换**分开：
 * 底部那颗「删条目」切过去后，同一个列表的每一行就变成删它 —— 与「删 key 两步确认」
 * 是同一个套路，不需要「确认弹窗」这种形态。
 */
function entryItems(
  entries: { id: string; label: string; detail?: string }[],
  deleting: boolean
): { id: string; label: string; detail?: string; actionId: string; args: Args }[] {
  return entries.map((item) => ({
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    id: item.id,
    label: item.label,
    actionId: deleting ? 'delEntry' : 'editEntry',
    args: { entry: item.id }
  }))
}

/** 按类型把值画成块：string 用 kv + 文本，集合类用可点的行 + 「新增」入口 */
async function valueBlocks(conn: Conn, key: string, type: string): Promise<Block[]> {
  const state = browseOf(conn)
  const deleting = state.entryDelete
  switch (type) {
    case 'string': {
      const buf = await withConn(conn, (c) => c.command('GET', key))
      const binary = isBinaryBuf(buf)
      const text = textVal(buf)
      return [
        {
          kind: 'kv',
          rows: [
            {
              label: '长度',
              value: fmtBytes(Buffer.isBuffer(buf) ? buf.length : String(buf ?? '').length)
            },
            { label: '编码', value: binary ? '二进制（HEX，只读）' : 'UTF-8', tone: binary ? 'warn' : 'normal' }
          ]
        },
        { kind: 'text', text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text, mono: true },
        // 二进制值不给编辑入口：写回去必然写坏数据（dogi 也是把编辑器设成只读）
        ...(binary
          ? []
          : [
              {
                kind: 'buttons',
                items: [{ actionId: 'editValue', label: '编辑这个值', args: { key } }]
              }
            ])
      ]
    }
    case 'hash': {
      const [flat, total] = await withConn(conn, async (c) => [
        (await c.command('HGETALL', key)) as unknown[],
        Number(await c.command('HLEN', key))
      ])
      const arr = Array.isArray(flat) ? flat : []
      const entries: { id: string; label: string; detail: string }[] = []
      for (let i = 0; i + 1 < arr.length && entries.length < VCAP; i += 2) {
        entries.push({ id: textVal(arr[i]), label: textVal(arr[i]), detail: textVal(arr[i + 1]) })
      }
      return [
        { kind: 'list', label: `字段（${entries.length}/${total}）`, items: entryItems(entries, deleting) },
        ...truncatedNote(entries.length, total, '个字段'),
        { kind: 'buttons', items: [{ actionId: 'addHashEntry', label: '新增 / 改字段' }] }
      ]
    }
    case 'list': {
      const [arr, total] = await withConn(conn, async (c) => [
        (await c.command('LRANGE', key, '0', String(VCAP - 1))) as unknown[],
        Number(await c.command('LLEN', key))
      ])
      const list = Array.isArray(arr) ? arr : []
      const entries = list.map((v, i) => ({
        id: String(i),
        label: `#${i}`,
        detail: textVal(v)
      }))
      return [
        { kind: 'list', label: `元素（${entries.length}/${total}）`, items: entryItems(entries, deleting) },
        ...truncatedNote(entries.length, total, '个元素'),
        { kind: 'buttons', items: [{ actionId: 'pushList', label: '推入一个元素' }] }
      ]
    }
    case 'set': {
      const [arr, total] = await withConn(conn, async (c) => [
        (await c.command('SMEMBERS', key)) as unknown[],
        Number(await c.command('SCARD', key))
      ])
      const members = (Array.isArray(arr) ? arr : []).slice(0, VCAP)
      const entries = members.map((v) => ({ id: textVal(v), label: textVal(v) }))
      return [
        { kind: 'list', label: `成员（${entries.length}/${total}）`, items: entryItems(entries, deleting) },
        ...truncatedNote(entries.length, total, '个成员'),
        { kind: 'buttons', items: [{ actionId: 'addSetEntry', label: '新增成员' }] }
      ]
    }
    case 'zset': {
      const [flat, total] = await withConn(conn, async (c) => [
        (await c.command('ZRANGE', key, '0', String(VCAP - 1), 'WITHSCORES')) as unknown[],
        Number(await c.command('ZCARD', key))
      ])
      const arr = Array.isArray(flat) ? flat : []
      const entries: { id: string; label: string; detail: string }[] = []
      for (let i = 0; i + 1 < arr.length && entries.length < VCAP; i += 2) {
        entries.push({ id: textVal(arr[i]), label: textVal(arr[i]), detail: textVal(arr[i + 1]) })
      }
      return [
        { kind: 'list', label: `成员（${entries.length}/${total}）`, items: entryItems(entries, deleting) },
        ...truncatedNote(entries.length, total, '个成员'),
        { kind: 'buttons', items: [{ actionId: 'addZsetEntry', label: '新增 / 改分数' }] }
      ]
    }
    case 'stream': {
      const [body, total] = await withConn(conn, async (c) => [
        (await c.command('XRANGE', key, '-', '+', 'COUNT', String(VCAP))) as unknown[],
        Number(await c.command('XLEN', key))
      ])
      // stream 只读（dogi 的 `EDITABLE` 里也没有它）：改它没有意义，只能追加
      const items = (Array.isArray(body) ? body : []).map((item) => {
        const pair = Array.isArray(item) ? item : []
        const fieldCount = Array.isArray(pair[1]) ? pair[1].length / 2 : 0
        return { id: textVal(pair[0]), label: textVal(pair[0]), detail: `${fieldCount} 个字段` }
      })
      return [
        { kind: 'list', label: `条目（${items.length}/${total}，只读）`, items },
        ...truncatedNote(items.length, total, '个条目')
      ]
    }
    default:
      return [{ kind: 'note', text: `这个类型（${type}）还没有做展示。`, tone: 'muted' }]
  }
}

// ---------------------------------------------------------------------------
// 面板：一个连接一屏，内部再分「数据 / 信息 / 命令行」（对齐 dogi 的右侧面板）
// ---------------------------------------------------------------------------

const MODE_LABEL = { data: '数据', info: '信息', cli: '命令行' } as const

/** INFO 小节的中文名（dogi 同款映射） */
const SECTION_LABEL: Record<string, string> = {
  server: '服务器',
  clients: '客户端',
  memory: '内存',
  persistence: '持久化',
  stats: '统计',
  replication: '复制',
  cpu: 'CPU',
  cluster: '集群',
  keyspace: '键空间',
  commandstats: '命令统计',
  latencystats: '延迟统计',
  errorstats: '错误统计',
  modules: '模块'
}

/** 面板顶部：连接信息 + 三屏切换 + DB 切换（DB 是**每连接**的，dogi 同款） */
function panelHeader(conn: Conn, state: Browse): Block[] {
  const status = connStatus(conn)
  return [
    {
      kind: 'kv',
      rows: [
        { label: '连接', value: conn.name },
        { label: '地址', value: `${conn.host}:${conn.port}` },
        { label: 'DB', value: `db${conn.db}` },
        {
          label: '状态',
          value: status.label,
          tone: status.tone as 'success' | 'muted' | 'danger'
        }
      ]
    },
    {
      kind: 'buttons',
      items: (['data', 'info', 'cli'] as const).map((m) => ({
        actionId: 'mode',
        // 当前这一屏用「·数据·」标出来：块没有「选中态」这个概念，只能在标签上写
        label: m === state.mode ? `·${MODE_LABEL[m]}·` : MODE_LABEL[m],
        args: { mode: m }
      }))
    },
    {
      kind: 'input',
      id: 'db',
      label: '切到 DB（0-15）',
      value: String(conn.db),
      placeholder: '0',
      actionId: 'setDb',
      submitLabel: '切换'
    }
  ]
}

/** 「信息」屏：概览指标 + 分节表（可过滤）/ 原始文本（可搜索），对齐 dogi */
async function infoBlocks(conn: Conn): Promise<Block[]> {
  const state = browseOf(conn)
  let raw: string
  let dbsize: number
  try {
    ;[raw, dbsize] = await withConn(conn, async (c) => [
      textVal(await c.command('INFO', 'ALL')),
      Number(await c.command('DBSIZE'))
    ])
  } catch (e) {
    return [{ kind: 'note', text: e instanceof Error ? e.message : String(e), tone: 'danger' }]
  }
  const filter = state.infoFilter.trim().toLowerCase()

  // 原始文本视图：按行过滤（dogi 的「搜索」）
  if (state.infoRaw) {
    const lines = raw.split('\n').filter((l) => !filter || l.toLowerCase().includes(filter))
    return [
      {
        kind: 'input',
        id: 'filter',
        label: '搜索原始文本',
        value: state.infoFilter,
        actionId: 'infoFilter',
        submitLabel: '过滤'
      },
      {
        kind: 'buttons',
        items: [
          { actionId: 'infoToggle', label: '看分节概览' },
          { actionId: 'infoRefresh', label: '刷新' }
        ]
      },
      { kind: 'text', text: lines.slice(0, 300).join('\n') || '(没有匹配的行)', mono: true }
    ]
  }

  const sections = parseInfo(raw)
  const server = sections.server ?? {}
  const clients = sections.clients ?? {}
  const memory = sections.memory ?? {}
  const stats = sections.stats ?? {}
  const hits = Number(stats.keyspace_hits ?? 0)
  const misses = Number(stats.keyspace_misses ?? 0)
  const rate = hits + misses > 0 ? `${((hits / (hits + misses)) * 100).toFixed(1)}%` : '-'

  const blocks: Block[] = [
    {
      kind: 'input',
      id: 'filter',
      label: '过滤参数名 / 值',
      value: state.infoFilter,
      actionId: 'infoFilter',
      submitLabel: '过滤'
    },
    {
      kind: 'buttons',
      items: [
        { actionId: 'infoToggle', label: '看原始文本' },
        { actionId: 'infoRefresh', label: '刷新' }
      ]
    },
    {
      kind: 'kv',
      rows: [
        { label: '版本', value: server.redis_version ?? '-' },
        { label: '运行时长', value: fmtUptime(server.uptime_in_seconds) },
        { label: '客户端连接', value: clients.connected_clients ?? '-' },
        {
          label: '内存占用',
          value: fmtBytes(
            Number.isFinite(Number(memory.used_memory)) ? Number(memory.used_memory) : NaN
          )
        },
        { label: '命中率', value: rate },
        { label: '累计命令', value: stats.total_commands_processed ?? '-' },
        { label: '当前 DB key 数', value: String(Number.isFinite(dbsize) ? dbsize : 0) }
      ]
    }
  ]
  for (const [name, rows] of Object.entries(sections)) {
    const items = Object.entries(rows)
      .filter(
        ([k, v]) => !filter || k.toLowerCase().includes(filter) || v.toLowerCase().includes(filter)
      )
      .map(([k, v]) => ({ id: `${name}:${k}`, label: k, detail: v }))
    if (!items.length) continue
    blocks.push({ kind: 'list', label: SECTION_LABEL[name] ?? name, items })
  }
  return blocks
}

/** 「命令行」屏：一条输入框 + 输出日志（最新在上，封顶 50） */
function cliBlocks(conn: Conn): Block[] {
  const state = browseOf(conn)
  return [
    {
      kind: 'input',
      id: 'cmd',
      label: '执行 Redis 命令',
      placeholder: 'GET user:1、TYPE orders:1、DBSIZE',
      actionId: 'exec',
      submitLabel: '执行'
    },
    {
      kind: 'note',
      text: '写命令（SET / DEL / HSET / …）执行后会自动刷新列表。',
      tone: 'muted'
    },
    ...state.log.map((entry) => ({
      kind: 'text',
      text: entry.text,
      tone: entry.ok ? ('normal' as const) : ('danger' as const),
      mono: true
    }))
  ]
}

/**
 * 集合条目按类型该发什么命令（改 / 删），以及弹窗长什么样。
 *
 * 「hash 两栏、list 一个值、zset 成员+分数」这些差异在这里只写一遍，动作处理那边
 * 就只剩「取出来 → 提交 → 跑」三步。返回 null 的类型不支持逐条改（string 整块改、
 * stream 只读）。
 */
function entryCommandOf(type: string): {
  fields: { id: string; label: string; multiline?: boolean }[]
  save: (c: RedisClient, key: string, entry: string, args: Args) => Promise<void>
  remove: (c: RedisClient, key: string, entry: string) => Promise<void>
} | null {
  switch (type) {
    case 'hash':
      return {
        fields: [
          { id: 'field', label: '字段' },
          { id: 'value', label: '值', multiline: true }
        ],
        save: async (c, key, entry, args) => {
          const field = String(args.field ?? entry).trim()
          if (!field) throw new Error('字段名不能为空')
          // 字段名被改了 → 先删旧的（HSET 只在同名字段上覆盖）
          if (field !== entry) await c.command('HDEL', key, entry)
          await c.command('HSET', key, field, String(args.value ?? ''))
        },
        remove: async (c, key, entry) => {
          await c.command('HDEL', key, entry)
        }
      }
    case 'list':
      return {
        fields: [{ id: 'value', label: '元素值', multiline: true }],
        save: async (c, key, entry, args) => {
          const index = Number(entry)
          if (!Number.isInteger(index) || index < 0) throw new Error('下标不对')
          await c.command('LSET', key, String(index), String(args.value ?? ''))
        },
        // Redis 没有「按下标删」，dogi 的写法：先 LSET 成一个随机哨兵，再 LREM 掉它
        remove: async (c, key, entry) => {
          const index = Number(entry)
          if (!Number.isInteger(index) || index < 0) throw new Error('下标不对')
          const sentinel = `__fizz_del_${randomUUID()}`
          await c.command('LSET', key, String(index), sentinel)
          await c.command('LREM', key, '1', sentinel)
        }
      }
    case 'set':
      return {
        fields: [{ id: 'member', label: '成员' }],
        save: async (c, key, entry, args) => {
          const member = String(args.member ?? entry).trim()
          if (!member) throw new Error('成员不能为空')
          if (member !== entry) await c.command('SREM', key, entry)
          await c.command('SADD', key, member)
        },
        remove: async (c, key, entry) => {
          await c.command('SREM', key, entry)
        }
      }
    case 'zset':
      return {
        fields: [
          { id: 'member', label: '成员' },
          { id: 'score', label: '分数' }
        ],
        save: async (c, key, entry, args) => {
          const member = String(args.member ?? entry).trim()
          const score = Number(args.score)
          if (!member) throw new Error('成员不能为空')
          if (!Number.isFinite(score)) throw new Error('分数要是数字')
          if (member !== entry) await c.command('ZREM', key, entry)
          await c.command('ZADD', key, String(score), member)
        },
        remove: async (c, key, entry) => {
          await c.command('ZREM', key, entry)
        }
      }
    default:
      return null
  }
}

/** 这个 key 现在是什么类型（每次现查：命令行可能刚改过它） */
async function typeOf(conn: Conn, key: string): Promise<string> {
  return withConn(conn, async (c) => textVal(await c.command('TYPE', key)))
}

/** 编辑弹窗里要带出的当前值（按类型取那一条） */
async function currentEntry(
  conn: Conn,
  type: string,
  key: string,
  entry: string
): Promise<Record<string, string>> {
  switch (type) {
    case 'hash':
      return {
        field: entry,
        value: textVal(await withConn(conn, (c) => c.command('HGET', key, entry)))
      }
    case 'list':
      return { value: textVal(await withConn(conn, (c) => c.command('LINDEX', key, entry))) }
    case 'set':
      return { member: entry }
    case 'zset':
      return {
        member: entry,
        score: textVal(await withConn(conn, (c) => c.command('ZSCORE', key, entry)))
      }
    default:
      return {}
  }
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

/**
 * 插件图标：**Redis 官方 logo**（Simple Icons 那份，`#FF4438` 品牌红，978 字符）。
 *
 * 早先是自己画的一个带深色圆角底的方块 —— 那种「衬底」在列表里会被别的图标挤成
 * 一小块色块，logo 本身的形状反而看不清。**直接用官方 logo、不加衬底**：矢量图在
 * 40px 下也清楚（`object-contain` 保证不变形）。
 */
const ICON =
  'data:image/svg+xml,%3Csvg%20fill%3D%22%23FF4438%22%20role%3D%22img%22%20viewBox%3D%220%200%2024%2024%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctitle%3ERedis%3C%2Ftitle%3E%3Cpath%20d%3D%22M22.71%2013.145c-1.66%202.092-3.452%204.483-7.038%204.483-3.203%200-4.397-2.825-4.48-5.12.701%201.484%202.073%202.685%204.214%202.63%204.117-.133%206.94-3.852%206.94-7.239%200-4.05-3.022-6.972-8.268-6.972-3.752%200-8.4%201.428-11.455%203.685C2.59%206.937%203.885%209.958%204.35%209.626c2.648-1.904%204.748-3.13%206.784-3.744C8.12%209.244.886%2017.05%200%2018.425c.1%201.261%201.66%204.648%202.424%204.648.232%200%20.431-.133.664-.365a100.49%20100.49%200%200%200%205.54-6.765c.222%203.104%201.748%206.898%206.014%206.898%203.819%200%207.604-2.756%209.33-8.965.2-.764-.73-1.361-1.261-.73zm-4.349-5.013c0%201.959-1.926%202.922-3.685%202.922-.941%200-1.664-.247-2.235-.568%201.051-1.592%202.092-3.225%203.21-4.973%201.972.334%202.71%201.43%202.71%202.619z%22%2F%3E%3C%2Fsvg%3E'

/**
 * 弹窗开着时是在编辑**哪一条**（模块级：插件模块在进程内缓存，所以能跨 render 保留）。
 *
 * 弹窗里的字段提交回来时只带字段值（`args`），不带「编辑的是谁」—— 所以这里记一笔：
 * 点「编辑」时写入，提交或取消时清掉。
 */
let editingId: string | null = null
/** 待确认删除的**连接**（两步：还没有「确认弹窗」这种形态，就把确认做成第二次点击） */
let pendingConnDelete: string | null = null

/**
 * `ctx.ui` 的结构化手写型（插件目录里不 import `@fizz/plugin` 的类型）。
 * 只声明本插件用到的那几个方法。
 */
interface UiLike {
  icon(dataUri: string): unknown
  activityBar(item: Record<string, unknown>): unknown
  sider(spec: {
    id: string
    title: string
    icon?: string
    /** 顶栏右侧那排图标按钮（宿主渲染成 SidebarTopBar 的 extra 槽位） */
    headerActions?: { actionId: string; icon: string; label: string; args?: Args }[]
    render: () => Block[] | Promise<Block[]>
    onAction?: (action: {
      actionId: string
      args?: Args
      /** 插件内部弹提示：宿主用 sonner 弹，随这次响应带回 */
      toast?: (message: string, kind?: 'success' | 'error' | 'info' | 'warning') => void
    }) => unknown
  }): unknown
  view(spec: {
    id: string
    title: string
    icon?: string
    render: (ctx: { params?: Args }) => Block[] | Promise<Block[]>
    onAction?: (action: {
      actionId: string
      args?: Args
      params?: Args
      toast?: (message: string, kind?: 'success' | 'error' | 'info' | 'warning') => void
    }) => unknown
  }): unknown
}

export default {
  name: 'Redis 客户端',
  inject: ['ui'],

  apply(ctx: { ui: UiLike }) {
    ctx.ui.icon(ICON)

    ctx.ui.activityBar({ id: 'home', title: 'Redis', icon: ICON, order: 10, opens: 'sider:home' })

    // ---------- 侧栏：连接管理器 ----------
    ctx.ui.sider({
      id: 'home',
      title: 'Redis 连接',
      /*
       * 顶栏右侧那排图标按钮（宿主渲染成 `SidebarTopBar` 的 extra 槽位，与 AI Agent
       * 侧栏的「刷新列表」同一处）：刷新连接状态 + 新增连接。
       * 原来「新增连接」是一颗占整行的文字按钮块，现在收成加号图标挪到顶栏。
       */
      headerActions: [
        { actionId: 'refresh', icon: 'refresh', label: '刷新' },
        { actionId: 'add', icon: 'plus', label: '新增连接' }
      ],
      render: async () => {
        const list = await loadConns()
        // 删连接走**对话框**（与新增 / 编辑同一条路）：纯确认框，没有字段
        return managerBlocks()
      },

      onAction: async ({ actionId, args, toast }) => {
        const list = await loadConns()
        const id = typeof args?.conn === 'string' ? args.conn : ''
        const conn = list.find((c) => c.id === id) ?? null

        switch (actionId) {
          case 'refresh':
            /*
             * 刷新连接状态：什么都不返回 = 宿主自己把这一面重新拉一遍（见
             * PluginSurfaceBody.runAction 的收尾分支）—— 每次 render 都会重新
             * `connStatus()` 探一遍各连接，所以「刷新」不需要额外做什么。
             */
            return
          case 'add':
            // 弹窗：请求宿主用 shadcn Dialog 收这几个字段，提交回 `saveAdd`
            return {
              openDialog: {
                title: '新增连接',
                description: '连接存在插件目录的 .redis-connections.json（密码是明文存的）。',
                fields: connFields(null),
                actionId: 'saveAdd',
                submitLabel: '保存'
              }
            }
          case 'edit':
            if (!conn) return
            editingId = conn.id
            return {
              openDialog: {
                title: `编辑「${conn.name}」`,
                fields: connFields(conn),
                actionId: 'saveEdit',
                submitLabel: '保存'
              }
            }
          case 'saveAdd': {
            const item = normalizeConn({ ...(args ?? {}), id: randomUUID() })
            list.push(item)
            await saveConns()
            // 插件内部直接 toast（宿主用 sonner 弹）；`message` 字段是它的 success 糖
            toast?.(`已新增「${item.name}」`, 'success')
            return
          }
          case 'saveEdit': {
            const target = list.find((c) => c.id === editingId) ?? null
            if (!target) return
            const next = normalizeConn({ ...target, ...(args ?? {}) })
            list[list.indexOf(target)] = next
            await saveConns()
            // 配置变了：丢掉旧连接，下次用新的
            clients.get(next.id)?.client.close()
            clients.delete(next.id)
            errors.delete(next.id)
            editingId = null
            return { message: `已保存「${next.name}」` }
          }
          case 'askDeleteConn':
            if (!conn) return
            /*
             * 记住要删的是谁：对话框提交只带**字段值**（这里是纯确认框，没有字段），
             * 不带 `conn`，所以归属由插件自己记着（`editingId` 同一条思路）。
             */
            pendingConnDelete = id
            return {
              openDialog: {
                title: `确认删除连接「${conn.name}」？`,
                description: '只删本地这条配置，不动 Redis 里的数据。这一步不可撤销。',
                fields: [],
                actionId: 'confirmDeleteConn',
                submitLabel: '删除'
              }
            }
            return
          case 'cancelDeleteConn':
            pendingConnDelete = null
            return
          case 'confirmDeleteConn': {
            if (!conn) return
            clients.get(conn.id)?.client.close()
            clients.delete(conn.id)
            errors.delete(conn.id)
            browsing.delete(conn.id)
            conns = list.filter((c) => c.id !== conn.id)
            await saveConns()
            editingId = null
            pendingConnDelete = null
            toast?.(`已删除连接「${conn.name}」`, 'success')
            // 它的管理页标签可能还开着：提示一句，免得用户对着一个「请选连接」发懵
            toast?.('如果它的管理页还开着，下次刷新会显示为空', 'info')
            return
          }
          case 'openTab':
            if (!conn) return
            // ⬇️ 请求宿主在主视图区开一个标签页：同一个 view 面 + `params.conn` 参数，
            //    所以每个连接各占一页（宿主会把参数原样带回下面的 render / onAction）
            return {
              openView: {
                surfaceId: 'panel',
                params: { conn: conn.id },
                label: conn.name,
                title: `${conn.name} · Redis 管理`
              }
            }
          default:
            return
        }
      }
    })

    // ---------- 标签页：某个连接的管理面板（数据 / 信息 / 命令行） ----------
    ctx.ui.view({
      id: 'panel',
      title: 'Redis 管理',
      render: async ({ params }) => {
        const list = await loadConns()
        const connId = typeof params?.conn === 'string' ? params.conn : ''
        const conn = list.find((c) => c.id === connId) ?? null
        if (!conn) {
          return [
            {
              kind: 'note',
              text: '请在左侧「Redis」侧栏里点一个连接 —— 这个标签页是按连接开的。',
              tone: 'muted'
            }
          ]
        }
        const state = browseOf(conn)
        const body =
          state.mode === 'info'
            ? await infoBlocks(conn)
            : state.mode === 'cli'
              ? cliBlocks(conn)
              : state.opened
                ? await keyDetailBlocks(conn, state.opened)
                : await keyListBlocks(conn)
        // 头（连接信息 + 三屏 + DB）永远在最上面：切屏时不用找回去
        return [...panelHeader(conn, state), ...body]
      },

      onAction: async ({ actionId, args, params }) => {
        const list = await loadConns()
        const conn =
          list.find((c) => c.id === (typeof params?.conn === 'string' ? params.conn : '')) ?? null
        if (!conn) return
        const state = browseOf(conn)
        // 条目类动作不带 key（改的是当前点开那个），所以回落到这里
        const key = typeof args?.key === 'string' ? args.key : (state.opened ?? '')

        switch (actionId) {
          // ---- 三屏 / DB ----
          case 'mode': {
            const m = String(args?.mode ?? 'data')
            state.mode = m === 'info' ? 'info' : m === 'cli' ? 'cli' : 'data'
            return
          }
          case 'setDb': {
            const db = Math.floor(Number(args?.db))
            if (!Number.isInteger(db) || db < 0 || db > 15) throw new Error('DB 要在 0–15 之间')
            await selectDb(conn, db)
            state.opened = null
            state.pendingDelete = null
            await scanKeys(conn, true)
            return { message: `已切到 db${db}` }
          }

          // ---- 命令行 ----
          case 'exec':
            await execCommand(conn, String(args?.cmd ?? ''))
            return

          // ---- 信息屏 ----
          case 'infoFilter':
            state.infoFilter = String(args?.filter ?? '')
            return
          case 'infoToggle':
            state.infoRaw = !state.infoRaw
            return
          case 'infoRefresh':
            return

          // ---- 数据屏：Key 列表 ----
          case 'refresh':
            await scanKeys(conn, true)
            return
          case 'filter':
            state.pattern = String(args?.pattern ?? '*').trim() || '*'
            await scanKeys(conn, true)
            return
          case 'more':
            await scanKeys(conn, false)
            return
          case 'openKey':
            state.opened = key
            state.pendingDelete = null
            state.entryDelete = false
            return
          case 'back':
            state.opened = null
            state.pendingDelete = null
            state.entryDelete = false
            await scanKeys(conn, true)
            return

          // ---- 删 key（两步） ----
          case 'askDelete':
            state.pendingDelete = key
            return
          case 'cancelDelete':
            state.pendingDelete = null
            return
          case 'confirmDelete':
            await withConn(conn, (c) => c.command('DEL', key))
            state.opened = null
            state.pendingDelete = null
            await scanKeys(conn, true)
            return { message: `已删除「${key}」` }

          // ---- 改名 / TTL ----
          case 'rename': {
            const target = String(args?.newKey ?? '').trim()
            if (!target) throw new Error('新 key 不能为空')
            if (target === state.opened) return
            await withConn(conn, async (c) => {
              // 目标已存在时拒绝：RENAME 会直接覆盖，界面里不该静默毁数据
              const exists = Number(textVal(await c.command('EXISTS', target)))
              if (exists > 0) throw new Error(`目标 key「${target}」已存在`)
              await c.command('RENAME', state.opened as string, target)
            })
            state.opened = target
            await scanKeys(conn, true)
            return { message: '已改名' }
          }
          case 'setTtl': {
            const sec = Math.floor(Number(args?.ttl))
            if (!Number.isFinite(sec)) throw new Error('TTL 要是数字（秒）')
            await withConn(conn, async (c) => {
              if (sec <= 0) await c.command('PERSIST', key)
              else await c.command('EXPIRE', key, String(sec))
            })
            return { message: sec <= 0 ? '已设为永不过期' : `TTL 设为 ${sec}s` }
          }

          // ---- string 整块改（弹窗） ----
          case 'editValue': {
            const buf = await withConn(conn, (c) => c.command('GET', key))
            return {
              openDialog: {
                title: `编辑「${key}」`,
                description: '保存会保留原来的 TTL。',
                fields: [
                  { id: 'value', label: '值（UTF-8）', value: textVal(buf), multiline: true }
                ],
                actionId: 'saveValue',
                submitLabel: '保存'
              }
            }
          }
          case 'saveValue': {
            const value = String(args?.value ?? '')
            await withConn(conn, async (c) => {
              // SET 会把 TTL 清掉 —— 先读 PTTL，写完补回去（Redis 5 没有 KEEPTTL，
              // dogi 也是这么兜的）
              const ttl = Number(await c.command('PTTL', key))
              await c.command('SET', key, value)
              if (Number.isFinite(ttl) && ttl > 0) await c.command('PEXPIRE', key, String(ttl))
            })
            return { message: '已保存' }
          }

          // ---- 集合条目：改（弹窗）/ 删（模式 + 点一行） ----
          case 'enterDeleteEntry':
            state.entryDelete = true
            return
          case 'exitDeleteEntry':
            state.entryDelete = false
            return
          case 'editEntry': {
            const type = await typeOf(conn, key)
            const spec = entryCommandOf(type)
            if (!spec) return
            const current = await currentEntry(conn, type, key, String(args?.entry ?? ''))
            return {
              openDialog: {
                title: `改一条（${key} · ${type}）`,
                fields: spec.fields.map((f) => ({ ...f, value: current[f.id] ?? '' })),
                actionId: 'saveEntry',
                submitLabel: '保存'
              }
            }
          }
          case 'saveEntry': {
            const type = await typeOf(conn, key)
            const spec = entryCommandOf(type)
            if (!spec) return
            await withConn(conn, (c) => spec.save(c, key, String(args?.entry ?? ''), args ?? {}))
            return { message: '已保存' }
          }
          case 'delEntry': {
            const type = await typeOf(conn, key)
            const spec = entryCommandOf(type)
            if (!spec) return
            await withConn(conn, (c) => spec.remove(c, key, String(args?.entry ?? '')))
            return { message: '已删掉这一条' }
          }

          // ---- 集合新增（弹窗） ----
          case 'addHashEntry':
            return {
              openDialog: {
                title: '新增 / 改字段',
                fields: [
                  { id: 'field', label: '字段' },
                  { id: 'value', label: '值', multiline: true }
                ],
                actionId: 'addHashSave',
                submitLabel: '保存'
              }
            }
          case 'addHashSave': {
            const field = String(args?.field ?? '').trim()
            if (!field) throw new Error('字段名不能为空')
            await withConn(conn, (c) => c.command('HSET', key, field, String(args?.value ?? '')))
            return { message: `已写入字段「${field}」` }
          }
          case 'pushList':
            return {
              openDialog: {
                title: '推入一个元素',
                fields: [
                  { id: 'value', label: '值' },
                  { id: 'side', label: '方向：R = 右边（默认），L = 左边', value: 'R' }
                ],
                actionId: 'pushListSave',
                submitLabel: '推入'
              }
            }
          case 'pushListSave': {
            const side = String(args?.side ?? 'R').trim().toUpperCase() === 'L' ? 'LPUSH' : 'RPUSH'
            await withConn(conn, (c) => c.command(side, key, String(args?.value ?? '')))
            return { message: `已${side === 'LPUSH' ? '从左' : '从右'}推入` }
          }
          case 'addSetEntry':
            return {
              openDialog: {
                title: '新增成员',
                fields: [{ id: 'member', label: '成员' }],
                actionId: 'addSetSave',
                submitLabel: '加入'
              }
            }
          case 'addSetSave': {
            const member = String(args?.member ?? '').trim()
            if (!member) throw new Error('成员不能为空')
            await withConn(conn, (c) => c.command('SADD', key, member))
            return { message: `已加入成员「${member}」` }
          }
          case 'addZsetEntry':
            return {
              openDialog: {
                title: '新增 / 改分数',
                fields: [
                  { id: 'member', label: '成员' },
                  { id: 'score', label: '分数', value: '0' }
                ],
                actionId: 'addZsetSave',
                submitLabel: '保存'
              }
            }
          case 'addZsetSave': {
            const member = String(args?.member ?? '').trim()
            const score = Number(args?.score)
            if (!member) throw new Error('成员不能为空')
            if (!Number.isFinite(score)) throw new Error('分数要是数字')
            await withConn(conn, (c) => c.command('ZADD', key, String(score), member))
            return { message: `已写入「${member}」= ${score}` }
          }

          default:
            return
        }
      }
    })
  }
}
