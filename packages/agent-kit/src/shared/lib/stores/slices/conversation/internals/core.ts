/**
 * 基础助手：会话现场的读写、模型目标的校验与记忆、会话参数持久化、队列与服务端同步。
 *
 * 刻意不依赖流式运行时（`run-loop`）—— 这条分层由依赖分析保证，改动时别打破，
 * 否则两者就成环、又只能合回一个文件。
 */
import type {
  AgentBackend,
  AgentChatMessage,
  AiReasoningEffort,
} from "@fizz/contracts/agent-api";
import type { AiModelEntry, CollabSettings, QueuedMessage } from "@fizz/contracts/types";
import { type BrowserSettings } from "@fizz/contracts";
import { loadLastTarget } from "@fizz/agent-kit/shared/lib/last-target";
import { errorMessage } from "@fizz/agent-kit/shared/lib/stores/shared";
import type { AcpProbeResult } from "@fizz/acp";
import { emptySlice, SLICE_KEEP } from "../state";
import type { ConvSlice } from "../types";
import type { ConvDeps } from "./context";

export function createConversationCore(deps: ConvDeps) {
  const { set, get, api } = deps;

  const readSlice = (conversationId: string | null): ConvSlice =>
    (conversationId && get().slices[conversationId]) || emptySlice();

  /**
   * 写某个会话的现场：patch 拿旧现场返回新现场。从 `get()` 的最新值出发计算，
   * 同一帧多次写同会话链式正确。
   */

  const writeSlice = (
    conversationId: string,
    patch: (s: ConvSlice) => ConvSlice,
  ): void => {
    const next = patch(get().slices[conversationId] ?? emptySlice());
    set((state) => ({ slices: { ...state.slices, [conversationId]: next } }));
  };

  /** 整个丢掉一个会话的现场（删除会话 / 断开连接用） */

  const dropSlice = (conversationId: string): void => {
    if (!(conversationId in get().slices)) return;
    set((state) => {
      const next = { ...state.slices };
      delete next[conversationId];
      return { slices: next };
    });
  };

  const pruneSlices = (keepId: string | null): void => {
    const entries = Object.entries(get().slices);
    if (entries.length <= SLICE_KEEP) return;
    const keep = new Set<string>();
    if (keepId) keep.add(keepId);
    for (const [id, s] of entries) {
      if (s.streaming || s.request || get().runningConversations[id])
        keep.add(id);
    }
    const rest = entries
      .filter(([id]) => !keep.has(id))
      .sort((a, b) => b[1].touchedAt - a[1].touchedAt);
    for (const [id] of rest.slice(0, Math.max(0, SLICE_KEEP - keep.size)))
      keep.add(id);
    const next: Record<string, ConvSlice> = {};
    for (const [id, s] of entries) if (keep.has(id)) next[id] = s;
    set({ slices: next });
  };

  /** 一份模型配置下可选的模型清单（老数据没有 models 时退回单个 model） */

  const catalogOf = (config: { models: AiModelEntry[] }): string[] =>
    config.models.map((model) => model.id);

  /**
   * 这个目标现在还能不能用：
   * - 内置：配置还在，且 `modelId` 仍在这份配置的模型清单里；
   * - acp：agent 还在（模型值由 agent 自己广告，本地清单里查不到也放行）。
   *
   * 「配置在但记的那个模型下架了」**不算还活着** —— 界面据此显示「选择模型」，
   * 而不是替用户挑一个清单里的别的模型。
   */

  const isTargetAlive = (
    target:
      | { backend: AgentBackend; configId?: string; modelId?: string }
      | null
      | undefined,
  ): boolean => {
    if (!target?.configId) return false;
    const { models, acpAgents } = get();
    if (target.backend === "acp")
      return acpAgents.some((a) => a.id === target.configId);
    const config = models.find((m) => m.id === target.configId);
    if (!config || !target.modelId) return false;
    return catalogOf(config).includes(target.modelId);
  };

  /**
   * 从会话记录里取出「它自己记住的模型」并校验：配置 / ACP agent 被删、模型下架
   * 一律返回 null（界面显示「选择模型」）—— **绝不回退到清单第一个**，
   * 那会让用户看到一个自己从没选过的模型。
   */

  const targetFromConversation = (conversation?: {
    backend?: AgentBackend;
    configId?: string;
    modelId?: string;
  }): { backend: AgentBackend; configId: string; modelId?: string } | null => {
    if (!conversation?.backend || !conversation.configId) return null;
    const target = {
      backend: conversation.backend,
      configId: conversation.configId,
      ...(conversation.modelId ? { modelId: conversation.modelId } : {}),
    };
    return isTargetAlive(target) ? target : null;
  };

  /**
   * 新会话（空白页）的预选目标：只认「上次发送时用的模型」（localStorage，
   * 见 `lib/last-target.ts`）。没存过 / 校验不过就**什么都不选**，界面显示「选择模型」。
   *
   * **刻意排除 ACP**：ACP 的档位（模式 / 思考档）要起一次外部进程才问得到
   * （见 `probeDraftAcp`），而打开「开始新对话」页是高频动作 —— 预选 ACP 等于每次
   * 开新页都白起一个进程。用户真要 ACP 就在模型下拉里显式选，那时才探。
   * 上次用的是 ACP 会话时，空白页就什么都不预选。
   */

  const preferredTarget = (): {
    backend: AgentBackend;
    configId: string;
    modelId?: string;
  } | null => {
    const last = loadLastTarget();
    if (!last || last.backend === "acp") return null;
    return isTargetAlive(last) ? last : null;
  };

  /**
   * ACP 档位探针的进程内缓存：agentId → 探到的能力（或上次失败的原因）。
   *
   * ## 为什么需要
   *
   * 档位（模式 / 思考档）只有起一次 agent 进程问 `session/new` 才拿得到，一次几秒。
   * 原来只认 `draftAcp` 这一个槽位、且只判「同一个 agent 才复用」，所以**在几个外部
   * Agent 之间来回切每次都要重新转圈几秒**（用户报的就是这个：换一个 provider 就要
   * 重新加载模式数据）。缓存按 agentId 分开存，切回去是内存命中，pill 立刻就有数据。
   *
   * ## 边界
   *
   * - **成功的条目永久有效**（本次会话内）：agent 的档位清单来自它自己的命令行参数 /
   *   配置文件，改完本来就得重启它；真要重问有 `reloadModels` 那条路。
   * - **失败的条目有 TTL**：agent 起不来常常是暂时性的（命令刚装上、端口刚腾出来），
   *   永久记住失败会让用户被迫重开整个页面。
   * - **正在飞的条目复用同一个 Promise**：连点两次下拉不会起两个进程。
   * - 不落盘：档位跟进程 / 环境走，跨启动未必还成立。
   */

  const draftAcpCache = new Map<
    string,
    | { ok: true; value: AcpProbeResult }
    | { ok: false; reason: string; at: number }
    | Promise<void>
  >();
  /** 失败条目多久后允许自动重试（也是用户「再点一次」能触发重探的时间） */

  const DRAFT_ACP_FAIL_TTL_MS = 60_000;

  /**
   * 探一次 ACP agent 的档位（模式 / 思考档）—— 新任务页在**建会话之前**就要把 pill 画出来。
   *
   * 幂等且**跨 agent 缓存**（见 `draftAcpCache`）：探过的 agent 再切回来立刻出数据，
   * 不重新起进程；正在探的复用同一个请求。失败只写 `error`，界面退化成「默认档」，
   * 不挡发送；失败的条目过了 TTL 才会重试。
   */

  const probeDraftAcp = async (agentId: string): Promise<void> => {
    const current = get().draftAcp;
    const same = current?.agentId === agentId;
    /** 把探到的能力填进草稿槽（只在槽里还是这个 agent 时写，避免覆盖刚切走的那个） */
    const fill = (probe: AcpProbeResult): void => {
      set((state) =>
        state.draftAcp?.agentId === agentId
          ? {
              draftAcp: {
                ...state.draftAcp,
                loading: false,
                error: null,
                modes: probe.modes,
                thoughtLevel: probe.thoughtLevel,
              },
            }
          : state,
      );
    };

    const hit = draftAcpCache.get(agentId);
    if (hit && !(hit instanceof Promise)) {
      if (hit.ok) {
        // 命中：先把 pill 点亮，再让槽位对上这个 agent（换 agent 时清掉别的 agent 的选择）
        if (!same) {
          set({
            draftAcp: {
              agentId,
              loading: false,
              error: null,
              modes: hit.value.modes,
              thoughtLevel: hit.value.thoughtLevel,
              mode: null,
              thought: null,
            },
          });
        } else if (current.loading || current.error) {
          fill(hit.value);
        }
        return;
      }
      // 失败缓存还在 TTL 内：不重新起进程，直接把上次的原因摆出来
      if (Date.now() - hit.at < DRAFT_ACP_FAIL_TTL_MS) {
        if (!same) {
          set({
            draftAcp: {
              agentId,
              loading: false,
              error: hit.reason,
              modes: null,
              thoughtLevel: null,
              mode: null,
              thought: null,
            },
          });
        } else if (current.loading || !current.error) {
          set((state) =>
            state.draftAcp?.agentId === agentId
              ? {
                  draftAcp: {
                    ...state.draftAcp,
                    loading: false,
                    error: hit.reason,
                  },
                }
              : state,
          );
        }
        return;
      }
      draftAcpCache.delete(agentId);
    }
    // 已经在飞 / 槽里已经是这个 agent 的成功结果：不必重探
    if (hit instanceof Promise) return;
    if (same && !current.loading && !current.error) return;

    set({
      draftAcp: {
        agentId,
        loading: true,
        error: null,
        modes: same ? current.modes : null,
        thoughtLevel: same ? current.thoughtLevel : null,
        mode: same ? current.mode : null,
        thought: same ? current.thought : null,
      },
    });
    const api = get().getApi();
    if (!api) {
      draftAcpCache.set(agentId, {
        ok: false,
        reason: "未连接服务端",
        at: Date.now(),
      });
      set((state) =>
        state.draftAcp?.agentId === agentId
          ? {
              draftAcp: {
                ...state.draftAcp,
                loading: false,
                error: "未连接服务端",
              },
            }
          : state,
      );
      return;
    }
    /**
     * 把「这次探测」登记进缓存：成功存值、失败存原因 + 时间。同时在飞的 Promise 也占住
     * 槽位 —— 连点两次下拉时第二次直接返回，不重复起进程。
     */
    const run = (async (): Promise<void> => {
      try {
        const res = await api.probeAcpCapabilities(agentId);
        draftAcpCache.set(agentId, { ok: true, value: res });
        fill(res);
      } catch (err) {
        const reason = errorMessage(err);
        draftAcpCache.set(agentId, { ok: false, reason, at: Date.now() });
        set((state) =>
          state.draftAcp?.agentId === agentId
            ? {
                draftAcp: {
                  ...state.draftAcp,
                  loading: false,
                  error: reason,
                },
              }
            : state,
        );
      }
    })();
    draftAcpCache.set(agentId, run);
    await run;
  };

  /** 标记某个会话「在跑 / 跑完」：侧栏转圈的唯一真源 */

  const markRunning = (conversationId: string, running: boolean): void => {
    set((state) => {
      if (running === !!state.runningConversations[conversationId])
        return state;
      const next = { ...state.runningConversations };
      if (running) next[conversationId] = true;
      else delete next[conversationId];
      return { runningConversations: next };
    });
  };

  /**
   * 把模型选择持久化到会话（fire-and-forget：失败不打扰，刷新时以服务端为准）。
   * 同时同步本地列表项 —— 会话摘要里带着 backend / configId / modelId，打开会话时要用来恢复。
   */

  const persistTarget = (
    conversationId: string,
    target: {
      backend: AgentBackend;
      configId?: string;
      modelId?: string;
    } | null,
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api
      .setConversationTarget(
        conversationId,
        target
          ? {
              backend: target.backend,
              configId: target.configId ?? null,
              modelId: target.modelId ?? null,
            }
          : { backend: null, configId: null, modelId: null },
      )
      .then(() => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  backend: target?.backend,
                  configId: target?.configId,
                  modelId: target?.modelId,
                }
              : c,
          ),
        }));
      })
      .catch(() => undefined);
  };

  /** 把会话的思考强度持久化（fire-and-forget，同 persistTarget 的约定） */

  const persistReasoningEffort = (
    conversationId: string,
    effort: AiReasoningEffort | null,
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api
      .setConversationTarget(conversationId, { reasoningEffort: effort })
      .then(() => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  ...(effort
                    ? { reasoningEffort: effort }
                    : { reasoningEffort: undefined }),
                }
              : c,
          ),
        }));
      })
      .catch(() => undefined);
  };

  /**
   * 把「这个会话允许用哪些 MCP」持久化（fire-and-forget，与 persistTarget 同一套约定：
   * 失败不打扰，刷新时以服务端为准）。同时同步本地列表项 —— 会话摘要里带着 mcpServerIds，
   * 打开会话时要用来恢复。
   */

  const persistMcp = (conversationId: string, ids: string[]): void => {
    const api = get().getApi();
    if (!api) return;
    void api
      .setConversationTarget(conversationId, { mcpServerIds: ids })
      .then(() => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, mcpServerIds: ids } : c,
          ),
        }));
      })
      .catch(() => undefined);
  };

  /**
   * 把「这个会话的浏览器偏好」持久化（fire-and-forget，与 persistMcp 同一套约定：
   * 失败不打扰，刷新时以服务端为准）。同时同步本地列表项 —— 会话摘要里带着
   * `browserSettings`，切换会话 / 刷新后要用来恢复。
   *
   * 始终写**完整对象**（服务端 target 契约是整体语义）。
   */

  const persistBrowserSettings = (
    conversationId: string,
    settings: BrowserSettings,
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api
      .setConversationTarget(conversationId, { browserSettings: settings })
      .then(() => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, browserSettings: settings } : c,
          ),
        }));
      })
      .catch(() => undefined);
  };

  /** 拉某个会话的完整消息（列表接口刻意不带消息体）。结果写进**该会话自己的 slice** */

  const saveCollabSettings = async (
    settings: CollabSettings,
  ): Promise<boolean> => {
    const conversationId = get().activeConversationId;
    const api = get().getApi();
    if (!conversationId || !api) return false;
    try {
      const updated = await api.saveCollabSettings(conversationId, settings);
      set({
        conversations: get().conversations.map((c) =>
          c.id === conversationId
            ? { ...c, kind: "collab", collab: updated.collab ?? settings }
            : c,
        ),
      });
      return true;
    } catch (err) {
      get().setError(errorMessage(err));
      return false;
    }
  };

  const cancelCollabTask = async (taskId: string): Promise<boolean> => {
    const conversationId = get().activeConversationId;
    const api = get().getApi();
    if (!conversationId || !api) return false;
    try {
      const result = await api.cancelCollabTask(conversationId, taskId);
      return result.ok;
    } catch (err) {
      get().setError(errorMessage(err));
      return false;
    }
  };

  const fetchQueue = async (
    conversationId: string,
  ): Promise<QueuedMessage[] | null> => {
    const api = get().getApi();
    if (!api) return null;
    try {
      const { items } = await api.getConversationQueue(conversationId);
      return items;
    } catch {
      return null;
    }
  };

  /**
   * 把队列同步到服务端（**尽力而为**：失败只留本地缓存，绝不打断界面）。
   *
   * 每次变更都整份写（PATCH 是全量覆盖语义）—— 队列很短（几条短文本）、变更都是
   * 人肉触发的（加 / 删 / 编辑 / 拖完放手），不值得为它做 debounce 或增量协议。
   * 缓存在**本函数调用之前**就落好了，所以这里失败也只是「不跨端」，队列不丢。
   */

  const syncQueueToServer = (
    conversationId: string,
    items: QueuedMessage[],
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api.setConversationQueue(conversationId, items).catch(() => {
      // 服务端不可用（未连接 / 离线 / 5xx）：缓存已落好，静默即可
    });
  };

  /**
   * 把插话的顺序同步到服务端（**尽力而为**，与 `syncQueueToServer` 同一立场）。
   *
   * 与队列的差别：插话收件箱只活在服务端的活跃 run 上（没有 localStorage 那一层），
   * 所以失败（未连接 / 409 本轮已结束）时**保留本地的乐观顺序**即可 —— 真已经结束的话，
   * 这些插话马上会被 `user-injected` 转正出列，本轮没结束的下一帧也仍以服务端为准对齐。
   * 拖拽是 hover 即改、一次拖动会调很多次，但收件箱很短（几条短文本），不值得做 debounce。
   */

  const syncSteerOrder = (
    conversationId: string,
    items: AgentChatMessage[],
  ): void => {
    const api = get().getApi();
    if (!api) return;
    void api
      .reorderSteers(
        conversationId,
        items.map((m) => m.id),
      )
      .catch(() => {});
  };

  /**
   * 改某个会话的队列：内存 slice + localStorage 缓存 + 服务端**三处一起落**。
   *
   * 顺序是先本地后服务端：本地立即可见（拖拽排序要跟手），服务端是尽力而为的
   * 补写（失败就只留本地缓存，见上面那个 helper 的说明）。
   */

  const guardTarget = (): boolean => {
    if (isTargetAlive(get().chatTarget)) return true;
    // 悬空的目标顺手清掉（本来就是 null 时不必 set）
    if (get().chatTarget) set({ chatTarget: null });
    get().setError("请先在输入框上方选择模型（原来的配置或模型可能已被删除）");
    return false;
  };

  /**
   * 真正发起一轮对话（不含「进行中则入队」的判断）：把用户消息 + 空助手消息落本地、
   * 开 SSE、收流。本轮自然收尾后，把队列里的下一条顶上来接着跑。
   *
   * 返回 `true` = 这一轮**真的开跑了**；`false` = 还没发出去就被拦下（没连上 / 没选模型 /
   * 建会话失败）。调用方（`sendQueuedMessage` / `sendSteer`）据此把已经摘掉的条目放回去 ——
   * 拦下的那几种情况本来就同时给了错误提示，再把用户写的内容吃掉就更没道理了。
   */

  const waitConversationsLoaded = (): Promise<void> => {
    if (get().conversationsLoaded) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(finish, 15_000);
      const unsubscribe = api.subscribe((state) => {
        if (state.conversationsLoaded) finish();
      });
    });
  };

  /**
   * 打开会话后的历史装载：内置 拉服务端落盘存档 + acp 走 agent 侧 `session/load` 回放。
   * 从 `openConversation` 抽出，便于「加载失败 → 重试」复用同一段逻辑（重试不能再走
   * openConversation 的 id 去重早退）。失败统一写 slice 的 error，由消息列表展示错误 + 重试。
   */

  return {
    readSlice,
    writeSlice,
    dropSlice,
    pruneSlices,
    catalogOf,
    isTargetAlive,
    targetFromConversation,
    preferredTarget,
    draftAcpCache,
    DRAFT_ACP_FAIL_TTL_MS,
    probeDraftAcp,
    markRunning,
    persistTarget,
    persistReasoningEffort,
    persistMcp,
    persistBrowserSettings,
    saveCollabSettings,
    cancelCollabTask,
    fetchQueue,
    syncQueueToServer,
    syncSteerOrder,
    guardTarget,
    waitConversationsLoaded,
  };
}
