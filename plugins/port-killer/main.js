/**
 * port-killer 插件主进程入口。
 *
 * 「按端口找占用进程 → 结束进程」的跨平台实现：
 * - Windows：netstat -ano 拿 PID → tasklist 取进程名；
 * - Linux：ss（iproute2）→ netstat（net-tools）→ lsof 逐级回退（按命令是否可用探测）；
 * - macOS：lsof（netstat 不给 PID）。
 *
 * 结束进程统一用 Node 原生 process.kill：Windows 上等价 taskkill /F，
 * POSIX 上是 kill -9。选它是因为错误码稳定（EPERM = 权限不足 / ESRCH = 进程已退出），
 * 不依赖 taskkill / kill 的本地化输出文案。权限不足时不硬来 ——
 * 返回一条可在管理员终端执行的命令（taskkill /F /PID N 或 sudo kill -9 N）。
 *
 * 其它约定：
 * - 主结果只收「监听 / 绑定」状态的 socket；若端口只被 TIME_WAIT 等瞬态连接占着，
 *   仍返回这些行并附 note 说明（避免「查不到占用却连不上」的困惑）；
 * - PID 0（Windows 系统保留）与系统关键进程（Windows ≤ 4 / POSIX ≤ 1）拒绝结束；
 * - POSIX 上非 root 看不到他人进程的 PID：行里 pid 为 null，渲染端据此给出 sudo 查看命令。
 */
import { execFile } from 'node:child_process'

const PLATFORM = process.platform
const IS_WIN = PLATFORM === 'win32'
const IS_MAC = PLATFORM === 'darwin'
/** 小于等于该值的 PID 一律拒绝结束（Windows：0=系统空闲、4=System；POSIX：1=init） */
const PROTECTED_PID_MAX = IS_WIN ? 4 : 1
const PLATFORM_LABELS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

/* ------------------------------------------------------------------ */
/*                            命令执行与解析                            */
/* ------------------------------------------------------------------ */

/** 执行外部命令：永不抛错；ENOENT（命令不存在）单独标出，供回退链判断 */
function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          enoent: err?.code === 'ENOENT',
          code: typeof err?.code === 'number' ? err.code : err ? 1 : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? ''
        })
      }
    )
  })
}

/** 本地地址（如 0.0.0.0:8080 / [::]:8080 / *:8080）是否落在指定端口上 */
const isLocalPort = (address, port) => String(address).endsWith(`:${port}`)

/**
 * Windows：netstat -ano（TCP 5 列带状态；UDP 4 列无状态），
 * 再对去重后的 PID 逐个 tasklist 取进程名（tasklist 过滤器只能 AND，不能一次查多个 PID）。
 */
async function collectWindows(port) {
  const netstat = await run('netstat', ['-ano'])
  if (netstat.enoent) throw new Error('未找到 netstat 命令（系统环境异常）')
  const rows = []
  for (const line of netstat.stdout.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/)
    if (t.length < 4) continue
    const proto = t[0]
    if (proto !== 'TCP' && proto !== 'UDP') continue
    const address = t[1]
    if (!isLocalPort(address, port)) continue
    const state = t.length >= 5 ? t[3] : ''
    const pid = Number(t[t.length - 1])
    rows.push({ proto, address, state, pid: Number.isInteger(pid) ? pid : null, name: null })
  }
  const pids = [...new Set(rows.map((r) => r.pid).filter((p) => p !== null && p > 0))]
  await Promise.all(
    pids.map(async (pid) => {
      const t = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      const m = /^"([^"]+)"/.exec(t.stdout.trim())
      if (!m) return
      for (const r of rows) if (r.pid === pid) r.name = m[1]
    })
  )
  return { command: 'netstat -ano', rows }
}

/**
 * ss 输出（-tanp / -uanp）：
 * `LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=123,fd=6))`
 * 一个 socket 可能同时挂在多个 PID 上（如 nginx worker 共享监听），逐个展开成行。
 */
function parseSs(out, proto) {
  const rows = []
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/)
    if (t.length < 5 || t[0] === 'State' || t[0] === 'Netid') continue
    const state = t[0]
    const address = t[3]
    const users = t.slice(5).join(' ')
    const found = [...users.matchAll(/"([^"]+)",pid=(\d+)/g)]
    if (found.length === 0) {
      // 非 root 看不到他人进程：Process 列为空，只能给出地址（渲染端提示用 sudo 复查）
      rows.push({ proto, address, state, pid: null, name: null })
    } else {
      for (const m of found) rows.push({ proto, address, state, pid: Number(m[2]), name: m[1] })
    }
  }
  return rows
}

/**
 * net-tools netstat 输出（-anp）：
 * `tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 1234/sshd`
 * `udp 0 0 0.0.0.0:5353 0.0.0.0:* 999/avahi-daemon`
 */
function parseNetstatLinux(out) {
  const rows = []
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/)
    if (t.length < 4) continue
    const proto = t[0].startsWith('tcp') ? 'TCP' : t[0].startsWith('udp') ? 'UDP' : null
    if (!proto) continue
    const address = t[3]
    const state = proto === 'TCP' ? t[5] ?? '' : ''
    const m = /^(\d+)\/(.+)$/.exec(t[t.length - 1])
    rows.push({
      proto,
      address,
      state,
      pid: m ? Number(m[1]) : null,
      name: m ? m[2] : null
    })
  }
  return rows
}

/**
 * lsof 输出：
 * `node 12345 user 21u IPv4 0x… 0t0 TCP *:8080 (LISTEN)`
 * `node 12345 user 30u IPv4 0x… 0t0 TCP 127.0.0.1:8080->127.0.0.1:52000 (ESTABLISHED)`
 * 本地端在 `NAME` 的 `->` 左侧；状态是行尾括号。带 PID 的行才有效
 * （表头行与内核无主 socket 行没有有效 PID）。
 */
function parseLsof(out) {
  const rows = []
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/)
    if (t.length < 4 || t[0] === 'COMMAND') continue
    const pid = Number(t[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    const proto = t.includes('TCP') ? 'TCP' : t.includes('UDP') ? 'UDP' : null
    if (!proto) continue
    const name = t[t.length - 1]
    const stateMatch = /\(([A-Z0-9_-]+)\)$/.exec(name)
    const state = stateMatch ? stateMatch[1] : ''
    const address = name.replace(/\([A-Z0-9_-]+\)$/, '').split('->')[0].trim()
    rows.push({ proto, address, state, pid, name: t[0] })
  }
  return rows
}

/** POSIX：Linux 走 ss → netstat → lsof；macOS 直接 lsof */
async function collectPosix(port) {
  if (!IS_MAC) {
    const ssTcp = await run('ss', ['-tanp'])
    const ssUdp = await run('ss', ['-uanp'])
    if (!ssTcp.enoent && (ssTcp.stdout || ssUdp.stdout)) {
      const rows = [
        ...parseSs(ssTcp.stdout, 'TCP'),
        ...parseSs(ssUdp.stdout, 'UDP')
      ].filter((r) => isLocalPort(r.address, port))
      return { command: 'ss -tanp / ss -uanp', rows }
    }
    const ns = await run('netstat', ['-anp'])
    if (!ns.enoent && ns.stdout) {
      const rows = parseNetstatLinux(ns.stdout).filter((r) => isLocalPort(r.address, port))
      return { command: 'netstat -anp', rows }
    }
  }
  const tcp = await run('lsof', ['-nP', `-iTCP:${port}`])
  const udp = await run('lsof', ['-nP', `-iUDP:${port}`])
  if (tcp.enoent && udp.enoent) {
    throw new Error(IS_MAC ? '未找到 lsof 命令' : 'ss / netstat / lsof 均不可用，无法查询端口占用')
  }
  const rows = [...parseLsof(tcp.stdout), ...parseLsof(udp.stdout)].filter((r) =>
    isLocalPort(r.address, port)
  )
  return { command: `lsof -nP -iTCP:${port} / -iUDP:${port}`, rows }
}

/* ------------------------------------------------------------------ */
/*                              业务逻辑                               */
/* ------------------------------------------------------------------ */

/** 端口号校验：1-65535 的整数，不合法直接抛（渲染端提示） */
function normalizePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口号必须是 1-65535 的整数')
  }
  return port
}

/** 「监听 / 绑定」类状态才是端口占用的主结果；其余是已有连接等瞬态记录 */
const isPrimaryRow = (r) => r.proto === 'UDP' || /LISTEN/i.test(r.state) || r.state === ''

/** 无权限时给出「以 root 看进程」的命令（POSIX 直接看占用；Windows 不会走到这里） */
function viewAsRootCommand(port) {
  if (IS_WIN) return null
  return IS_MAC
    ? `sudo lsof -nP -iTCP:${port} -sTCP:LISTEN`
    : `sudo ss -tlnp | grep ':${port}'`
}

/** 可在管理员终端执行、用于结束指定 PID 的命令 */
const killCommandFor = (pid) => (IS_WIN ? `taskkill /F /PID ${pid}` : `sudo kill -9 ${pid}`)

async function searchPort(port) {
  const collected = IS_WIN ? await collectWindows(port) : await collectPosix(port)
  const seen = new Set()
  const rows = []
  for (const r of collected.rows) {
    const key = [r.proto, r.address, r.state, r.pid ?? '-', r.name ?? '-'].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(r)
  }
  const primary = rows.filter(isPrimaryRow)
  const others = rows.filter((r) => !isPrimaryRow(r))
  const chosen = (primary.length ? primary : others).sort(
    (a, b) =>
      a.proto.localeCompare(b.proto) ||
      a.address.localeCompare(b.address) ||
      (a.pid ?? 0) - (b.pid ?? 0)
  )
  const note =
    !primary.length && others.length
      ? `未发现监听进程；该端口仍被 ${others.length} 条其它状态的连接占用（TIME_WAIT / CLOSE_WAIT 等），通常稍后自动释放。`
      : null
  const pidUnknown = chosen.some((r) => r.pid == null)
  return {
    platform: PLATFORM,
    platformLabel: PLATFORM_LABELS[PLATFORM] ?? PLATFORM,
    protectedPidMax: PROTECTED_PID_MAX,
    port,
    command: collected.command,
    rows: chosen,
    note,
    pidUnknown,
    viewAsRootCommand: pidUnknown ? viewAsRootCommand(port) : null
  }
}

/** 结束进程：返回稳定结构而不是抛错，让渲染端按 reason 分支（elevating 要给命令） */
function killProcess(rawPid, name) {
  const pid = Number(rawPid)
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'invalid', error: '无效的 PID，无法结束进程' }
  }
  if (pid <= PROTECTED_PID_MAX) {
    return { ok: false, reason: 'protected', error: `PID ${pid} 属于系统关键进程，已拒绝结束` }
  }
  try {
    process.kill(pid, 'SIGKILL')
    return { ok: true, pid, name: typeof name === 'string' ? name : null }
  } catch (e) {
    const code = e?.code
    if (code === 'EPERM' || code === 'EACCES') {
      return {
        ok: false,
        reason: 'elevating',
        command: killCommandFor(pid),
        hint: IS_WIN
          ? '当前权限不足，无法结束该进程（多为以管理员身份运行的进程）'
          : '当前用户无权结束该进程（属于其他用户或系统进程）',
        error: `结束进程 ${pid} 需要更高权限`
      }
    }
    if (code === 'ESRCH') {
      return { ok: false, reason: 'not_found', error: `进程 ${pid} 不存在（可能已经退出）` }
    }
    return { ok: false, reason: 'error', error: `结束进程失败：${e?.message ?? e}` }
  }
}

/* ------------------------------------------------------------------ */
/*                              Handler 层                             */
/* ------------------------------------------------------------------ */

export function activate(api) {
  api.log(`port-killer 主进程已加载（${PLATFORM}）`)

  /** 平台信息：渲染端用来显示系统标签、决定哪些 PID 属于「系统关键」 */
  api.registerHandler('platform', () => ({
    platform: PLATFORM,
    platformLabel: PLATFORM_LABELS[PLATFORM] ?? PLATFORM,
    protectedPidMax: PROTECTED_PID_MAX
  }))

  api.registerHandler('search', (payload) => searchPort(normalizePort(payload?.port)))

  /** 查询「结束该 PID 的等权命令」（每行「复制命令」用，不实际执行） */
  api.registerHandler('killCommand', (payload) => {
    const pid = Number(payload?.pid)
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('无效的 PID')
    return {
      command: killCommandFor(pid),
      hint: IS_WIN
        ? '在「以管理员身份运行」的 PowerShell / CMD 中执行'
        : '在终端中执行（会提示输入密码）'
    }
  })

  api.registerHandler('kill', (payload) => killProcess(payload?.pid, payload?.name))

  return { name: '端口占用' }
}
