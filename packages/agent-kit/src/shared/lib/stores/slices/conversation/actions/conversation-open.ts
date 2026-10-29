/**
 * action 层：conversation-open。叶子层 —— action 之间只通过 `get().xxx()` 互相调用，
 * 内部助手一律从 ctx 拿，internals 不会反过来依赖它。
 */
import { errorMessage } from "@fizz/agent-kit/shared/lib/stores/shared";
import { saveActiveConversationId, loadQueue, saveQueue } from "../storage";
import type { ConvInternals } from "../internals/context";
import type { ConversationSlice } from "../types";

export function createConversationOpenActions(
  ctx: ConvInternals,
): Pick<
  ConversationSlice,
  "openConversation" | "retryLoadMessages" | "reloadAcpSession" | "reloadConversation"
> {
  const { set, get, api, readSlice, writeSlice, pruneSlices, targetFromConversation, preferredTarget, fetchQueue, attachRun, loadConversation, loadMessages, peekActiveRun, pump } = ctx;

  return {
    openConversation: (conversationId) => {
      // 已是当前会话：什么都不做（重复打开只会白白重拉，界面闪一下）
      if (conversationId && conversationId === get().activeConversationId)
        return;
      // 空态 = 用户的明确意图（「新建会话」/ 删除后落空态）：记下来挡住兜底恢复
      set({
        activeConversationId: conversationId,
        blankIntent: conversationId === null,
      });
      // 记住现场：下次启动直接回到这个会话（它自己记着选的模型）
      saveActiveConversationId(conversationId);
      if (!conversationId) {
        // 回到「开始新对话」页：预选清单第一份**有可用模型**的配置（具体的配置 + 模型，
        // 下拉里显示真实名字）—— 不继承上一个会话的选择，也不存在「默认」概念。
        // 各会话的现场都留在各自的 slice 里，切回来原样还在 —— 不清任何东西。
        // MCP 待定选择照样清空：新会话建出来时会带上，残留会让新会话凭空多出几个 MCP。
        // 浏览器偏好同理：清成「未设」（null）= 按全局默认显示
        // ACP 草稿档位一并清掉：那是上一个新任务页的临时选择，留着会让下一个新会话凭空带上
        set({
          chatTarget: preferredTarget(),
          mcpServerIds: [],
          browserSettings: null,
          reasoningEffort: null,
          draftAcp: null,
        });
        return;
      }
      const existing = get().slices[conversationId];
      // 恢复这个会话记住的模型（配置 / 模型被删就是 null → 界面显示「选择模型」，
      // 不继承别的会话的选择）。列表可能还没刷到最新，装载收尾会用会话详情再校正一次。
      const stored = get().conversations.find((c) => c.id === conversationId);
      set({
        chatTarget: targetFromConversation(stored),
        // MCP 选择也按会话各自记（没存过 = 全不选）
        mcpServerIds: stored?.mcpServerIds ?? [],
        // 浏览器偏好也按会话各自记（没存过 = null → 界面按全局默认显示）
        browserSettings: stored?.browserSettings ?? null,
        // 思考强度同理（没存过 = null → 跟随模型默认）
        reasoningEffort: stored?.reasoningEffort ?? null,
      });
      /**
       * 定时任务跑出来的会话（`unseen`）：**点开即算看过**。
       *
       * 本地先乐观清掉（红点立刻消失、侧栏不用等一个来回），服务端顺手落标记；
       * fire-and-forget —— 这颗红点晚消失几毫秒没关系，但请求失败绝不能挡住打开会话。
       * 应答是整份清单，直接覆盖（与归档 / 重命名同一条用法）。
       *
       * 只在这一处清：所有入口（侧栏行、定时任务管理页、深链、搜索结果）最终都走
       * `openConversation`，别在各处再抄一遍。
       */
      if (stored?.unseen) {
        const api = get().getApi();
        set({
          conversations: get().conversations.map((c) =>
            c.id === conversationId ? { ...c, unseen: undefined } : c,
          ),
        });
        void api
          ?.markConversationSeen(conversationId)
          .then((list) => set({ conversations: list }))
          .catch(() => undefined);
      }
      if (existing) {
        /**
         * 现场还在内存里：**直接切过去**。切走期间这轮的 SSE 帧一直落在它自己的
         * slice 上，这里看到的就是最新直播 —— 不清空、不重拉、不需要 attach。
         * （resetKey 里带会话 id，切换本身就会让消息区复位落底。）
         *
         * 后台再静默刷一遍历史兜底（别的端可能改过这个会话）：在跑 / 装载中都不刷
         * —— 在跑时流式帧才是真源，装载中时原装载链路自己会写。
         */
        writeSlice(conversationId, (s) => ({
          ...s,
          touchedAt: Date.now(),
          scrollResetSeq: s.scrollResetSeq + 1,
        }));
        // 后台再静默刷一遍历史兜底（别的端可能改过这个会话）。
        // ⚠️ acp 例外：服务端历史恒为空，拉了会把内存里那份 transcript 回放**擦成空会话**
        //（切换走再切回来消息全没就是这个）—— 与 settleRound / runRound 收尾的豁免同一套
        // 道理：本地这份就是 ACP 会话的全部展示
        if (!existing.streaming && !existing.loading) {
          const convBackend = get().conversations.find(
            (c) => c.id === conversationId,
          )?.backend;
          if (convBackend !== "acp") void loadMessages(conversationId);
        }
        if (
          !get().runningConversations[conversationId] &&
          !existing.loading &&
          !existing.streaming
        ) {
          pump();
        }
        pruneSlices(conversationId);
        return;
      }
      /**
       * 现场不在（首次打开 / 刷新后）：亮起「装载中」并走完整装载链路。装载窗口里
       * 消息区显示装载中而不是旧内容 —— 这个窗口若挂着别的会话的列表，用户在上面
       * 删除 / 编辑，拿的是旧消息 id 配新会话 id，服务端对不上就报错（实测踩过的坑）。
       */
      /** localStorage 缓存先顶上：服务端那份要等一个往返，不能让它拖住首帧 */
      const cached = loadQueue(conversationId);
      writeSlice(conversationId, (s) => ({
        ...s,
        touchedAt: Date.now(),
        loading: true,
        error: null,
        // 先铺本地缓存（顺序可能与服务端不同：排序是跨端的，服务端那份才是权威）
        queuedMessages: cached,
      }));
      void loadConversation(conversationId);
      /**
       * 队列的权威在服务端（拖拽排序要跨端一致），但拉它得一个来回 ——
       * 所以本地缓存先顶上、后台拉回来**无感替换**。
       *
       * 身份守卫：这一个来回里用户可能已经改了队列（加 / 删 / 拖），那份改动不能被
       * 这趟晚到的应答盖掉。判据是「slice 里躺的还是我刚铺上的那个数组」（引用相等）
       * —— 只有 patchQueue 才会换掉这个引用。用户切走 / slice 被淘汰时引用也变了，
       * 同样不会覆盖（那时更不该覆盖）。
       */
      void (async () => {
        const remote = await fetchQueue(conversationId);
        if (!remote) return;
        if (get().activeConversationId !== conversationId) return;
        if (readSlice(conversationId).queuedMessages !== cached) return;
        // 只写切片 + 缓存，不回写服务端（这份数据本来就来自它）
        writeSlice(conversationId, (s) => ({ ...s, queuedMessages: remote }));
        saveQueue(conversationId, remote);
      })();
      pruneSlices(conversationId);
    },
    retryLoadMessages: () => {
      const id = get().activeConversationId;
      if (!id) return;
      writeSlice(id, (s) => ({
        ...s,
        loading: true,
        error: null,
        messages: [],
      }));
      void loadConversation(id);
    },
    /**
     * 重新加载一条 ACP 会话（见接口上的注释）。刻意**不复用 `loadConversation`**：
     * 那段 ACP 回放要求「当前就是这条会话」且「本地还没有消息」才写入 —— 后者是为
     * 首次打开准备的（不能盖掉用户刚发出的内容），而本项是用户主动要求的**覆盖式重建**，
     * 两条路径的写入策略正相反，合成一个带 flag 的 helper 只会把两套语义搅在一起。
     *
     * 回放为空就写成空：用户点这一项的含义就是「以 agent 侧为准重来一遍」，
     * 那边没有内容就是真的没有 —— 不像 `convertAcpConversation` 那样把「空」当失败
     * （它要造新会话，空会话没有意义；这里只是重建视图，空视图是诚实的结果）。
     */
    reloadAcpSession: async (conversationId) => {
      const api = get().getApi();
      const conv = get().conversations.find((c) => c.id === conversationId);
      if (!api || !conv || conv.backend !== "acp") return false;
      // 亮起装载标记：消息区显示「装载中」而不是旧内容（重载本来就是「整份换掉」），
      // 顺带清掉上一次遗留的错误态（与 retryLoadMessages 同一套起手式）
      writeSlice(conversationId, (s) => ({ ...s, loading: true, error: null }));

      /**
       * 「重新加载」也先看有没有在跑。跑动中只能从进程内快照 + 帧日志恢复：
       * session/load 会 teardown 正在跑的 ACP 进程（`ACP connection closed`）。
       */
      const activeRun = await peekActiveRun(conversationId);
      if (activeRun) {
        let attached = false;
        try {
          if (conv.configId) {
            const activeCwd = get().workspaces.find(
              (w) => w.id === conv.workspaceId,
            )?.path;
            try {
              const { messages } = await api.getAcpTranscript(
                conv.configId,
                conversationId,
                conv.acpSessionId ?? "",
                activeCwd ?? "",
              );
              // 快照为空（这份内存视图没建起来）时保留本地现场，别把用户已经看到的
              // 历史擦成空；非空才按「重新加载 = 整份换掉」覆盖。
              if (messages.length > 0) {
                writeSlice(conversationId, (s) => ({
                  ...s,
                  messages,
                  scrollResetSeq: s.scrollResetSeq + 1,
                }));
              }
            } catch {
              // 快照不可用不挡 attach：当前这一轮仍可由帧日志重建
            }
          }
          attached = await attachRun(
            conversationId,
            activeRun.assistantMessageId
              ? {
                  requestId: activeRun.requestId,
                  assistantId: activeRun.assistantMessageId,
                }
              : undefined,
          );
        } finally {
          writeSlice(conversationId, (s) => ({ ...s, loading: false }));
        }
        if (attached) return true;
        // attach 没接上（刚结束 / 连接失败）：继续走下面的 idle 重建
        writeSlice(conversationId, (s) => ({ ...s, loading: true, error: null }));
      }

      if (!conv.configId || !conv.acpSessionId) {
        writeSlice(conversationId, (s) => ({ ...s, loading: false }));
        get().setError("这条会话没有 agent 侧会话，重新加载不了");
        return false;
      }
      const cwd = get().workspaces.find((w) => w.id === conv.workspaceId)?.path;
      if (!cwd) {
        writeSlice(conversationId, (s) => ({ ...s, loading: false }));
        get().setError("找不到这条会话的工作区目录，重新加载不了");
        return false;
      }
      try {
        const { messages } = await api.getAcpTranscript(
          conv.configId,
          conversationId,
          conv.acpSessionId,
          cwd,
        );
        // 整体覆盖 + 复位落底同一次写入（同 loadMessages 的 resetScroll，别拆两帧）
        writeSlice(conversationId, (s) => ({
          ...s,
          messages,
          scrollResetSeq: s.scrollResetSeq + 1,
        }));
        return true;
      } catch (err) {
        // 回放失败（agent 不支持 load / 会话失效 / OpenCode 服务故障）：本地那份**原样留着**
        // （没覆盖过），原因走全局 error 弹 toast —— 与 convertAcpConversation 同一套收场
        get().setError(errorMessage(err));
        return false;
      } finally {
        writeSlice(conversationId, (s) => ({ ...s, loading: false }));
      }
    },
    /**
     * **重新加载这一条会话**：等价于「刷新页面 → 点开这个会话」，但只作用于它，不动别的
     * 标签、也不重挂 React 树（终端 / 面板现场都还在）。
     *
     * 两条路按后端分（与刷新页面后打开会话**完全同源**）：
     * - **内置**：拉服务端落盘的权威历史（`loadMessages`，覆盖式）。断线时本地渲染的
     *   那条「⚠️ 网络错误」会被真正的回复顶掉 —— 那正是用户刷新整页想达到的效果；
     * - **ACP**：消息在 agent 侧，只有 `session/load` 回放能重建（`reloadAcpSession`）。
     *
     * ⚠️ **正在跑就拒绝**：`loadMessages` 的过期判据是「代次」，本轮已经开跑时代次没变，
     * 服务端快照会把正在流式攒的现场整段盖掉（等于把直播掐了）。调用方（错误块那颗按钮）
     * 也据此禁用。
     */
    reloadConversation: async (conversationId) => {
      if (readSlice(conversationId).streaming) return false;
      const conv = get().conversations.find((c) => c.id === conversationId);
      if (conv?.backend === "acp") return get().reloadAcpSession(conversationId);
      const fetched = await loadMessages(conversationId, {
        loadError: true,
        resetScroll: true,
      });
      return fetched !== null;
    },
  };
}
