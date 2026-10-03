import { app } from 'electron'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentBackend,
  AgentChatMessage,
  AgentConversation,
  ConversationContextSummary
} from '@shared/types'

/** 会话默认标题（渲染端也有一份同值常量） */
const DEFAULT_CONVERSATION_TITLE = '新会话'


/**
 * 旧存档里的会话形态（0.0.6 及以前）。
 *
 * 当时的模型是「工作区 / 会话各有一个 `backend`，`configId` 的含义由它决定」，
 * 且 `ai-sdk` 是第三种后端 —— 现在只有 `kind: 'mastra' | 'acp'` 两种，需要读时迁移。
 */
type LegacyConversation = Partial<AgentConversation> & {
  id: string
  workspaceId?: string
  backend?: 'ai-sdk' | 'acp' | 'mastra'
  /** 旧字段：`ai-sdk` 下是 AiModelConfig.id，`acp` 下是 AcpAgentConfig.id */
  configId?: string
}

/**
 * 把存档里的会话规整成当前形态（**读取时迁移，不写回**，下次保存自然落成新形态）。
 *
 * - `backend`（含已移除的 `'ai-sdk'`）→ `kind`：`'acp'` 仍是 acp，其余一律按 mastra；
 * - 旧 ACP 会话的 `configId` 存的是 `AcpAgentConfig.id` → 迁到 `acpAgentId`；
 * - 旧 ACP 会话没有 `acpSessionId`（当时每次都是 `session/new`），保持 undefined，
 *   首轮对话时由主进程补建并把新 id 回填；
 * - 旧 ACP 会话确实在本地存过消息，但新架构下 ACP 会话的消息由 agent 自己管理
 *   （打开时 `session/load` 回放），这里直接丢掉本地副本，避免显示一份不再更新的僵尸历史。
 */
function normalizeConversation(raw: LegacyConversation): AgentConversation {
  const kind: AgentBackend =
    raw.kind === 'acp' || (!raw.kind && raw.backend === 'acp') ? 'acp' : 'mastra'
  const base = {
    id: raw.id,
    workspaceId: raw.workspaceId,
    // 作用域缺省 = workspace（兼容旧存档）；目录本身就是作用域的物理边界，
    // 这里照抄存档值，防止手改文件把终端会话混进工作区列表
    scope: raw.scope,
    title: raw.title ?? DEFAULT_CONVERSATION_TITLE,
    // ⚠️ 这个函数是**显式重建对象**（不 spread raw），所以每个要保留的字段都必须在这里列出。
    // 漏掉 contextSummary 的后果不是「读出来少个字段」，而是：读回来丢 → 缓存里没了 →
    // 用户下一次发消息触发 save → 文件被重写成没有检查点的版本 → 压缩成果**永久丢失**。
    // 加新字段时务必在这里补一行。
    contextSummary: raw.contextSummary,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now()
  }
  if (kind === 'acp') {
    return {
      ...base,
      kind: 'acp',
      messages: [],
      modelId: raw.modelId,
      acpAgentId: raw.acpAgentId ?? raw.configId,
      acpSessionId: raw.acpSessionId
    }
  }
  return {
    ...base,
    kind: 'mastra',
    messages: raw.messages ?? [],
    configId: raw.configId,
    modelId: raw.modelId
  }
}

/** 保存会话的入参（与渲染端 `agent:conversations:save` 的请求体一致） */
export interface SaveConversationInput {
  id?: string
  /** 仅 workspace 作用域：所属工作区。terminal 会话不绑工作区 */
  workspaceId?: string
  /** 会话作用域；缺省 = workspace。terminal 会话强制 mastra、不落 acp 字段 */
  scope?: AgentConversation['scope']
  /** 会话形态；不传沿用旧值（新会话按 mastra） */
  kind?: AgentBackend
  title?: string
  /** 仅 mastra 有意义：ACP 会话的消息由 agent 自己管理，这里一律写空 */
  messages?: AgentChatMessage[]
  /** 仅 mastra */
  configId?: string
  /** 具体模型 id：`mastra` 是配置里的模型，`acp` 是 agent 上报的模型 value */
  modelId?: string
  /** 仅 acp：绑定的 ACP agent 配置 id */
  acpAgentId?: string
  /** 仅 acp：agent 侧的会话 id */
  acpSessionId?: string
}

/**
 * Agent 会话的独立存储：**一个会话一个 JSON 文件**（`<userData>/agent-conversations/<id>.json`）。
 *
 * ⚠️ 为什么不放在 `services/storage.ts` 的那个 electron-store 里（这里是刻意分开的，别合回去）：
 *
 * 1. **体量**：会话带完整消息历史（工具结果、终端输出、文件内容…），实测能占整个配置文件
 *    的 **97%**（4.9MB 里 4.76MB）。而 electron-store 底层的 conf 有个要命的实现 ——
 *    `get store()` **每次访问都 `readFileSync` + JSON.parse + 全量 AJV 校验整个文件**
 *    （见 node_modules/conf/dist/source/index.js 的 `get store()` / `set store()`），
 *    `set` 更是「读两遍 + 写一遍」。也就是说**任何一次不相关的写入**（改个偏好、拖窗口存
 *    bounds、存条笔记）都要把这几 MB 搬三遍 —— 这就是「拖窗口一顿一顿」的根源。
 * 2. **写入频率**：流式对话期间每 3 秒就要落盘一次（见渲染端 `persistConversationThrottled`），
 *    全量重写所有会话非常浪费。
 *
 * 所以这里用**裸 fs + 进程内缓存**：主进程是唯一写入方，内存里的 Map 即真源，
 * 落盘只是持久化。保存一个会话只写它自己那个文件（中位数几十 KB），
 * 与主 store 和其他会话完全解耦。
 */
export class ConversationStore {
  /** id → 会话（首次访问时从目录灌入，此后与磁盘保持同步） */
  private cache = new Map<string, AgentConversation>()
  private loaded = false
  private dir: string | null = null

  constructor(private readonly dirName = 'agent-conversations') {}

  /** 会话目录（懒解析：`app.getPath` 在模块加载期不一定可用，首次用时才算） */
  private get dirPath(): string {
    this.dir ??= join(app.getPath('userData'), this.dirName)
    return this.dir
  }

  /**
   * 会话文件路径。
   * id 是我们自己生成的 uuid，但仍然过一道白名单 —— 存档是用户可以手改的，
   * 不能让一个带 `../` 的 id 把文件写到目录外面去。
   */
  private filePath(id: string): string {
    return join(this.dirPath, `${id.replace(/[^a-zA-Z0-9._-]/g, '-')}.json`)
  }

  /** 首次访问时把目录里所有会话读进缓存（只跑一次） */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    mkdirSync(this.dirPath, { recursive: true })
    for (const name of readdirSync(this.dirPath)) {
      // 只认 .json：写盘用的临时文件是 `<id>.json.tmp`，不会被误收
      if (!name.endsWith('.json')) continue
      const conversation = this.readFile(name.slice(0, -'.json'.length))
      if (conversation) this.cache.set(conversation.id, conversation)
    }
  }

  /**
   * 读单个会话文件。
   * 解析失败返回 null 而不是抛 —— 单个损坏的会话（强杀进程只可能毁掉它自己那一个）
   * 不该让整个会话列表打不开。
   */
  private readFile(id: string): AgentConversation | null {
    try {
      const raw = JSON.parse(readFileSync(this.filePath(id), 'utf8')) as LegacyConversation
      return normalizeConversation(raw)
    } catch {
      return null
    }
  }

  /** 写作一个会话文件：先写 `.tmp` 再 rename，避免写到一半中断留下半截 JSON */
  private writeFile(conversation: AgentConversation): void {
    mkdirSync(this.dirPath, { recursive: true })
    const target = this.filePath(conversation.id)
    const temp = `${target}.tmp`
    writeFileSync(temp, JSON.stringify(conversation), 'utf8')
    try {
      renameSync(temp, target)
    } catch {
      // Windows 上目标被占用（杀软扫描等）时 rename 可能失败，退回直接覆盖
      writeFileSync(target, JSON.stringify(conversation), 'utf8')
      rmSync(temp, { force: true })
    }
  }

  /** 全部会话（按创建顺序，与旧版「数组追加」的语义一致；分组排序由渲染端负责） */
  list(): AgentConversation[] {
    this.ensureLoaded()
    return [...this.cache.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  /** 按 id 取单条（主进程 `agent:chat` 用它判断会话形态，不必再读全量） */
  get(id: string): AgentConversation | undefined {
    this.ensureLoaded()
    return this.cache.get(id)
  }

  /**
   * 保存会话（upsert）：不传 id 视为新建。
   *
   * 返回保存后的会话 —— 调用方（`agent:chat`）需要形态，别改成返回全量列表。
   */
  save(input: SaveConversationInput): AgentConversation {
    this.ensureLoaded()
    const now = Date.now()
    const prev = input.id ? this.cache.get(input.id) : undefined
    // terminal 会话只有 mastra 形态（ACP 绑定工作区目录，与终端无关）
    const isTerminal = (input.scope ?? prev?.scope) === 'terminal'
    const kind: AgentBackend = isTerminal ? 'mastra' : (input.kind ?? prev?.kind ?? 'mastra')
    const isAcp = kind === 'acp'
    // 各字段一律用 `'x' in input` 判断而不是 `??`：渲染端落盘时**每次都显式带上**这些字段，
    // 其中 `undefined` 表示「这个字段要清掉（没选 / 走默认）」—— 必须能覆盖旧值，
    // 否则把会话从某个模型切回默认就永远切不回来（见 AGENTS.md 4.3）。
    const conversation: AgentConversation = {
      id: input.id || crypto.randomUUID(),
      // terminal 会话不绑工作区：workspaceId 显式清掉（undefined 落盘时字段被丢弃）
      workspaceId: isTerminal ? undefined : input.workspaceId,
      scope: isTerminal ? 'terminal' : undefined,
      kind,
      title: input.title ?? prev?.title ?? DEFAULT_CONVERSATION_TITLE,
      // ACP 会话的消息归 agent 管：本地不保存任何消息
      messages: isAcp ? [] : (input.messages ?? prev?.messages ?? []),
      configId: isAcp ? undefined : 'configId' in input ? input.configId : prev?.configId,
      modelId: 'modelId' in input ? input.modelId : prev?.modelId,
      acpAgentId: isAcp
        ? 'acpAgentId' in input
          ? input.acpAgentId
          : prev?.acpAgentId
        : undefined,
      acpSessionId: isAcp
        ? 'acpSessionId' in input
          ? input.acpSessionId
          : prev?.acpSessionId
        : undefined,
      // ⚠️ 上下文摘要检查点**原样保留**、这里不做任何合并：
      // 它归主进程所有（生成 / 清除都走 `setContextSummary`），而渲染端的落盘请求里
      // 根本没有这个字段 —— 如果这里跟着重建对象不带上它，用户每发一条消息
      // 就会把手动压缩的成果悄悄抹掉。
      contextSummary: prev?.contextSummary,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    this.cache.set(conversation.id, conversation)
    this.writeFile(conversation)
    return conversation
  }

  delete(id: string): void {
    this.ensureLoaded()
    this.cache.delete(id)
    rmSync(this.filePath(id), { force: true })
  }

  /**
   * 设置 / 清除上下文摘要检查点（**手动压缩的落库口**，见 `ConversationContextSummary`）。
   *
   * 只改这一个字段，消息原封不动 —— 压缩只发生在「组装发往模型的历史」那一步，
   * 所以清除它就是**完整、无损地**回到全文历史。
   *
   * 刻意不复用 `save`：那个是「upsert + 重建整条会话」的语义，而这里要的是
   * 「就地打一个补丁」，走 save 会把渲染端传来的消息当成真源重写一遍。
   */
  setContextSummary(
    id: string,
    summary: ConversationContextSummary | null
  ): AgentConversation | undefined {
    this.ensureLoaded()
    const prev = this.cache.get(id)
    if (!prev) return undefined
    const next: AgentConversation = {
      ...prev,
      // null 显式置 undefined（JSON 落盘时字段被丢弃）= 清除
      contextSummary: summary ?? undefined,
      updatedAt: Date.now()
    }
    this.cache.set(id, next)
    this.writeFile(next)
    return next
  }

  /** 工作区没了：它的会话一并删掉，避免留下永远看不到的孤儿数据 */
  deleteByWorkspace(workspaceId: string): void {
    this.ensureLoaded()
    for (const conversation of [...this.cache.values()]) {
      if (conversation.workspaceId === workspaceId) this.delete(conversation.id)
    }
  }

  /**
   * 一次性迁移：把历史上塞在主 store 里的整个 `agentConversations` 数组逐个写成文件。
   * 由 `storage` 在构造期调用，搬完由调用方把主 store 里那个键删掉。
   */
  importLegacy(conversations: AgentConversation[]): void {
    this.ensureLoaded()
    for (const raw of conversations) {
      const conversation = normalizeConversation(raw as LegacyConversation)
      this.cache.set(conversation.id, conversation)
      this.writeFile(conversation)
    }
  }
}

export const conversationStore = new ConversationStore('agent-conversations')

/**
 * 终端 AI 助手的会话存储：与工作区会话**同一个类、不同的目录**
 * （`<userData>/terminal-conversations/`）。物理隔离是刻意的 —— 「终端会话绝不进
 * AI Agent 的侧边栏」靠目录边界保证，不靠每个消费方记得过滤。
 */
export const terminalConversationStore = new ConversationStore('terminal-conversations')
