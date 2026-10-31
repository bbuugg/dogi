/**
 * Agent 客户端的全局 store（zustand）。
 *
 * 演进史：桌面端 zustand store → 迁 web 时改成一个 2000 行的 `useAgentApp` hook
 * （"一个 hook 顶掉桌面端的 zustand store"）→ hook 扛不动了（51 个 useCallback、
 * 72 处防闭包旧值的 ref、每次渲染新大对象导致全树陪跑重渲染），2026-10 迁回
 * zustand。对话运行时的逻辑一行没改，只是从「useState + ref + useCallback」
 * 换成「get()/set()」。
 *
 * 分片（`slices/`）：
 * - `core`（本文件）：真正的全局杂项（error / busy / 上下文压缩通知）
 * - `connection`：JWT 连接 + api 客户端 + 登录登出
 * - `server-lists`：各域清单镜像 + 全量刷新 + 状态 WS 订阅 + 无状态 API 门面
 * - `conversation`：每会话一份的对话现场 + 对话运行时（核心）
 * - `assistant`：项目管理助手的现场（跨项目轻量对话,独立于会话体系）
 * - `transfer`：SFTP 上传 / 下载的现场（全局传输托盘；**不持久化**，理由见 slice 文件头）
 *
 * ⚠️ slice 文件只允许 `import type { AgentStore }`（类型反向引用，编译期擦除）；
 * 运行时反向 import 会成环。
 */
import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import { loadConnection } from '@fizz/agent-client/web-host'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { createConnectionSlice, type ConnectionSlice } from '@fizz/agent-kit/shared/lib/stores/slices/connection'
import { createServerListsSlice, type ServerListsSlice } from '@fizz/agent-kit/shared/lib/stores/slices/server-lists'
import { createConversationSlice, type ConversationSlice } from '@fizz/agent-kit/shared/lib/stores/slices/conversation'
import { createAssistantSlice, type AssistantSlice } from '@fizz/agent-kit/shared/lib/stores/slices/assistant'
import { createTransferSlice, type TransferSlice } from '@fizz/agent-kit/shared/lib/stores/slices/transfer'

/**
 * 真正全局的杂项。放 core 而不是某个 slice：error 会被所有 slice 写、busy 由
 * refresh 和 loadMessages 共用。
 *
 * ⚠️ **只放「与哪条会话无关」的东西**。`contextNotice` / `contextCompressing` /
 * `compressContextNow` 曾经在这里，但它们是**某一条会话**的属性 —— 分屏时 A 会话压缩
 * 上下文，B 标签跟着闪提示、圆环跟着转。现在它们住在 `ConvSlice`（每会话一份），
 * 见 `slices/conversation/actions/context.ts`。判断标准：如果换个标签看它就该变，它
 * 就不属于这里。
 */
export interface CoreSlice {
  error: string | null
  setError: (message: string | null) => void
  clearError: () => void
  busy: boolean
  setBusy: (busy: boolean) => void
  /**
   * **兜底**上下文窗口（token）：只在这个模型没单独配窗口时当圆环的分母。
   * 服务端解析（环境变量 `FIZZ_CONTEXT_BUDGET` > 默认 200k），前端拉一次缓存；
   * `null` = 还没拉到（此时按 `DEFAULT_CONTEXT_WINDOW` 展示）。
   */
  defaultContextWindow: number | null
  /** 拉一次兜底窗口（已缓存时不重复拉）；失败静默 —— 圆环按默认值展示 */
  loadDefaultContextWindow: () => Promise<void>
  /**
   * 「发送即建会话」正在创建（只由 `runRound` 在 `newConversation` 期间置位）。
   *
   * 输入框据此把发送钮换成转圈：ACP 那条路要起外部 agent 进程 + `session/new`，
   * 从按键到会话可用有几秒钟完全没反馈，用户会以为没点上而反复点（用户报过）。
   *
   * ⚠️ 与 `streaming` 是两件事：这时这一轮还没开跑。会话建好后立刻熄（见 `newConversation`
   * 的 `done`），**不要**拖到 `streamChat` 返回。
   */
  creatingConversation: boolean
  }

const createCoreSlice: StateCreator<AgentStore, [], [], CoreSlice> = (set, get) => ({
  error: null,
  setError: (message) => {
    set({ error: message })
  },
  clearError: () => {
    set({ error: null })
  },
  busy: false,
  setBusy: (busy) => {
    set({ busy })
  },
  defaultContextWindow: null,
  loadDefaultContextWindow: async () => {
    if (get().defaultContextWindow !== null) return
    const api = get().getApi()
    if (!api) return
    try {
      const { defaultContextWindow } = await api.defaultContextWindow()
      set({ defaultContextWindow })
    } catch {
      // 纯展示信息：拿不到就按默认窗口展示，不值得弹错打扰
    }
  },
  creatingConversation: false
})

export type AgentStore = CoreSlice &
  ConnectionSlice &
  ServerListsSlice &
  ConversationSlice &
  AssistantSlice &
  TransferSlice

export const useAgentStore = create<AgentStore>()((set, get, storeApi) => ({
  ...createCoreSlice(set, get, storeApi),
  ...createConnectionSlice(set, get, storeApi),
  ...createServerListsSlice(set, get, storeApi),
  ...createConversationSlice(set, get, storeApi),
  ...createAssistantSlice(set, get, storeApi),
  ...createTransferSlice(set, get, storeApi)
}))

/**
 * 补读一次连接。
 *
 * ⚠️ store 在**本模块求值时**就建好了，而 `connection` 的初值来自 `loadConnection()`
 * —— desktop 的连接是「宿主注入的 IPC 桥」，`setAgentHost()` 却发生在应用入口。
 * ESM 里 import 先于模块体执行，所以 store 建好的那一刻宿主多半还没注入，
 * `loadConnection()` 只能落到浏览器兜底（读 localStorage）→ desktop 首屏
 * `connection === null`，`AppShell` 的登录守卫会先 `return null`，首屏空一帧。
 *
 * 这里提供显式的补救入口：应用入口在 `setAgentHost()` **之后**调一次。
 * desktop 由此拿到「恒存在的连接」；web 端此刻连接早已从 localStorage 读到，
 * 调用是空操作。
 */
export function hydrateConnection(): void {
  const host = getAgentHostOrNull()
  const connection = loadConnection()
  /*
   * 宿主已注入时**一律以宿主为准**（不能因 store 里已有连接就早退）：store 创建早于
   * `setAgentHost()` 的历史坑（import 求值先于 main 模块体）可能让初值落到浏览器兜底 ——
   * hosted `/m` 同源部署时手机用过 web 版，兜底从 `fizz.web.connection` 读到 web 的
   * token，页面「看似已登录」，而终端 / 工作台 / `/api/state` 走宿主读
   * `fizz.mobile.connection`（空）→ 开终端抛「未连接服务端」（实测 2026-10）。
   * desktop 连接恒存在，宿主读出非空时覆盖同值属无操作；读出 null 才维持现状不动
   * （desktop 的「未连接态」不在本函数的职责范围内，不能在这里把它改成 null）。
   */
  if (host && connection) {
    useAgentStore.setState({ connection })
    return
  }
  if (useAgentStore.getState().connection) return
  if (connection) useAgentStore.setState({ connection })
}
