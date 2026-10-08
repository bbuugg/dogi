/**
 * 会话的**导入 / 导出**（单文件 JSON）。
 *
 * 为什么值得做：会话里最值钱的是「那一轮怎么把问题逼出来的」—— 工具调用的顺序、
 * 失败的尝试、最后跑通的那条命令。这些在本地是一个个 JSON，用户既带不走也分享不了。
 * 导出成一个自解释的文件后，它就能像代码一样被传阅、被当模板复用。
 *
 * ## 文件格式
 *
 * ```json
 * {
 *   "format": "dogi-conversation",
 *   "version": 1,
 *   "exportedAt": 1730000000000,
 *   "conversation": { …AgentConversation… }
 * }
 * ```
 *
 * 外面这层信封是**刻意**的：光秃秃一个会话对象无法自证「这是什么文件」，
 * 用户拿错文件（比如导出了别的工具的 JSON）时只能靠猜。有 `format` 就能给一句
 * 人话错误。`version` 留给以后改结构时做兼容判断。
 *
 * 导入**同时接受**信封和裸会话对象：手写的、老版本导出的、从别处抄来的
 * 都能进来 —— 多一层宽容换来的只是几行校验代码。
 *
 * ## 导入时改了什么
 *
 * 一律**当新会话**处理：换新 id、落到目标工作区、清掉归档态与检查点。
 * 理由是「导入」的语义是「拿一份副本进来」，不是「把这条会话接到我这儿」——
 * 沿用原 id 会与已有会话撞车（存储是按 id 一个文件）。
 *
 * ⚠️ 刻意**不导入** `acpAgentId` / `acpSessionId`：那是**导出方机器上**的绑定，
 * 在这台机器上要么不存在、要么指向另一个 agent。带着它只会得到一个打不开的会话。
 * ACP 会话因此导出时也**只导标题与元信息**（消息在 agent 那边，本地本来就没有）。
 */
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import type {
  AgentChatMessage,
  AgentConversation,
  ConversationTransferResult
} from '@shared/types'
import { conversationStore } from '../conversation-store'

/** 信封标识：认这个字段就知道「这是 dogi 的会话文件」 */
const EXPORT_FORMAT = 'dogi-conversation'
/** 当前结构版本（读的时候只认 <= 它的） */
const EXPORT_VERSION = 1
/** 文件后缀：`.json` 结尾（系统与编辑器都认），中间那截是给人看的 */
const EXPORT_SUFFIX = '.dogi.json'
/** 单个文件上限：正常会话几百 KB，50MB 以上只可能是选错了文件（读完再拒是白占内存） */
const MAX_IMPORT_BYTES = 50 * 1024 * 1024

/** 文件名里不能出现的字符换成 `-`（Windows 上还有一批保留名，一并规避） */
function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  // 全被替换掉（或本来就是空标题）时给个兜底名，别让 defaultPath 变成 `.dogi.json`
  return cleaned || 'conversation'
}

/** 模态文件框在 Windows 上可能被主窗口遮住（electron#32857）：临时置顶并聚焦 */
async function withWindowOnTop<T>(
  win: BrowserWindow | null,
  fn: (win: BrowserWindow | undefined) => Promise<T>
): Promise<T> {
  if (!win || win.isDestroyed()) return fn(undefined)
  if (win.isMinimized()) win.restore()
  win.setAlwaysOnTop(true)
  win.focus()
  try {
    return await fn(win)
  } finally {
    win.setAlwaysOnTop(false)
  }
}

/**
 * 导出会话到用户选定的文件。
 *
 * 渲染端不参与落盘（不走 `dialog` + `fs` 的老路），因为会话真源在主进程的
 * conversationStore 里 —— 渲染端手里那份可能正处在流式中途（半截消息），
 * 从主进程读才是「完整、已收口」的那份。
 */
export async function exportConversation(
  win: BrowserWindow | null,
  conversationId: string
): Promise<ConversationTransferResult> {
  const conversation = conversationStore.get(conversationId)
  if (!conversation) return { ok: false, reason: '会话不存在，可能已被删除' }

  const picked = await withWindowOnTop(win, (w) =>
    dialog.showSaveDialog(w as BrowserWindow, {
      defaultPath: `${safeFileName(conversation.title)}${EXPORT_SUFFIX}`,
      filters: [{ name: 'Dogi 会话', extensions: ['json'] }]
    })
  )
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }

  const payload = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    conversation
  }
  try {
    await fs.writeFile(picked.filePath, JSON.stringify(payload, null, 2), 'utf8')
  } catch (err) {
    return { ok: false, reason: `写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, path: picked.filePath }
}

/** 一条消息的最低可辨认形状（parts 必须是数组 —— 后面渲染端要按它展开） */
function looksLikeMessage(value: unknown): value is AgentChatMessage {
  if (!value || typeof value !== 'object') return false
  const m = value as Partial<AgentChatMessage>
  return typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant') && Array.isArray(m.parts)
}

/**
 * 把文件内容解析成一个可导入的会话。返回 `{ error }` 时是**给用户看的人话**。
 *
 * 校验刻意偏松（只挡「一定渲染不出来」的输入）：会话文件是用户能手改的，
 * 为了几个缺字段就整个拒绝，反而把「改完还能导入」这条实用路径堵死了。
 */
function parseImport(raw: string): { conversation: AgentConversation } | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { error: '不是合法的 JSON 文件' }
  }
  if (!data || typeof data !== 'object') return { error: '文件内容不是一个对象' }

  const env = data as { format?: unknown; version?: unknown; conversation?: unknown }
  let candidate: unknown = env.conversation ?? data
  if (env.format !== undefined && env.format !== EXPORT_FORMAT) {
    return { error: `这不是 Dogi 会话文件（format=${String(env.format)}）` }
  }
  if (typeof env.version === 'number' && env.version > EXPORT_VERSION) {
    return { error: `文件版本 ${env.version} 高于本版本支持的 ${EXPORT_VERSION}，请升级 Dogi` }
  }
  if (!candidate || typeof candidate !== 'object') return { error: '文件里没有会话内容' }

  const c = candidate as Partial<AgentConversation>
  if (!Array.isArray(c.messages)) return { error: '会话缺少 messages 数组' }
  const messages = c.messages.filter(looksLikeMessage)
  if (messages.length === 0 && c.messages.length > 0) {
    return { error: '会话里的消息格式都不对（缺少 id / role / parts）' }
  }
  return {
    conversation: {
      id: crypto.randomUUID(),
      title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : '导入的会话',
      kind: 'mastra',
      messages,
      // 模型配置是**导出方机器上**的选择，在这台机器上多半不存在 —— 不带过来，
      // 让会话回退到本机的默认模型（渲染端也会按缺省值显示）
      configId: undefined,
      modelId: undefined,
      acpAgentId: undefined,
      acpSessionId: undefined,
      // 检查点与归档态同理：都是「那份文件当时的处境」，不该跟着搬过来
      contextSummary: undefined,
      archived: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }
}

/**
 * 从用户选定的文件导入一条会话到目标工作区。
 *
 * 导入出来的会话**立刻落盘**（渲染端拿到后只需塞进列表）—— 这样即使渲染端
 * 随后崩了，文件已经在那儿了，不会出现「导入了但列表里没有」。
 */
export async function importConversation(
  win: BrowserWindow | null,
  workspaceId: string
): Promise<ConversationTransferResult> {
  const picked = await withWindowOnTop(win, (w) =>
    dialog.showOpenDialog(w as BrowserWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Dogi 会话', extensions: ['json'] }]
    })
  )
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
  const filePath = picked.filePaths[0]

  let raw: string
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_IMPORT_BYTES) {
      return { ok: false, reason: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），不像是会话文件` }
    }
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    return { ok: false, reason: `读取失败：${err instanceof Error ? err.message : String(err)}` }
  }

  const parsed = parseImport(raw)
  if ('error' in parsed) return { ok: false, reason: `${basename(filePath)}：${parsed.error}` }

  const saved = conversationStore.save({
    ...parsed.conversation,
    id: parsed.conversation.id,
    workspaceId,
    scope: undefined
  })
  return { ok: true, path: filePath, conversation: saved }
}
