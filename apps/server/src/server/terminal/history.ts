/**
 * 终端命令历史的**服务端真源**，三份（三种终端，三份互不相干的数据）：
 *
 * - 本机项目终端（会话侧栏里那条）：每个项目一份，落 `<项目>/.fizz/terminal-history.json`；
 * - SSH 主机终端：不挂项目，全局一份，落 `<FIZZ_DATA_DIR>/ssh-terminal-history.json`；
 * - **宿主本机终端**（「主机与终端」里配的那条）：不挂项目，全局一份，落
 *   `<FIZZ_DATA_DIR>/local-terminal-history.json`。
 *
 * 三者共用同一套语义（与 dogi 主进程的 `CommandHistoryStore` 一致：跨会话共享、
 * 跨重启持久化）：
 * - 记录的是「用户按回车提交的那一行」（客户端 TerminalPanel 在回车时上报；
 *   AI 工具 / 脚本写进 PTY 的内容没有回车信号可拦，天然不进这里）；
 * - trim 后去重置顶（重复执行刷新时间并移到最前），超限从尾部丢弃；
 * - 文件很小（上限 MAX_ENTRIES 条短文本），每次变更整文件重写，不做 JSONL 追加。
 *
 * 为什么项目历史按项目而不是全局一份：fizz 是多项目工作台，命令历史跟着项目走
 * （与 `.fizz/conversation/` 同一逻辑），复制 / 备份项目目录历史就一起带走了。
 * 为什么 SSH 历史反过来是全局一份、且落在数据目录：SSH 过去的是**另一台机器**，
 * 它的命令与本地项目不是一回事（把本地项目历史套上去只会互相带偏），也不属于任何
 * 项目 —— 见 contracts 的 `terminalSshHistory` 注释。
 * 为什么宿主本机终端也是独立一份：它是「主机与终端」这个**独立功能**开出来的宿主 shell，
 * 与「当前是哪个项目」无关（同一个人可能压根没开项目）；把它的历史塞进某个项目的
 * `.fizz/` 等于给一条与项目无关的终端绑了个隐形归属，换个项目历史就没了。
 *
 * 目录约定与 `packages/workspace` 的 conversation-store 一致：项目 `.fizz/` 缺失就地补齐
 * （含 `.gitignore`），但**项目目录本身不存在时绝不创建**（那会凭空长出空项目目录），
 * 此时读写都静默降级为空（历史功能绝不能拖垮终端）。SSH / 宿主本机那两份落在数据目录
 * （boot 时就建好），没有这层顾虑。
 *
 * 内存缓存按**历史文件绝对路径**各一份（进程内单例；本模块只被 Route Handlers 使用，
 * 不存在 server.mjs（tsx）与 Turbopack 双加载器各持一份的问题）。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from '@fizz/workspace'
import type { CommandHistoryEntry } from '@fizz/contracts/agent-api'

/** 内存与落盘共同的上限（最新的在前，超限从尾部丢弃） */
export const COMMAND_HISTORY_MAX = 1000
/** 单条命令最长字符数（超长粘贴截断，防单条撑爆文件） */
export const COMMAND_HISTORY_MAX_CHARS = 2000

/** 项目历史文件名（项目 `.fizz/` 下） */
const HISTORY_FILE = 'terminal-history.json'
/** SSH 主机终端的全局历史文件名（数据目录下，不挂项目） */
const SSH_HISTORY_FILE = 'ssh-terminal-history.json'
/**
 * **宿主本机终端**（「主机与终端」里配的那条）的全局历史文件名（数据目录下，不挂项目）。
 *
 * 与 SSH 那份分开存：一份是「连过去的那台机器」，一份是「本机 shell」，混在一起预测
 * 会互相带偏（比如把远端才有的命令推给本地 shell）。
 */
const LOCAL_HISTORY_FILE = 'local-terminal-history.json'

/** 隐藏目录自带一份 .gitignore：历史属于本地数据，不该被提交（与 conversation-store 同文案逻辑） */
const GITIGNORE_CONTENT = '# Fizz 本地数据（工作区配置 / 会话记录，不入版本库）\n*\n'

/** 内存缓存：键 = 历史文件绝对路径（读盘一次后常驻，变更时同步更新） */
const cache = new Map<string, CommandHistoryEntry[]>()
/** 落盘链路：键同上（同一份历史并发 add 之间的写序不能交错） */
const pendingWrites = new Map<string, Promise<void>>()

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 单条是否合法（读盘时逐条校验，坏数据跳过：文件损坏就从空历史开始，绝不起不来） */
function isValidEntry(item: unknown): item is CommandHistoryEntry {
  if (!item || typeof item !== 'object') return false
  const entry = item as Partial<CommandHistoryEntry>
  return typeof entry.cmd === 'string' && entry.cmd.trim().length > 0 && typeof entry.ts === 'number'
}

/** 项目历史文件在项目内的绝对路径 */
function workspaceHistoryFile(workspacePath: string): string {
  return join(workspacePath, '.fizz', HISTORY_FILE)
}

/** SSH 全局历史文件在数据目录下的绝对路径 */
function sshHistoryFile(): string {
  return join(resolveDataDir(), SSH_HISTORY_FILE)
}

/** 宿主本机终端的全局历史文件在数据目录下的绝对路径 */
function localHistoryFile(): string {
  return join(resolveDataDir(), LOCAL_HISTORY_FILE)
}

/** 项目存储的前置：补 `.fizz/`（含 `.gitignore`） */
async function ensureWorkspaceDir(workspacePath: string): Promise<void> {
  const dir = join(workspacePath, '.fizz')
  await fs.mkdir(dir, { recursive: true })
  const gitignore = join(dir, '.gitignore')
  try {
    await fs.access(gitignore)
  } catch {
    await fs.writeFile(gitignore, GITIGNORE_CONTENT, 'utf8')
  }
}

/** SSH 全局存储的前置：只需保证数据目录存在 */
async function ensureDataDir(): Promise<void> {
  await fs.mkdir(resolveDataDir(), { recursive: true })
}

/** 读盘（进程内没缓存时）；文件缺失、JSON 损坏一律返回空历史 */
async function loadEntries(file: string): Promise<CommandHistoryEntry[]> {
  const cached = cache.get(file)
  if (cached) return cached
  let entries: CommandHistoryEntry[] = []
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      entries = parsed.filter(isValidEntry).map(({ cmd, ts }) => ({ cmd, ts }))
      if (entries.length > COMMAND_HISTORY_MAX) entries.length = COMMAND_HISTORY_MAX
    }
  } catch {
    // 文件不存在 / 损坏：从空历史开始（下次 add 才会补目录落盘）
  }
  cache.set(file, entries)
  return entries
}

/** 等某份历史挂起的落盘完成（退出前刷盘用） */
export function flushTerminalHistory(workspacePath: string): Promise<void> {
  return pendingWrites.get(workspaceHistoryFile(workspacePath)) ?? Promise.resolve()
}

/**
 * 串行化落盘：写入失败静默（不影响业务，下次变更会再试）。
 *
 * `prepareDir` 是写前的前置（项目那份要先补 `.fizz/` 与 `.gitignore`；SSH 那份要保证
 * 数据目录存在）。
 */
function persist(file: string, entries: CommandHistoryEntry[], prepareDir: () => Promise<void>): void {
  const previous = pendingWrites.get(file) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      await prepareDir()
      await fs.writeFile(file, JSON.stringify(entries), 'utf8')
    })
    .catch(() => {
      // 落盘失败不影响业务（内存里的还在；下次变更会再试）
    })
  pendingWrites.set(file, next)
}

/** 读一份历史（副本，最新在前） */
async function readHistory(file: string): Promise<CommandHistoryEntry[]> {
  return [...(await loadEntries(file))]
}

/**
 * 记一条：trim 后去重置顶（重复执行刷新时间并移到最前），超限丢尾部；空串不记。
 * 调用方负责「该不该记」的前置（项目存储要先确认项目目录存在）。
 */
async function addEntry(
  file: string,
  rawCmd: string,
  prepareDir: () => Promise<void>
): Promise<void> {
  const cmd = rawCmd.trim().slice(0, COMMAND_HISTORY_MAX_CHARS)
  if (!cmd) return
  const entries = await loadEntries(file)
  const rest = entries.filter((e) => e.cmd !== cmd)
  const next = [{ cmd, ts: Date.now() }, ...rest]
  if (next.length > COMMAND_HISTORY_MAX) next.length = COMMAND_HISTORY_MAX
  cache.set(file, next)
  persist(file, next, prepareDir)
}

/** 删除单条（按命令文本定位；不存在时静默） */
async function removeEntry(
  file: string,
  cmd: string,
  prepareDir: () => Promise<void>
): Promise<void> {
  const entries = await loadEntries(file)
  const next = entries.filter((e) => e.cmd !== cmd)
  if (next.length === entries.length) return
  cache.set(file, next)
  persist(file, next, prepareDir)
}

/** 清空一份历史（内存 + 落盘文件） */
async function clearEntries(file: string, prepareDir: () => Promise<void>): Promise<void> {
  cache.set(file, [])
  persist(file, [], prepareDir)
}

// ---------------------------------------------------------------- 本机项目终端

/** 某个项目的全部历史（最新在前）。项目目录不存在时返回空。 */
export async function listTerminalHistory(workspacePath: string): Promise<CommandHistoryEntry[]> {
  if (!(await isDirectory(workspacePath))) return []
  return readHistory(workspaceHistoryFile(workspacePath))
}

/**
 * 记录一条项目命令。项目目录不存在时静默忽略（绝不创建项目目录）。
 */
export async function addTerminalHistory(workspacePath: string, rawCmd: string): Promise<void> {
  if (!(await isDirectory(workspacePath))) return
  await addEntry(workspaceHistoryFile(workspacePath), rawCmd, () =>
    ensureWorkspaceDir(workspacePath)
  )
}

/** 删除单条项目历史（按命令文本定位；不存在时静默）。 */
export async function removeTerminalHistory(workspacePath: string, cmd: string): Promise<void> {
  await removeEntry(workspaceHistoryFile(workspacePath), cmd, () =>
    ensureWorkspaceDir(workspacePath)
  )
}

/** 清空某个项目的全部历史（内存 + 落盘文件）。 */
export async function clearTerminalHistory(workspacePath: string): Promise<void> {
  await clearEntries(workspaceHistoryFile(workspacePath), () => ensureWorkspaceDir(workspacePath))
}

// ---------------------------------------------------------------- SSH 主机终端

/** SSH 主机终端的全部历史（最新在前）。全局一份，不挂任何项目。 */
export async function listSshTerminalHistory(): Promise<CommandHistoryEntry[]> {
  return readHistory(sshHistoryFile())
}

/** 记录一条 SSH 主机终端命令（全局一份，所有主机终端共享）。 */
export async function addSshTerminalHistory(rawCmd: string): Promise<void> {
  await addEntry(sshHistoryFile(), rawCmd, ensureDataDir)
}

/** 删除单条 SSH 历史（按命令文本定位；不存在时静默）。 */
export async function removeSshTerminalHistory(cmd: string): Promise<void> {
  await removeEntry(sshHistoryFile(), cmd, ensureDataDir)
}

/** 清空 SSH 主机终端的全部历史（内存 + 落盘文件）。 */
export async function clearSshTerminalHistory(): Promise<void> {
  await clearEntries(sshHistoryFile(), ensureDataDir)
}

// ---------------------------------------------------------------- 宿主本机终端（主机与终端）

/**
 * 宿主本机终端的全部历史（最新在前）。
 *
 * **全局一份、不挂任何项目**：「主机与终端」是独立功能，它开出来的终端与当前是哪个项目
 * 无关（见模块头「为什么宿主本机终端也是独立一份」）。
 */
export async function listLocalTerminalHistory(): Promise<CommandHistoryEntry[]> {
  return readHistory(localHistoryFile())
}

/** 记录一条宿主本机终端命令（全局一份，所有本机终端标签共享）。 */
export async function addLocalTerminalHistory(rawCmd: string): Promise<void> {
  await addEntry(localHistoryFile(), rawCmd, ensureDataDir)
}

/** 删除单条宿主本机终端历史（按命令文本定位；不存在时静默）。 */
export async function removeLocalTerminalHistory(cmd: string): Promise<void> {
  await removeEntry(localHistoryFile(), cmd, ensureDataDir)
}

/** 清空宿主本机终端的全部历史（内存 + 落盘文件）。 */
export async function clearLocalTerminalHistory(): Promise<void> {
  await clearEntries(localHistoryFile(), ensureDataDir)
}