/**
 * redis-client 插件主进程入口。
 *
 * Redis 是 TCP + RESP 协议，宿主的 http 能力用不上，因此这里基于 Node 核心模块
 * node:net / node:tls 自实现了一个尽量小的 RESP2 客户端（命令串行、增量解析），
 * 通过 api.registerHandler 暴露连接管理 / key 浏览 / 值查看等能力给渲染端。
 */
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { Buffer } from 'node:buffer'

const INCOMPLETE = Symbol('incomplete')

/** 将命令参数编码为 RESP 数组帧（string | Buffer） */
function encodeCommand(args) {
  const frames = [Buffer.from(`*${args.length}\r\n`)]
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8')
    frames.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'))
  }
  return Buffer.concat(frames)
}

/**
 * 单连接 RESP 客户端。命令严格串行（一次只允许一个在途命令），
 * 收到的字节追加进 buf，用游标在 buf 上增量解析回复，成功后一次性提交偏移。
 */
class RedisClient {
  constructor(cfg) {
    this.cfg = cfg
    this.id = cfg.id
    this.socket = null
    this.buf = Buffer.alloc(0)
    this.currentDb = cfg.db ?? 0
    this.connected = false
    this.pending = null
    this.chain = Promise.resolve()
    this.error = null
    this.onClose = () => {}
  }

  connect() {
    return new Promise((resolve, reject) => {
      const { host, port, username, password, db, timeoutMs, tls } = this.cfg
      const opts = {
        host: host || '127.0.0.1',
        port: port || 6379,
        timeout: timeoutMs || 10000
      }
      const sock = tls
        ? tlsConnect({ ...opts, rejectUnauthorized: false })
        : netConnect(opts)
      this.socket = sock
      sock.setKeepAlive(true)
      sock.setNoDelay(true)

      let done = false
      sock.on('error', (err) => {
        this.error = err
        if (!done) {
          done = true
          reject(new Error(`连接失败：${err.message}`))
        }
        this.connected = false
        this.onClose()
      })
      sock.once('connect', () => {
        // 认证：优先 ACL(username password)，其次仅 password
        const args = []
        if (username) args.push('AUTH', username, password ?? '')
        else if (password) args.push('AUTH', password)
        args.push('PING')
        this.connected = true
        this.command(...args)
          .then(async () => {
            if (this.currentDb > 0) await this.command('SELECT', String(db))
            done = true
            resolve({ ok: true })
          })
          .catch((e) => {
            if (!done) {
              done = true
              this.close()
              reject(e)
            }
          })
      })
      sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk])
        if (this.connected) this._flush()
      })
      sock.on('close', () => {
        this.connected = false
        this.onClose()
      })
    })
  }

  /** 进队执行命令，返回解析后的值（Buffer 或原始类型或 null） */
  command(...args) {
    const run = () => this._send(args)
    const res = this.chain.then(run, run)
    this.chain = res.catch(() => {})
    return res
  }

  _send(args) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('连接已断开'))
      this.pending = { resolve, reject }
      try {
        this.socket.write(encodeCommand(args))
      } catch (e) {
        this.pending = null
        reject(new Error(`写入失败：${e.message}`))
      }
      this._flush()
    })
  }

  _parse(at) {
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
        return {
          val: this.buf.subarray(after, after + len),
          next: after + len + 2
        }
      }
      case '*': {
        const count = parseInt(head.slice(1), 10)
        if (count === -1) return { val: null, next: after }
        if (count > 5000000) throw new Error('回复数组过长，疑似异常')
        const arr = []
        let cur = after
        for (let i = 0; i < count; i++) {
          const r = this._parse(cur)
          if (r === INCOMPLETE) return INCOMPLETE
          const item = r.val
          // 嵌套错误用哨兵对象保留，避免误解
          arr.push(item === null || item === undefined ? null : item)
          cur = r.next
        }
        return { val: arr, next: cur }
      }
      default:
        throw new Error(`未知 RESP 类型：${head[0]} (${head})`)
    }
  }

  _flush() {
      while (this.pending) {
        let r
        try {
          r = this._parse(0)
        } catch (e) {
        const p = this.pending
        this.pending = null
        p.reject(e)
        this.connected = false
        this.close()
        return
      }
      if (r === INCOMPLETE) break
      this.buf = this.buf.subarray(r.next)
      const p = this.pending
      this.pending = null
      if (r.val && r.val._error) p.reject(new Error(r.val._error))
      else if (r.val && r.val._simple) p.resolve(r.val._simple)
      else p.resolve(r.val)
    }
  }

  async ensureDb(db) {
    if (db == null || db === this.currentDb) return
    await this.command('SELECT', String(db))
    this.currentDb = db
  }

  close() {
    this.connected = false
    if (this.pending) {
      this.pending.reject(new Error('连接已关闭'))
      this.pending = null
    }
    try {
      this.socket?.destroy()
    } catch {}
    this.socket = null
  }
}

/* ------------------------------------------------------------------ */
/*                         符文前值 / Buffer 工具                      */
/* ------------------------------------------------------------------ */

/** 将 Buffer 转为人可读文本；若含非法 UTF8 则判定为二进制并提供 hex */
function textVal(buf) {
  if (buf == null) return ''
  if (!Buffer.isBuffer(buf)) return String(buf)
  const text = buf.toString('utf8')
  const binary = !Buffer.from(text, 'utf8').equals(buf)
  if (binary) {
    return buf.toString('hex')
  }
  return text
}

function err(e) {
  return e instanceof Error ? e.message : String(e)
}

/** 换算字节数到可读大小 */
function fmtBytes(n) {
  if (n == null) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/* ------------------------------------------------------------------ */
/*                          Handler 层                               */
/* ------------------------------------------------------------------ */

const VCAP = 500 // 列表类查看的最大条目数，避免误拉超大集合

export function activate(api) {
  const conns = new Map()

  api.registerHandler('connect', async (cfg) => {
    if (conns.has(cfg.id)) conns.get(cfg.id).close()
    const client = new RedisClient(cfg)
    conns.set(cfg.id, client)
    try {
      return await client.connect()
    } catch (e) {
      conns.delete(cfg.id)
      client.close()
      throw e
    }
  })

  api.registerHandler('disconnect', (id) => {
    const c = conns.get(id)
    if (c) {
      c.close()
      conns.delete(id)
    }
    return { ok: true }
  })

  api.registerHandler('state', (id) => {
    const c = conns.get(id)
    return c
      ? { connected: c.connected, db: c.currentDb, error: c.error ? err(c.error) : null }
      : { connected: false, db: 0, error: '未连接' }
  })

  api.registerHandler('command', async ({ id, db, cmd, args = [] }) => {
    const c = conns.get(id)
    if (!c) throw new Error('未连接')
    await c.ensureDb(db)
    const raw = await c.command(cmd, ...args)
    return picklify(raw)
  })

  api.registerHandler('info', async ({ id, db, section }) => {
    const c = conns.get(id)
    if (!c) throw new Error('未连接')
    await c.ensureDb(db)
    const raw = await c.command('INFO', section || 'ALL')
    // INFO 返回多条简单字符串用 \r\n 连接，去掉行末
    return typeof raw === 'string' ? raw : String(raw || '')
  })

  /** 解析 INFO 为结构化摘要，供渲染端顶部展示 */
  api.registerHandler('serverStats', async ({ id, db }) => {
    const c = conns.get(id)
    if (!c) throw new Error('未连接')
    await c.ensureDb(db)
    const raw = await c.command('INFO', 'ALL')
    const text = typeof raw === 'string' ? raw : String(raw || '')
    const sections = {}
    let cur = 'misc'
    for (const line of text.split('\n')) {
      const l = line.trim()
      if (!l) continue
      if (l.startsWith('#')) {
        cur = l.slice(1).trim()
        continue
      }
      if (!sections[cur]) sections[cur] = {}
      const i = l.indexOf(':')
      if (i < 0) continue
      sections[cur][l.slice(0, i)] = l.slice(i + 1)
    }
    return {
      server: sections.server || {},
      clients: sections.clients || {},
      memory: sections.memory || {},
      stats: sections.stats || {},
      keyspace: sections.keyspace || {},
      redis_version: sections.server?.redis_version,
      os: sections.server?.os,
      uptime: sections.server?.uptime_in_seconds,
      connected_clients: sections.clients?.connected_clients,
      used_memory_human: sections.memory?.used_memory_human,
      total_connections: sections.stats?.total_connections_received,
      keyspaceText: Object.entries(sections.keyspace || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('  ')
    }
  })

  api.registerHandler('scanKeys', async ({ id, db, pattern = '*', cursor = 0, count = 200 }) => {
    const c = conns.get(id)
    if (!c) throw new Error('未连接')
    await c.ensureDb(db)
    const res = await c.command('SCAN', String(cursor), 'MATCH', pattern || '*', 'COUNT', String(count))
    if (!Array.isArray(res)) return { keys: [], cursor: 0, done: true }
    const nextCursor = Number(res[0]) || 0
    const rawKeys = Array.isArray(res[1]) ? res[1] : []
    // 逐个取类型（串行队列保证不乱序），提高 key 列表可读性
    const keys = []
    for (const k of rawKeys) {
      const name = textVal(k)
      let type = 'unknown'
      try {
        const t = await c.command('TYPE', k)
        type = textVal(t)
      } catch {}
      keys.push({ key: name, type })
    }
    return { keys, cursor: nextCursor, done: nextCursor === 0 }
  })

  api.registerHandler('keyMeta', async ({ id, db, key }) => {
    const c = conns.get(id)
    if (!c) throw new Error('未连接')
    await c.ensureDb(db)
    const type = textVal(await c.command('TYPE', key))
    const ttl = await c.command('TTL', key)
    return { type, ttl: typeof ttl === 'number' ? ttl : -1, exists: type !== 'none' }
  })

  api.registerHandler('getValue', async ({ id, db, key, type }) => {
    const c = conns.get(id)
    if (!c) throw new Error('未连接')
    await c.ensureDb(db)
    switch (type) {
      case 'string': {
        const buf = await c.command('GET', key)
        const text = textVal(buf)
        const isBinary = !Buffer.from(text, 'utf8').equals(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8'))
        const strlen = Buffer.isBuffer(buf) ? buf.length : String(buf ?? '').length
        return {
          type,
          data: {
            value: text,
            binary: isBinary,
            strlen
          }
        }
      }
      case 'hash': {
        const count = Number(await c.command('HLEN', key)) || 0
        const flat = await c.command('HGETALL', key)
        const entries = []
        const arr = Array.isArray(flat) ? flat : []
        for (let i = 0; i + 1 < arr.length && entries.length < VCAP; i += 2) {
          entries.push({ field: textVal(arr[i]), value: textVal(arr[i + 1]) })
        }
        return { type, data: { count, entries, truncated: entries.length < count } }
      }
      case 'list': {
        const count = Number(await c.command('LLEN', key)) || 0
        const arr = await c.command('LRANGE', key, '0', String(Math.min(VCAP, Math.max(0, count)) - 1))
        const entries = (Array.isArray(arr) ? arr : []).map((v, i) => ({
          index: i,
          value: textVal(v)
        }))
        return { type, data: { count, entries, truncated: entries.length < count } }
      }
      case 'set': {
        const count = Number(await c.command('SCARD', key)) || 0
        const arr = await c.command('SMEMBERS', key)
        const entries = (Array.isArray(arr) ? arr : []).slice(0, VCAP).map((v) => textVal(v))
        return { type, data: { count, entries, truncated: entries.length < count } }
      }
      case 'zset': {
        const count = Number(await c.command('ZCARD', key)) || 0
        const flat = await c.command('ZRANGE', key, '0', String(Math.min(VCAP, count) - 1), 'WITHSCORES')
        const arr = Array.isArray(flat) ? flat : []
        const entries = []
        for (let i = 0; i + 1 < arr.length; i += 2) {
          entries.push({ member: textVal(arr[i]), score: textVal(arr[i + 1]) })
        }
        return { type, data: { count, entries } }
      }
      case 'stream': {
        const count = Number(await c.command('XLEN', key)) || 0
        const body = await c.command('XRANGE', key, '-', '+', 'COUNT', String(VCAP))
        const entries = (Array.isArray(body) ? body : []).map((item) => {
          const id = textVal(Array.isArray(item) ? item[0] : '')
          const fields = []
          const fv = Array.isArray(item) && Array.isArray(item[1]) ? item[1] : []
          for (let i = 0; i + 1 < fv.length; i += 2) {
            fields.push({ field: textVal(fv[i]), value: textVal(fv[i + 1]) })
          }
          return { id, fields }
        })
        return { type, data: { count, entries, truncated: entries.length < count } }
      }
      default:
        return { type, data: {} }
    }
  })

  api.registerHandler('deleteKey', async ({ id, db, key }) => {
    const c = conns.get(id)
    if (!c) throw new Error('未连接')
    await c.ensureDb(db)
    await c.command('DEL', key)
    return { ok: true }
  })

  api.log('redis-client 主进程已加载')
  return { name: 'Redis客户端' }
}

/** 把可能含 Buffer 的回复转为纯 JS 值（Buffer -> 文本），便于过 IPC */
function picklify(v) {
  if (v == null) return v
  if (Buffer.isBuffer(v)) return textVal(v)
  if (Array.isArray(v)) return v.map((x) => picklify(x))
  if (typeof v === 'object' && v._simple) return v._simple
  if (typeof v === 'object' && v._error) return `[${v._error}]`
  return v
}

export const __fmtBytes = fmtBytes