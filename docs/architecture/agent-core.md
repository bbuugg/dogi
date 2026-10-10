# 关键机制 · Agent 引擎与工具

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

### 4.3 会话形态：**创建时就选**，之后不可互切；模型按会话独立

- `AgentConversation` 有 `kind?: 'mastra' | 'acp'`（**形态标识 + 分派依据**）+ `modelId?: string`；
  mastra 多一个 `configId`（`AiModelConfig.id`），ACP 多两个绑定字段
  `acpAgentId`（`AcpAgentConfig.id`）+ `acpSessionId`（agent 侧的会话 id）。
- ⚠️ **形态在「新建会话」时就定了**（2026-10 改的，早期版本是「首条消息时由选中的模型定型」）：
  侧边栏工作区行尾的「新建会话」是**下拉**，第一组是「内置 Agent」，第二组是每个已登记的
  `ACP · <名字>`（一个 agent 都没登记时给一条指向设置的禁用提示）。入口是
  `createAgentConversation(workspaceId, kind, acpAgentId?)`，缺省 `kind` = 内置。
  消费方统一走 **`conversationKind(conversation)`**（`stores/types.ts`），它只为极老的
  「没有 kind 的存档」保留了一小段按 `acpAgentId` 的推断。
- ⚠️ **草稿的判据是显式的 `AgentConversation.draft === true`**（`isDraftConversation`），
  **不是 `!kind`** —— 形态既然创建时就定，用 `!kind` 会把所有真会话误判成草稿（它们刚从存档读回来）。
  草稿 = 还没发出首条消息的会话：会话页 / 标签 / 模型选择 / ACP 配置项都挂在它上面，但
  **不出现在侧边栏列表（`AgentPanel` 按 `meta.draft` 过滤）、不落盘**（守卫在 `persistConversation`）。
  发出首条消息那一刻 `sendAgentMessage` 清掉 `draft` 并落盘（标题取那条消息）。
  同一工作区已有草稿时「新建会话」复用它（连点两次还是同一个空页），复用时按传入的形态校正。
  落盘链路里**不出现** `draft`（`normalizeConversation` 是显式重建对象），所以读回来的永远不是草稿。
- **形态不可互切**，ACP 绑定（agent）也不可换，之后只能换模型。
  模型下拉按形态换内容：
  - **ACP：只列 `AcpAgentConfig.models`（设置 → ACP agent 里拉取并勾选的模型）**，
    走 `session/set_config_option` 切换、**不重建会话**；
  - mastra：列全部模型配置，**每条配置一个顶层分组**（组头 = 配置名，组内 = 裸模型 id，
    构建在 `features/agent/model-options.ts` 的 `configModelGroups`；没有可用模型的配置
    **不产出空分组**）。收起后横条上只显示裸模型名（配置名在组头里，塞进这点宽度会把
    模型名挤掉）。⚠️ 解析选中值用 `parseCfgModelValue`（**按第一个冒号切**）——
    模型 id 自己常带冒号（Ollama 的 `llama3:8b`、OpenRouter 的 `…:beta`），用
    `split(':')` 取第 3 段会把 id 静默截断。
  下拉**不再承担「顺带定型」的职责**。`setAgentConversationModel` 只服务 mastra，
  ACP 走 `setAcpConversationModel`（签名带 `acpAgentId`）。
- **ACP 的 agent 侧会话在「打开会话页」时就建好**（`agent:acp:prepare` → `session/new`，
  见 4.18 的「配置项」小节）：配置项立刻可用，不必等发完第一条消息。
  ⚠️ 那条常驻连接对「建了却一直不发消息」的草稿是纯孤儿，所以有
  `DRAFT_IDLE_TTL_MS`（15 分钟）兜底回收；真发出第一条（`acpSessionId` 落盘）就取消定时器。
- 终端 AI 助手的 `configId` / `modelId` **存在会话上**（`terminalConversations`），不是存在一个按 `sessionId` 的
  `AiChatState` 里 —— 换模型跟着会话走，跨终端页面接着聊也还是那个模型（见 4.22）。
- 请求里带上 `kind` + `configId` + `modelId` + `acpAgentId` + `acpSessionId`，主进程**优先用请求里的，
  取不到才回退**（形态回退到会话记录，再回退到 `mastra`）；会话选的配置被删掉时也要回退，
  否则该会话直接报「未配置」。
- `aiSettings.activeConfigId` 降级为**新会话的初始值**，设置页那颗星叫「默认」。
  （`activeAcpId` 已随架构调整移除：ACP 不再有「默认 agent」，绑定在导入时确定。）
- ⚠️ `saveAgentConversation` 判断 **`kind` / `configId` / `modelId` / `acpAgentId` / `acpSessionId`**
  都用 **`'x' in input`** 而不是 `??`：落盘时每次显式带上它们，`undefined` 表示「这个字段该清掉」，
  必须能覆盖旧值 —— 否则从某个模型切回默认就永远切不回来。
- ⚠️ **加字段时整条链路一起对齐**：`modelId` 曾经在链路上全程缺席（`persistConversation` → preload →
  `ipc/agent.ts` → `storage.saveAgentConversation`），会话里换的模型永远写不进磁盘，重启后回退成
  配置默认模型（用户报告「每个会话设置的模型重启后恢复成默认」）。`acpSessionId` 同款风险：
  它是 `session/new` 时由 agent 返回的，靠 `agent:acp-state` 广播回填、**回填后必须立刻落盘**，
  否则重启后那条会话就变成「没有绑定」的孤儿记录。
- `setAgentConversationModel` / `setAcpConversationModel` **不动 `updatedAt`**
  （配置变更不该让会话跳到列表最前）。
- ACP 常驻连接按 `conversationId` 缓存：同一工作区两个会话必须各有独立 agent 上下文，共用会串味。
- 旧存档（0.0.6 及以前）的 `backend` / `configId` 由 `storage.ts` 的 `normalizeConversation()`
  **读取时迁移**：`backend: 'acp'` → `kind: 'acp'` 且 `configId` → `acpAgentId`，`'ai-sdk'` → mastra；
  旧 ACP 会话本地存过的消息**直接丢掉**（新架构下那份归 agent 管，留着只会是一份不再更新的僵尸历史）。

### 4.4 工作区 Agent 是「工作区 → 多个会话」两层

- 会话 CRUD 走 `agent:conversations:list/save/delete`；**save 只返回单个会话**，不回传全量（会话带完整历史，体量大）。
- 落盘时机是「发消息时 + 一轮结束（finish / error）时」，**不是每个 token**。
- 切工作区用 `selectAgentWorkspace`（自动定位最近更新的**真会话**；一条都没有才退回该工作区的
  草稿，连草稿都没有才现建一个）；「当前会话」一律读 `activeAgentConversationId`，
  **不要再用 workspaceId 索引消息**。
- ⚠️ **「新建会话」是草稿，不进列表**（见 4.3 的 `isDraftConversation`）：选好形态后只打开这个
  工作区的新建会话页（内存里真实存在、可选中模型 / 改 ACP 配置项），**发出首条消息那一刻**才转正 ——
  标题取那条消息、清掉 `draft` 标记、进列表并落盘。侧边栏列表必须过滤草稿
  （`AgentPanel` 的 `byWorkspace` 按投影里的 `draft` 过滤）；别把它当 bug「修」回去，
  也别在别的列表里忘了过滤。
- 删除会话 / 工作区前先 `abortAgent(id)`，否则主进程的 agent 进程变孤儿。
- ⚠️ 切换功能区**不会**自动打开会话标签（对齐笔记）：只有点侧边栏会话行和新建会话才开标签。
- 会话视图是 **props 驱动**的 `AgentConversationView({ conversationId })`，`AgentPage` 只是薄接线层 ——
  `activeAgentConversationId` 是全局单例指针，多标签并存时只能指向一个，不改成 props 驱动就会两个标签渲染同一会话。

### 4.5 需要用户输入的工具走「挂起 + 广播 + 回填」

- 机制与命令执行确认卡完全相同：`tool.execute` 里挂起 → IPC 广播 → 渲染端渲染卡片 → 用户作答 →
  IPC 回填 resolve → `streamText` **当前回合继续**。
- broker 是全局单例（`ask-followup.ts` 的 `askFollowupBroker`），Agent 页与终端 AI 助手共用一组通道。
- **收尾必须做**（少一步就卡死）：`agent.ts` 的 `finally` 与 `abort` 都要 `askFollowupBroker.cancel(requestId)`
  **与 `clientToolBroker.cancel(requestId)`**（两个 broker 都是挂起式，见 4.23 第 34 条），把挂起的 Promise settle 掉。
- 终端会话请求里带 `sessionId`（工作区带 `workspaceId`），提问卡据此知道自己该送给哪个面板。
- 终端 AI 助手在折叠态收到提问会自动撑开面板（`hasFollowupForSession` 的 effect）。
- ⚠️ 提交后 `resolveFollowup` 立刻删 `followupRequests`，但工具结果（`output`）晚一拍才到 ——
  中间若直接退回普通横条，表单会闪一下。用组件内 `submitted` 本地标记顶住。

### 4.18 ACP 会话：发现 → 导入 → 回放，本地不存消息

ACP 是「别人的 agent 在别人的进程里管自己的会话」。本应用只做三件事：
**登记 agent、按 id 拉它的会话列表、把选中的会话绑成一条本地记录**。
消息一行都不落盘（见 4.3 的形态说明）。

- **登记 agent 只有一处入口**：**设置 → ACP agent**（`features/settings/AcpAgentSettings.tsx`），
  完整管理（检测 PATH / 手动添加 / 删除）+ **拉取并勾选模型**。侧边栏的**导入弹窗**
  （`features/agent/AcpImportDialog.tsx`）只做「选已登记的 agent → 拉取会话 → 导入」，
  footer 的「ACP 设置」按钮直达设置页 —— 别再把登记入口加回弹窗（用户明确要求收敛）。
- **模型来源 = 设置里勾选的模型**：`AcpAgentConfig.models` 由设置页「拉取」
  （`acpAgentService.listModels`，临时建连读 `session/new` 的 configOptions）后勾选，或手工填。
  会话页的模型下拉**只列这一份**（不读 agent 现场上报的那一份：里面常混着用不了的档位）；
  一个都没勾时给一条「先去设置里拉取」的禁用提示。ACP 走 `session/set_config_option` 切换、**不重建会话**。
- **发现（`session/list`）**：`acpAgentService.listSessions(cfg, cwd)` 建**临时连接**
  （initialize → 翻页拉列表 → 杀进程），按工作区目录过滤。agent 没广告
  `sessionCapabilities.list` 时**报明确错误**（不是返回空列表 —— 那会让人以为「没有会话」）。
- **导入**：只写一条本地记录（`kind: 'acp'` + `acpAgentId` + `acpSessionId`），标题取 agent 给的；
  同 agent + 同 sessionId 已存在就跳过，不会生成重复记录。
- **新建**：侧边栏「新建会话」里直接选 `ACP · <名字>`（形态创建时就定了，见 4.3）。
- **配置项（`session/new` 的广告数据当会话配置用）**：ACP 把「这个会话用什么」统一表达成
  `configOptions`，模型只是其中 `category: 'model'` 的那一项。
  - **创建时就取回**：打开一个还没建过 agent 会话的 ACP 会话页 → 渲染端发 `agent:acp:prepare`
    → `ensureSession` 建好常驻连接并 `session/new` → `AcpConversationState`（经
    `agent:acp-state` 广播）带回 **agent 侧会话 id + `configOptions` 整组**（`AcpConfigOption`：
    id / name / category / type / currentValue / 候选项，分组已拍平）。
    ⚠️ 这里**必须走常驻连接、不能用临时连接**：非持久化 agent 一杀进程会话就没了
    （4.18 老纪律）；临时连接只用于 `listSessions` / `listModels`。
  - **展示**：`features/agent/AcpConfigItems.tsx` 把**模型项与 `mode` 项之外**的配置项
    渲染成输入框上方的一排（select 用 agent 给的 name，boolean 用 Switch）。模型项仍由
    模型下拉负责（它列的是设置里勾选过的那份），`mode` 项驱动权限档位（主进程已把它并进
    `availableModes`，见 `applySessionResponse`），所以两处都不重复渲染。
    协议允许 `category` 缺失 / 未知，展示只依赖 `name`、下发只依赖 `id`，自定义项天然可用。
  - **切换**：`agent:acp:setConfigOption` → `session/set_config_option`（**不重建会话**），
    成功后 agent 通常回一条 `config_option_update`，主进程整组刷新并重新广播
    （**拿到空数组时按脏数据处理、不动本地**，免得一次异常抹光整组）。
  - 渲染端点一下先**乐观更新** `acpStates`，否则 IPC 往返那几百毫秒里控件会弹回旧值。
- **风格标记（`AcpAgentType` = `generic` / `opencode` / `pi`）**：`AcpAgentConfig.type`，
  **只是一枚给人看的标识，不参与任何分支逻辑**。fishwork 拿它决定会话里显示哪块模式 UI
  （opencode → 权限档、pi → 思考档），dogi 不这么做 —— 显示什么完全由 agent 上报的
  `configOptions.category` 驱动（见上一条），任何 agent 都能用，不必先在这张表里登记风格。
  它出现的地方：**设置 → ACP agent** 的新建 / 编辑弹窗（下拉）、列表行的徽标、
  **会话页标题后面的那枚胶囊**（文案与判定在 `src/shared/acp.ts`，主进程与渲染端共用一份）。
  探测 PATH 时认得出来的候选（opencode / pi-acp）在 `acp-detect.ts` 里直接带上它，
  用户不必再选一次；其余候选缺省 = `generic`（**generic 不显示徽标** —— 默认值挂出来等于没标）。
- **会话形态的标识**（ACP 与内置「除了消息流看不出区别」，而这决定了历史在谁手上、
  能不能签出 / 导出，所以要标出来）：
  - 侧边栏会话行的**行首图标槽**按 `等你回答 / 确认 > 运行中 > 已归档 > ACP > 内置` 渲染
    （ACP = `Bot`、内置 = `MessageSquare`，归档 = `Archive`；槽宽固定 size-4，见 `ConversationRow`）。
    行上另带 `data-conversation-kind`（`acp` / `mastra`）供探针断言。
  - 会话页标题**后面**给 ACP 会话挂一枚胶囊（`Bot` + 绑定的 agent 名 + 风格徽标；
    agent 配置被移除时显示「ACP Agent 已移除」）。**内置会话不给** —— 每屏都挂一枚等于没标。
- **回放（`session/load`）**：打开会话（会话标签 `visible`）时让 agent 把历史作为 `session/update`
  重放，主进程的 `HistoryAssembler`（`services/ai/acp-history.ts`，纯逻辑、可单独验证）
  按 `ContentChunk.messageId` 把 chunk 拼成消息列表，作为**一条 `history` 事件整段下发**
  （渲染端直接替换 `agentAcpMessages`）。
  - ⚠️ **工具结果的归属只能靠 `toolCallId`**：`ToolCall` / `ToolCallUpdate` 协议里**没有 messageId**，
    所以 `pushTool` 必须把结果路由回**调用所在的那条消息**，不能塞给「当前消息」——
    回放里「调用 → 完成更新」之间常夹着下一条消息的正文，塞错就会变成渲染端的**孤儿工具行**
    （正文后面莫名多出两条工具、整条消息被折叠，见 6.6 第 34 条）。
  - 回放出来的 parts 顺序**忠实于 agent**：末尾可能是工具调用（正文在前）。
    渲染端的折叠规则因此必须保证「正文绝不被折进折叠条」（`findTailStart`）。
  - ⚠️ **必须整段下发、不要逐条流式**：`session/load` 的响应本就在回放结束后才返回，逐条追加
    遇到「标签反复挂载 / StrictMode 双跑」就会把历史上屏两遍。主进程对同一会话的重复 `load`
    请求也做了去重（`loadRequests`）。
  - ⚠️ **回放不是一轮对话**：`finish` 事件落地前要先看「当时是否在回放」（store 里的 `acpLoading`），
    否则每次打开 ACP 会话都会弹一条「Agent 已完成」系统通知。
- **降级**：agent 没声明 `loadSession` 时，导入的 sessionId **在本连接里无法激活**
  （`session/prompt` 只认本连接建过 / 载入过的会话）。
  - 打开会话要历史 → **直接报错**（`allowNewOnUnsupportedLoad: false`）；
  - 提问 → 退回 `session/new` 建新会话并**重绑**（广播新 id + 弹一条 warning 说明历史看不到）。
    ⚠️ 别把这条降级挪到「打开会话」的路径上：那会让「看一眼历史」把绑定悄悄换掉。
- **模型切换**：`session/set_config_option`（optionId 取自 `session/new | session/load` 响应的
  `configOptions` 里 `category=model` 那一项），**不重建会话** —— 重建会丢 agent 侧上下文。
  实现是 `applyConfigOption` 的特化（`applyModel` 只认模型项），任意配置项走同一条路。
- **上下文统计（`session/update` 的 `usage_update`）**：ACP 的 `usage_update` 带 `{ used, size }`
  —— 「此刻挂在窗口里的 token」与「agent 自己的上下文窗口」，经 `toStreamEvent` 映射成
  `{ type: 'context-usage', used, budget }`。⚠️ 刻意**不**折进 `usage` 事件：那个是「这一轮的账」
  （会话累计要加总），混进来会把每次的水位都加一遍。渲染端按会话存在 `acpContextUsage`，
  输入框的圆环**有数据才出现**（见 4.20）。回放期间的那条也照发（`runLoad` 里单捡这一种）。
- ⚠️ **输入框工具行里 ACP 会话不显示「权限模式」与「MCP」开关**（`AgentPage` 里用
  `conversationKind(conversation)` 判，即 `isAcp`）：这两项只管**内置 agent 的工具**，
  ACP 会话的工具、审批、MCP 全归外部 agent 自己管 —— 给开关只会让人以为改了有用。
- **删除**：默认只删本地绑定（agent 侧会话留着，下次还能导入回来）；删除确认框里可勾选
  「同时删除 agent 侧会话」（走 `session/delete`，agent 没声明该能力就只提示、本地照删）。
- **消息的本地镜像** `agentAcpMessages: Record<conversationId, AgentChatMessage[]>` 只在内存里：
  重启后为空、靠重新 `session/load` 恢复。因此 ACP 会话**不提供**「编辑重发 / 从这里重新开始」
  （本地删改只会让画面与 agent 侧上下文不一致，重开又回放回来）—— UI 侧按 `kind` 禁用了入口。

### 4.20 上下文压缩 + 会话累计 token：压缩只改「这一次请求」，不改历史

移植自 fishwork（`packages/agent/src/context.ts`）。**三道闸**，顺序固定：
先按**条数**截断（`AiModelConfig.contextMessages`，缺省 20），再按**上下文窗口**压缩，
统计口径把「系统提示词 + 工具 schema」也计进去。

- **窗口按模型配，不按配置配**：`AiModelConfig.contextWindows`（`模型 id → token 数`）。
  窗口是模型自己的属性而不是网关的属性 —— 同一个 baseURL 下 128k 与 200k 的模型可以并存。
  解析链 `resolveContextWindow(contextWindows, modelId, contextBudget)`：
  **显式窗口 > 遗留 `contextBudget` > 200k**（真源在 `@shared/context-budget`，前后端共用）。
  ⚠️ `contextBudget` 是**遗留字段**：改口径之前是「一份配置一个数字」，留着它是为了让老配置
  继续按原数字生效 —— 删掉等于给所有老用户平白把 80k 改成 200k。
  设置页在模型 id 后面**只读**展示窗口（灰字「默认」= 走兜底），要改点行上的 ✎。
  ⚠️ `saveConfig` 是**整份替换**，「保存配置 / 改网关 / 删除模型 / 拉取模型合并」四条路径
  都必须原样带回 `contextWindows`，漏一处就等于把已配的窗口清空。
- **触发线是「窗口 × `COMPRESS_TRIGGER_RATIO`(0.8)」，不是窗口本身**：留出的 20% 用来吸收
  「系统提示词 + 工具 schema 的估算误差」与「本轮输出预留」—— 等到把窗口真正塞满才压，
  上游已经先报 context_length_exceeded 了。圆环据此画线，与真正触发的阈值同源。
- **`baseTokens` 计入 before/after**：系统提示词与工具 schema 每轮都发出去却不在 `messages` 里，
  不计进去的话提示条上「压缩前后」会看着几乎没变化。⚠️ 它的输入（`instructions` + `tools`）
  必须在压缩**之前**算好，所以两条链路里 `new Agent({ instructions })` 的内联写法都改成
  先抽局部变量。取不到工具 schema 时只算描述、宁可低估也**不许抛错**。
  手动压缩那条路不建 agent、拿不到它，就按纯消息算 —— 圆环已标「压缩后估算」，别去改。
- **按轮摘要而不是按 token 滑窗**：滑窗从中间切断 tool-call / tool-result 会破坏协议
  （tool 消息必须紧跟它的 assistant），按轮切天然合法；代价是粒度粗，但摘要也是模型做的。
  保留区按**窗口**的 50% 算（不按触发阈值再打折，否则刚压完没几轮又要压），
  且**不从保留预算里扣 `baseTokens`** —— 它已经计入触发阈值了，再扣就是扣重。
- ⚠️ **压缩结果不落盘、不改会话记录**：它只决定「这一次 `agent.stream()` 带哪些消息」，
  屏幕上的历史始终是原文（可翻 / 可复制 / 可编辑重发）。所以**会话累计 token 是现算的**
  （`@shared/agent-usage` 的 `sumUsage`），不在会话上另存累计字段 —— 另存就多出一个可能与消息对不上的副本。
- **摘要失败 → 回退成截断**（`truncated: true`）：保证请求还能发出去，不会因为一次摘要失败把整轮搞挂；
  界面如实写「摘要失败，旧轮已截断丢弃」，不假装细节还在。
- 事件 `context-compressed` 只是**通知**，不进消息 parts。⚠️ 必须 `setTimeout(…, 0)` 延后再发：
  此刻 requestId 还没登记进 `chatConversations` / 渲染端的 `aiRequestSessions`，直接广播会被整条丢掉（同 4.2）。
- 消息列**顶部**只粘一条提示条（`ContextNoticeBar`）：**上下文已压缩**（自动 / 手动压缩都写它）。
  ACP 会话不参与（历史由 agent 自己管，`messages` 恒空）。
  ⚠️ **会话累计 token 不在这里**，它在输入框的上下文圆环（`ContextRing`）详情里的「会话累计」段 ——
  与 fishwork 一致。累计每轮都在变，粘顶部会一直晃，而且是圆环里同一份数据的第二个副本
  （迁移时正是这个重复，别再搬回顶部）。
- ⚠️ **上下文圆环由「有没有数据」决定显不显示，不按会话形态**：内置会话等第一轮的真实
  `inputTokens`；ACP 会话等 agent 的 `usage_update`（`acpContextUsage`，见 4.18）——
  不少 agent 不报，那时不该给一个永远空的圈。ACP 那一档传 `source: 'agent'`，
  详情里不给「压缩上下文 / 清除摘要」（上下文在 agent 侧，按了也没用），分子分母也换成
  agent 报的水位 / 窗口大小，**不与内置那条从消息 usage 推出来的值混算**。
- ⚠️ 圆环的分母按**会话选中的模型**查表（`resolveContextWindow(windows, conversation.modelId, …)`）：
  一份配置下不同模型窗口不同，用配置级的旧值会算错百分比。
- 验证：`scripts/verify-context-compression.mjs`（`.tooltest` 包装跑真源码，覆盖窗口解析三级回落、
  0.8 触发线、`baseTokens` 计入 before/after 与触发判定、未超阈值零拷贝、切轮边界、
  摘要失败回退、非法窗口回退；摘要成功路径要真调模型，属集成验证）。

### 4.22 两条 AI 线合并成一台引擎：终端助手走 `scope:'terminal'`

**一台引擎、两种作用域。** 工作区 Agent 与终端 AI 助手共用 `services/ai/agent.ts` 的 `AgentService`，
由 `agent:chat` 请求里的 `scope`（`'workspace' | 'terminal'`）分派；旧的 `services/ai/ai.ts`
（每终端一个 `AiAssistant` 实例）与 `ai:chat` / `ai:abort` / `ai:confirm` / `ai:chat-event` 四条通道
**已整体删除**，别再加回来。

| 维度 | `scope: 'workspace'` | `scope: 'terminal'` |
| --- | --- | --- |
| 工具 | `list_files` / `read_file` / `write_file` / `edit_file` / `search_files` / `find_files` / `execute_command` / `delete_file` / `browser_*` / `read_skill` | `run_in_terminal` / `send_keys` / `read_terminal_output` / `list_terminal_sessions` / `ask_followup_question` |
| 共有工具 | `read_tool_output`（`scope:'both'`）：读超长工具输出落下的产物文件（见 4.24）；`web_fetch`（`scope:'both'`）：抓网页转 Markdown（见 4.32） | 同左 |
| 系统提示词 | `agent-core` 的工作区提示词 | `terminal-tools.ts` 的 `buildTerminalSystemPrompt`（含平台提示） |
| 归属 | `requestMeta` 按 `conversationId` 记 `workspace` | 记 `targetSessionId`（**来自发起消息的那个终端页面**） |
| 会话存储 | `conversations/` 目录 | `terminal-conversations/` 目录（第二个 `ConversationStore` 实例） |

- **工具绑定按请求算，不记在会话上**：`ctx.targetSessionId` 由请求携带，所以历史会话换一个终端
  接着聊时，工具自然作用在新终端上（会话记录里不存 terminalId）。
- ⚠️ **终端会话绝不进 `agentConversations`**：靠**存储边界**保证 —— `ConversationStore('terminal-conversations')`
  是独立实例、独立目录、独立的一组 `storage.*TerminalConversation*` 方法。
  **别**改回「同一个池 + 消费方过滤」，那等于把过滤义务摊给每一个列表（侧边栏、搜索、导出、统计…）。
- **草稿判据与 Agent 不同**：Agent 草稿 = `!kind`（4.3），终端草稿 = `terminalDrafts[sessionId]` 里
  存在（内存态，不落盘）。两者都在**发出首条消息那一刻**转正：标题取那条消息、进列表、落盘。
- **清空历史已移除**：改成左侧会话列表里的逐条删除（Popconfirm → `agent:terminal-convs:delete`），
  会话池是跨终端页面共享的，一刀清掉会连带删掉别的页面正在用的会话。
- **模型按会话独立**：终端会话同样有 `configId` / `modelId`，下拉在卡片头部。
- **确认卡共用一张表**：工作区来源带 `workspaceName`，终端来源带 `sessionId` / `sessionTitle`
  （`AgentConfirmRequest = AiConfirmRequest`），一条 `agent:confirm` 通道，`pendingConfirms` 一张表。
- **验证**：`scripts/verify-terminal-chat.mjs`（隔离实例 + 进程内 mock LLM：作用域工具集、终端会话
  独立存储、草稿转正、逐条删除、重启后仍在）。

### 4.23 工具注册表 + 客户端工具（A 方案：定义随请求、权限在渲染端）

工具不再是「谁需要就自己 `build()` 一份」，而是**主进程一份静态注册表** + 每次请求动态组装。

**注册表**（`services/ai/tool-registry.ts`）：`AiToolDef` = `{ name, description（字符串或按 ctx 现算的函数）,
inputSchema, scope: 'workspace'|'terminal'|'both', available?, execute(input, call, ctx) }`。
`builtin-tools.ts` 的 `ensureBuiltinToolsRegistered()` 在启动时一次性登记
终端组 + 工作区组 + `read_tool_output` + `read_skill` + `ask_followup_question` + `web_fetch` +
浏览器组（浏览器组要渠道，所以传的是 `() => BrowserChannel` 的延迟读取）。

`buildToolset({ ctx, extra?, clientTools? })` 的顺序与让位规则：

1. 内置定义，按 `scope` + `available` 过滤 —— `available` 收 `{ctx, mcpToolNames}`，
   用途是「没技能就不暴露 `read_skill`」「MCP 带了 `browser_*` 就整组让位」（两套同名会静默互相覆盖）；
2. **随请求携带的客户端工具**：与内置同名时**让位并 warn**（内置优先）；
3. `extra`（MCP 工具）最后展开，同名覆盖一切（历史行为，别动）。

⚠️ **别在注册层加权限闸**：改动类工具的闸在自己的 `execute` 里（`guardWrite` 要在「确认也会失败」
的预检之后才弹卡，包在外面只会白白打扰用户）；客户端工具**根本没有主进程闸**（见下）。

**客户端工具**（渲染进程执行的能力：在文件视图里打开文件、切标签、插件注入的界面能力…）：

- **定义随请求走**：`registerClientTool(def, handler)` 是纯渲染端注册（`stores/client-tools.ts`，
  内存态），发送时由 `sendTerminalMessage` / `sendAgentMessage` 统一带上
  `clientTools: listClientToolDefs()`。**没有**「预注册 + 主进程持有」的通道，也别加回来 ——
  带哪组定义是**哪个页面在发消息**决定的，主进程预先持有就等于把作用域判断搬到主进程。
- **执行 = 挂起 + 广播 + 回填**：`clientToolBroker.invoke()` 挂起 → 广播 `clientTools:invoke`
  （带 `callId` / `requestId` / `conversationId` / `scope`，见 4.2）→ 渲染端 `handleClientToolInvoke`
  执行 → `clientTools:result` 回填 resolve，**当前请求的模型循环随即继续**
  （不是客户端另起一次请求 —— 那要重建整条历史且丢中间态）。
- **权限与确认全在渲染端**：`full` 直接执行；`confirm` 弹 antd `Modal.confirm`，
  **拒绝时作为正常工具结果回填**（"用户拒绝了这次调用…"），模型看得见原因并改道 —— 不是 tool error。
- ⚠️ **任何分支都必须回填一次**，否则主进程那个 Promise 永不 settle、整轮卡死
  （abort / 流结束的 `cancel(requestId)` 只是兜底，正常路径别依赖它）。
- 收尾纪律与 ask-followup 同款：`AgentService` 的 `finally` / `abort` 都要 `clientToolBroker.cancel(requestId)`。
- 探针要造客户端工具时用 `window.__clientTools`（与 `window.__store` 同一个 CDP 调试约定，
  只在渲染端暴露，不进 preload 白名单）。
- **验证**：`scripts/verify-tool-registry.mjs`（注册纪律 / 作用域 / `available` / MCP 覆盖 /
  动态描述 / 随请求组装与同名让位 / broker 广播-回填-取消）。

### 4.24 超长工具输出落「产物」：写命令时订阅实时流，超限给 id 让模型续读

工具输出超过内联上限时不能只截断——被砍掉的中段模型再也拿不回来，命令跑了两万行日志时
等于「只看到头和尾，中间发生了什么全靠猜」。做法是 `services/ai/output-artifact.ts`：
**超限时把完整输出落到 `userData/tool-output/<id>.txt`，工具结果里给模型 id / 总量 / 下一次该带什么参数**，
模型用 `read_tool_output` 按 `(id, offset, length)` 一段段续读。

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `ARTIFACT_INLINE_MAX` | 12000 | 超过就落盘（终端工具） |
| `ARTIFACT_HEAD_CHARS` | 3000 | 内联里保留的**开头** |
| `ARTIFACT_MAX_CHARS` | 4MB | 单个产物的上限，超出后 descriptor 标 `truncated` |
| `ARTIFACT_READ_MAX` | 20000 | `read_tool_output` 单次最多返回多少字符 |

- **内联文本 = 开头 + 说明 + 滚动结尾**。说明里必须写清三件事，缺一个模型就接不下去：
  总量、省略了多少、**下一次调用的完整参数**（`{"id":"…","offset":3000,"length":8000}` 原文嵌在句子里）。
- ⚠️ **head / mid 是滚动预览，与文件写入互不影响**：哪怕第一块就超过内联上限、已经 spill，
  开头照样要从这一块的前 `headChars` 个字符里填（早期实现给 `head` 加了 `&& !this.stream` 的条件，
  于是「一条超长命令」的内联里只剩结尾，模型连命令是什么都看不到）。
  `mid` 必须是**滚动**的（`pushTail` 按预算截尾），否则内联的「结尾」是 spill 那一刻的内容，不是真正的末尾。
- ⚠️ **必须订阅实时 `data` 流，不能「先记长度、事后取增量」**。环形缓冲 256KB 是**有损**的，
  一条刷屏命令跑完再取增量只会拿到 `''`（模型收到「完全没有输出」）。所以 `captureDuring()`
  在**写命令之前**就挂上 `sessionManager.on('data')`，写完等 `waitMs` 再摘监听。
  ⚠️ 因此 `TerminalSession.outputLength()` / `outputFrom()` 已从接口与三个会话类里**删除**，
  只在注释里留了「为什么删」——别为了让新代码好写把它们加回来，那正是这个 bug 的源头。
  同理 `execute_command`（`agent-core/tools.ts`）也从 `child.stdout.on('data')` 边收边写，
  它原来是 `slice` 截断，丢了就永久丢了。
- **ANSI 要跨块有状态剥离**：转义序列会被 chunk 边界劈开，`AnsiStripper` 永远从**最后一个 ESC**
  往后扣住（`MAX_HOLD = 512` 封顶）交给下一块，逐块独立正则会把半截的 `\x1b[` 当普通字符吃掉。
- ⚠️ **id 是安全边界**：文件名由 `newArtifactId()` 生成，`artifactPath()` 用
  `/^[a-z0-9-]{6,80}$/` 校验后才拼路径（顺带挡掉 Windows 保留名），**任何地方都不要把路径或 `dir` 交给模型**。
  跟 `workspace-fs.ts` 的 `resolveInside` 是同一类防护——模型能传参数，就能传 `../../`。
- **清理**：删会话 / 删工作区时 `purgeArtifacts(conversationId)`（id 里嵌了会话 slug，按 `${slug}-` 前缀删），
  写在这三处 `ipc/agent.ts`：`conversations:delete` / 工作区删除循环 / `terminal-convs:delete`。
- **验证**：`scripts/verify-output-artifact.mjs`（纯 Node，44 条）+ `scripts/verify-terminal-chat.mjs`
  第 3b 节（真界面端到端）。

### 4.31 项目约束文档（`AGENTS.md`）：**全文注入**，且排在提示词最后

工作区根目录的 `AGENTS.md`（回落 `CLAUDE.md`）是**项目维护者写给 AI 的规则**
（构建命令、验证方式、代码约定、禁止事项、踩过的坑）。实现是 `agent-core/project-doc.ts`
（移植自 fishwork），由 `services/ai/agent.ts` 的 `prepareWorkspaceTurn` **每轮现读**（磁盘即真源，
用户改完下一轮就生效，与技能扫描同一做法），非空时经 `buildProjectDocSection` 拼进
`buildAgentSystemPrompt(...)` 的最后一段。

- **为什么全文注入而不是「给路径让模型自己 read_file」**：约束要在模型**动手之前**就生效，
  等它想起来去读时第一版改动往往已经写歪。渐进式披露适合「技能」这种按任务触发的东西，
  不适合全程适用的规则。
- **为什么只读工作区根目录、不向上找父目录**：向上递归会在 monorepo 里把无关的父级文档
  一起吸进来，稀释真正的项目约束。
- **为什么放提示词最后**：段落里声明了「优先级高于本提示词里其它通用约定」，
  紧接着的一段在提示词里权重更高 —— 放最后才不会被前面的通用约定稀释。
- 注入上限 64K 字符，**按 `## ` 边界截断**（宁可少给一条完整规则，也不要把规则切成半句话；
  最后一个 `## ` 不足上限一半说明没按二级标题分节，那就硬截），截断时明确写「前百分之多少 +
  先用 read_file 补全」。
- 单独校验：`空文件 / 纯空白`跳过（不注入空文档）、剥 UTF-8 BOM（否则模型把开头 `#` 当内容）、
  超过 4MB 的文件不读（防误命名成 AGENTS.md 的巨型文件）、0 字节跳过。
- **同段的兄弟机制**：系统提示词里还有**权限模式段落**（`buildPermissionSection`，同为移植自
  fishwork）：让模型**预先知道**哪些动作会被拦下来 —— 不写这段的实际后果是 confirm 模式下
  工具被拒只被当成普通失败，换个写法再试一遍，反复弹确认卡。
- ⚠️ 别把这段接进**终端 AI 助手**那条线（`scope: 'terminal'`）：它常挂 SSH 远端，
  本地工作区的 AGENTS.md 与那条会话无关（技能也是同样的取舍，见 4.7）。
- 验证：`scripts/verify-agent-project-doc-web-fetch.ts`（见 5.2）⚠️**已移除**。

### 4.33 权限三档 + 确认卡四档 + 单条命令的停止

**权限三档**（`AiPermissionMode`，输入框处实时切换，存在 `aiSettings.permissionMode`）：

| 档 | 语义 | 改动类工具的行为 |
| --- | --- | --- |
| `full` | 完全放开 | 直接执行，不弹卡 |
| `confirm` | 确认 | 弹确认卡，等用户裁决 |
| `readonly` | 只读 | **直接拒绝**（不弹卡）—— 弹了也没用，这一档的语义就是「不许改」 |

- 闸门是 `agent-core/tools.ts` 的 **`guardWrite(ctx, denied, req)`**，**每个改动类工具在自己
  `execute` 里调用**，返回 `null` = 放行、返回字符串 = 拒绝理由。
  ⚠️ **拒绝是「当工具结果返回」而不是抛错**：抛错会打断整轮对话，而「用户拒绝了这一步」本来
  只是这一步没做成，模型应该据此换方案（抛错它只会当成工具坏了）。
- ⚠️ 闸门**不能包在工具注册层**（`tool-registry.ts`）：`guardWrite` 排在「确认也会失败」的预检
  **之后**（比如 `edit_file` 的 oldString 匹配不上时就该直接报错，不该先打扰用户点一次允许）。
  包在注册层会让用户为一次注定失败的调用白点一次卡。
- `readonly` 的文案要**明确告诉模型「是模式挡的」**（「当前权限模式为「只读」，…请只做只读的
  分析与说明」）—— 不说清它会以为是工具坏了，换个写法反复重试。
- 系统提示词里也有对应的 `buildPermissionSection()`（`agent-core/agent.ts`，移植自 fishwork）：
  让模型**预先知道**哪类动作会被拦，否则它会反复弹确认卡。改档位文案时两处都要改。

**确认卡四档**（`ConfirmDecision`，文案见 `@shared/confirm.ts` 的 `BUILTIN_CONFIRM_OPTIONS`）：

| 档 | 语义 |
| --- | --- |
| `allow_once` | 允许这一次 |
| `allow_always` | 总是允许（本会话 + 本工具） |
| `reject_once` | 拒绝这一次 |
| `reject_always` | 总是拒绝（本会话 + 本工具） |

- **「总是」的记忆是进程内的**（`AgentService.alwaysDecisions`，key = 会话 id → 工具名 → `'allow' | 'reject'`）。
  命中记忆时 `requestConfirm` **直接回一个 once 档、不弹卡也不排队** —— 用户已经表过态了。
  ⚠️ **刻意不落盘**：把「永远允许」写进磁盘意味着一次误点永久放行某类动作（`rm -rf` 也在里面），
  代价远大于重启后再问一遍。会话被删除时要 `forgetConfirmMemory(conversationId)`，否则同 id 复用会串味。
- 确认请求**全局串行**（`confirmChain`）：同一时刻只等一张卡。中止 / 一轮结束时
  `clearPendingConfirms(requestId)` 把挂起的卡按 `reject_once` 收尾 —— 确认卡默认不限时（`confirmTimeoutMs = 0`），
  全靠它兜底，否则执行流会永远挂着。
- 无 UI 接入（`confirmSink` 为 null，探针场景）时**直接放行**，避免流程卡死。
- ACP 会话的档位按 agent 在 `session/request_permission` 里广告的 `option.kind` **收窄**
  （`confirmOptionsFromAcpKinds`）：硬塞一个 agent 不认的 option 会被静默丢弃，界面上就会出现
  一颗点了没反应的按钮（见 4.18）。

**单条命令的停止**（`services/ai/command-stop.ts` + `agent:command:stop`）：

- 一轮里模型可能连跑好几条 `execute_command`，其中一条卡住（`npm run dev` / `tail -f` / 不返回的构建）。
  用户此时只有「停止整轮」一个把手 —— 那会把还没跑的步骤和已经想好的后续一起掐掉。
- 所以每条 `execute_command` 跑起来时按 `toolCallId` 登记一个「杀手」（`commandStopRegistry.register`），
  工具行上单独给一颗「停止」，只杀这一个子进程树；命令返回「已被用户停止」，**模型继续往下跑**。
- ⚠️ **与整轮停止是两条路，别混**：整轮停止走 abort signal（所有工具一起收尾、这一轮结束）；
  单条停止只 kill 子进程，对话不受影响。
- ⚠️ 只有工作区的 `execute_command` 登记杀手。终端的 `run_in_terminal` **不能**停 ——
  它把命令写进用户自己的终端，进程属于那个终端；ACP 的命令整个活在外部 agent 进程里，更无从下手。
  渲染端用 `ToolCallRow.tsx` 的 `STOPPABLE_TOOLS` 白名单控制按钮出现的位置，**别按「看起来像命令」判断**。
- `unregister` 必须在命令收尾的 `finally` 里调用（成功 / 失败 / 中止都要摘），否则表会一直长。
- 验证：`verify-agent-file-tools.mjs`（guardWrite 在确认模式下的拒绝 / 放行）、
  `verify-terminal-chat.mjs` 第 4 节（确认由渲染端弹框、拒绝是正常结果）。

### 4.34 运行中插话（steer）+ 会话签出 / 导入导出

**运行中插话**（`services/ai/steer.ts`）：

- 用户在流式输出期间想到一句话（「别改那个文件」「顺便把测试也跑了」），不必等这一轮跑完再发。
- 机制：`steerRegistry` 按 **`conversationId`**（**不是 requestId**）存一句话，
  在**下一个工具步的边界**由 `tool-registry.ts` 的统一包装 `appendSteer()` 拼到工具结果末尾 ——
  模型最可能立刻照做的位置就是「刚看到工具结果」的那一刻。
- ⚠️ **准入只看「这条会话此刻有没有在跑的一轮」，不看准备阶段是否结束**
  （`AgentService.steer` → `isConversationRunning`）。准备阶段（启动 MCP / 压缩上下文）动辄好几秒，
  那正是用户最想插话的时刻；按 requestId 判准入会让它「最需要的时候用不了」。
- ⚠️ **`appendSteer` 是「取走」语义**（drain）：取到了就从注册表里删掉。因此
  **子 Agent 组装工具集时必须 `allowSteer: false`**（见 4.35），否则子 Agent 内部某一步把用户的插话
  吞进自己的流程，父 Agent 就永远等不到了。
- ⚠️ **插话不是「只此一次」**：渲染端同时把它当成一条**普通 user 消息**按**真实时间顺序**落进历史
  （`u-<ts>-steer`，紧跟在正在流的那条助手消息之后）。所以「没赶上工具步」也不会丢 ——
  下一轮照样看得到。代价是几十个 token 的重复，换「两个方向都正确」。
- ⚠️ 正因为插话会把 user 消息插到**正在流的助手消息之后**，两处都不能再用
  `messages[messages.length - 1]` 判断「最后一条助手消息」：
  - `AgentPage.tsx` / `AiPanel.tsx` 用 `lastAssistantIndex`（从后往前找 `role === 'assistant'`）
    决定流式光标与「重试」按钮挂在哪一条上；
  - `stores/agent-helpers.ts` 的 `notifyAgentFinished` 同理（否则通知正文会取到那条插话）。
- `steer()` 返回 `false` = 这条会话没在跑 → 渲染端回退成**普通发消息**（`submitAgentMessage`），
  不是报错。
- 一轮结束（`runStreamWithRetry` 的 `finally`）与准备阶段早退（`forgetRequest`）都要
  `steerRegistry.clear(conversationId)`，防止残留的插话串到下一轮。

**会话签出 / 导出 / 导入**：

- **签出（fork）**：`conversationStore.fork(id, upToMessageId?)` —— 复制成一条新会话（新 UUID，
  标题加「 · 分支」），在 `upToMessageId`（含）处截断。⚠️ **不继承 `contextSummary`**（检查点属于
  原会话的压缩历史，带到分支上会让分支少掉一段它其实有的原文）**也不继承 `archived`**。
- **导出**：`services/ai/conversation-transfer.ts`，外壳 `{ format: 'dogi-conversation', version: 1,
  exportedAt, conversation }`，后缀 `.dogi.json`。`withWindowOnTop()` 是 electron#32857 的绕法
  （不把窗口提到前面，Windows 上系统对话框可能被压在后面）。
- **导入**：新分配 UUID、**强制 `kind: 'mastra'`**，并丢掉 `configId` / `modelId` / `acpAgentId` /
  `acpSessionId` / `contextSummary` / `archived` —— 这些绑的是**导出方的机器与账号**，照搬过来
  只会得到一个指向不存在配置的坏会话。`parseImport` 同时接受带外壳和裸会话两种文件；
  上限 `MAX_IMPORT_BYTES = 50MB`。
- **签出的入口在「消息」上，不在侧边栏的会话行上**（`MessageForkButton`，挂在每条消息 hover
  才露出的操作行里，与复制 / 删除同列）：签出的粒度本来就是「到这条为止的历史」，挂在会话上只能
  整条复制，用户还得自己去想从哪一步分叉。`upToMessageId` 传的就是那条消息的 id。
  侧边栏的「更多」菜单里只剩**导出**（低频）+ **删除**（收在菜单最下方，危险色、有分隔线）。
- ⚠️ **签出与导出都拒绝 ACP 会话**（消息不在我们这儿，导出去是个空壳）：签出按钮对 ACP 会话
  不渲染（`canFork`），侧边栏的「更多」菜单也只给**删除**、不给**导出**（`canExport`）——
  但仍要渲染菜单，再渲染一个全灰或干脆没有的菜单都只会让人反复去点。
- ⚠️ 导出 / 导入都从**主进程的会话存储**读，不用渲染端那份：渲染端可能正握着一个流到一半的会话。
- 验证：`verify-agent-conversation-model.mjs`（落盘的 `in` 语义：不带某字段再存时保留旧值、
  显式 `undefined` 才清空 —— 与本节同一套语义，见 6.6 第 37 条）+ 手工清单
  （插话在流式期间发出 → 工具结果末尾带上它且历史里多一条 user 消息；签出一条分支后原会话不变；
  导出 → 换个工作区导入 → 能继续对话）。

### 4.35 子 Agent（`delegate` 工具）

`services/ai/sub-agent.ts`（对齐 fishwork 的 explorer / reviewer）。**默认关闭**
（`aiSettings.subAgents`，设置 → AI → 运行）。

- 形态与 fishwork 不同：dogi 的子 Agent **没有独立会话**，它就是父 Agent 的一次工具调用 ——
  父 Agent 拿到的是一段可继续推理的文本。好处是不需要新会话类型 / 新存储 / 侧边栏多一堆条目；
  代价是中间过程（读了哪些文件、跑了多少步）界面上看不到，只有一行「delegate 运行中」。
- **怎么开启**：`prepareWorkspaceTurn` 里 `if (settings.subAgents) ctx.subAgent = createSubAgentRunner(...)`。
  `delegate` 的 `available` 只看 `!!ctx.subAgent` —— 没注入则**工具根本不出现在工具表里**
  （比给一个恒失败的工具干净：模型看不到就不会去用）。
- ⚠️ `model` / `modelSettings` 因此**必须在 `ctx` 之前算好**（`prepareWorkspaceTurn` 里
  `resolveModel` 已提前到 ctx 上方）。这一步是纯同步的，提前没有副作用。
- **三条硬约束**（改这个文件时别破坏）：
  1. **只读**：工具白名单写死为 `SUB_AGENT_TOOL_NAMES`（`list_files` / `find_files` / `read_file` /
     `search_files` / `git_read` / `read_tool_output`），且子 Agent 的 `permissionMode` 强制 `'readonly'`、
     `requestConfirm` 一律回 `'reject_once'` —— 三重保险，任何一层被改坏还有两层挡着（fail closed）；
  2. **不吞插话**：`buildToolset({ only, allowSteer: false })`（见 4.34 的 drain 语义）；
  3. **不抛错**：失败一律返回说明性文本 —— 抛错会让整轮以 error 收场，而子 Agent 失败本来只是
     「这一步没做成」，父 Agent 完全可以自己接着干。
- 每个子 Agent 各造**独立的 `fileState`**：让子 Agent 的读取去满足父 Agent 的「先读后改」会
  悄悄削弱那道闸（父 Agent 明明没读过却能直接改）。
- 步数上限 `DEFAULT_SUB_AGENT_MAX_STEPS = 30`（`@shared/ai-timeouts`），**故意远小于**父 Agent 的
  500：子 Agent 的输出要回填成一条工具结果，它跑得越久父 Agent 那一轮被卡住的时间越长；
  30 步足够「把相关文件读一遍 + 给出结论」，再多通常是它在原地打转。
- 报告回填上限 `REPORT_INLINE_MAX = 12_000` 字符，**超了直接截断、不落产物**：子 Agent 的报告是
  「结论」不是可续读的原始输出，留一个产物 id 反而诱导父 Agent 去读一堆它本就不该关心的细节。
- `tool-registry.buildToolset` 为此加了两个选项：`only?: readonly string[]`（内置工具白名单，
  只过滤内置定义，不影响 MCP / 客户端工具）与 `allowSteer?: boolean`（缺省 true）。
- 提示词里刻意写了「**不要反问**，信息不足就按最合理的假设继续，并在末尾用「假设」一节列出」——
  子 Agent 没有人可以对话，反问等于空转。
- 验证：`scripts/verify-sub-agent.mjs`（⚠️**已移除**；47 条断言：白名单只读、available 门、三种失败路径不抛错、
  `only` / `allowSteer` 语义、提示词约束、步数上限）。

### 4.36 MCP：三种传输 + 每会话的允许清单

**三种传输**（`services/ai/mcp.ts` 的 `createTransport`）：

| `transport` | 传输类 | 必填 |
| --- | --- | --- |
| `stdio`（缺省） | `StdioClientTransport` | `command` + `args` |
| `http` | `StreamableHTTPClientTransport` | `url` |
| `sse` | `SSEClientTransport` | `url` |

- `transportOf()` 把缺失 / 脏值一律归一到 `stdio`（旧存档没有这个字段，不能因此连不上）。
- `headers` 只在 http / sse 生效，透传成 `requestInit.headers`。
- ⚠️ `connect()` 里读子进程 stderr 必须写成
  `(transport as { stderr?: NodeJS.ReadableStream }).stderr?.on(...)` —— http / sse 的 transport
  **没有 `stderr`**，直接 `.stderr.on` 会在远程 server 上崩。
- URL 为空 / 不是合法 URL 时**抛明确的中文错误**（「http 传输缺少服务地址（url）」/「服务地址不是合法 URL：…」），
  不要丢给 SDK 报一句看不懂的话。
- 传输相关的**纯逻辑放 `@shared/mcp.ts`**（`mcpTransportOf` / `MCP_TRANSPORT_LABELS` /
  `mcpServerSummary`），主进程与设置页共用一份 —— 否则「列表里显示的是 url 还是 command」这种
  小事会在两处漂移。

**每会话的 MCP 允许清单**（`AgentConversation.mcpServerIds`，与「全局启用」是**两件事**）：

- `undefined` = **不限制**（用全部全局启用的）—— 这是旧会话的取值，行为与加这个字段之前**完全一致**；
- `[]` = 这个会话**一个 MCP 都不用**；
- `['a','b']` = 只用这两个（仍要与全局 `enabled` 求交）。

| 层 | 在哪 | 作用 |
| --- | --- | --- |
| `McpServerConfig.enabled` | 设置 → MCP 服务 | 这台机器上**有没有**这个 server |
| `AgentConversation.mcpServerIds` | 会话输入框上方的 MCP 弹层 | **这条会话用不用**它 |

- ⚠️ **`undefined` 与 `[]` 语义相反，别写反**。落盘走 `conversation-store.ts` 的
  `'mcpServerIds' in input` 语义（`undefined` 是「显式清空」），所以
  `normalizeConversation` 的重建列表、`SaveConversationInput`、`persistConversation` 三处
  都必须**显式带上这个字段** —— 漏一处就是「在界面上点了保存，重开会话又变回全部启用」。
- 组装时 `mcpManager.buildToolset({ serverIds })` → `effectiveServers()` 过滤。
  ⚠️ **内置 Playwright MCP 不受这个清单管辖**：它由浏览器工具的 `browserToolMode === 'system'`
  决定，属于另一套开关（见 4.11）。
- 会话记录在主进程侧**只读一次**（`prepareWorkspaceTurn` 里的 `conversationRecord`），
  同时供 MCP 允许清单与检查点切片使用 —— 别为了图方便读两遍盘。
- 弹层改清单时**不 bump `updatedAt`**（`setAgentConversationMcpServers`）：这只是个开关，
  不该把一条老会话顶到列表最前面。
- 验证：手工清单 —— 设置页加一个 http / sse server 能连上并列进工具表；把 `transport` 删掉
  （旧存档）仍按 stdio 连；url 留空给出中文报错而不是 SDK 的原始异常；会话弹层取消勾选后
  该 server 的工具当轮就不在（重开会话仍是取消勾选状态）；全局 `enabled` 关掉时即便清单里有它也不出现；
  内置 Playwright MCP 不受清单影响（由 `browserToolMode` 决定）。

### 4.37 用量统计（`AgentUsageDrawer`）

- 入口：AI Agent 侧边栏标题栏的柱状图按钮 → 抽屉。**刻意不做成活动栏的一个功能区**：
  用量统计没有自己的对象，它是对**已有会话**的一个汇总视图。
- 数据**全部来自渲染端已持有的会话**（`ConversationUsage` 落在每条会话上），所以
  `@shared/agent-usage.ts` 里是**一个纯函数 `buildUsageReport(conversations, { days, topN })`**，
  **没有新 IPC 通道** —— 主进程那份反而可能比屏幕上的更旧。
- ⚠️ 只统计**真的上报过 `usage` 的轮次**：provider 没回 usage 的轮次不计入（估算出来的数字
  比缺失更糟 —— 它会让人以为「这个月花得不多」）。**ACP 会话整体排除**（token 在 agent 侧管理，见 4.18）。
- ⚠️ 分日按**本地时区**（`localDayKey()` 手工拼 `YYYY-MM-DD`，**不能用 `toISOString()`** ——
  那会按 UTC 切，东八区用户晚上 8 点之后的用量会被算到第二天）。窗口内的天**零填充**，
  所以没有用量的日子在柱状图上是一根空柱而不是被跳过。
- 落在这个窗口之外的会话**不计入柱状图但计入总计**（总计是「全部历史」，见抽屉脚注）。
- 模型归组键是 `modelId ?? configId ?? ''`（空串显示「跟随配置默认模型」）。
  ⚠️ 解析可读名时注意 **`AiModelConfig.models` 是 `string[]`（模型 id 列表），不是对象数组** ——
  它只有 id、没有单独的展示名，命中就直接显示这个 id。
- 验证：`scripts/verify-context-compression.mjs`（与本节同跑 `@shared/agent-usage` 真源码，
  覆盖累计 token 的累加语义）+ 手工清单（造几条会话后开抽屉，数字与各会话用量之和一致；
  跨零点后柱状图落在新的一天）。

### 4.38 插件的 AI 工具钩子（`tool:call` / `tool:result`）

- 权限：插件的 `manifest.permissions` 里必须有 `'hooks'`，否则 `on()` 直接抛
  （「插件 X 未声明 hooks 权限，无法注册 AI 工具钩子」）—— **能力与声明绑定**，不给隐式权限。
- 注册表：`services/ai/plugin-hooks.ts` 的 `pluginHooks`。
  - `tool:call` → `{ block?: true, reason?: string }`：**任一插件说拦就拦、立即短路**，
    理由当成**工具结果**回给模型（同 `guardWrite` 的拒绝语义，不抛错）。适合做「危险命令黑名单」这类硬闸。
  - `tool:result` → `{ result?: string }`：**链式**改写（每个插件看到上一个改完的结果），
    且**只有字符串返回值生效**。适合做脱敏 / 打码。
- ⚠️ 钩子注册在**唯一的那一层**：`tool-registry.buildToolset` 里的 `invokeTool` 包装，
  内置 / 客户端 / MCP 三种来源都走它 —— 实现一次，不会在三处漂移。
- ⚠️ **顺序不能换**：`tool:call` 钩子 → 执行 → `tool:result` 钩子 → `appendSteer`。
  钩子看到的是**原始结果**（脱敏类插件不该被插话文本污染），插话在最后加
  （它是要模型**立刻照做**的，放最前面容易被前面的长文本淹掉）。
- ⚠️ 钩子**超时 / 抛错一律当没挂**（`HOOK_TIMEOUT_MS = 5000`，内部 try/catch 并 warn）：
  一个写坏的第三方插件不能把整轮对话卡死。
- 插件被停用 / 卸载 / 重载时，`plugins/host.ts` 的 `unregisterHandlers(id)` 会
  `pluginHooks.clearPlugin(id)` —— 漏了这一步会让「已经卸掉的插件还在拦工具调用」。
- 界面：插件管理页的权限标签里有 `hooks: 'AI 工具钩子'`。
- 验证：`scripts/verify-sub-agent.mjs` ⚠️**已移除**（第 6 节：`tool:call` 拦下即不执行且理由当结果 /
  `tool:result` 改写生效 / 钩子抛错当没挂 / **钩子看到的是原始结果、插话拼在最末尾**）。

### 4.39 命令的**实时输出**（`tool-output-delta` → `liveOutput`）

命令一跑起来，界面上那张工具卡就一帧帧出输出，而不是等命令结束才一次性显示（对齐 fishwork
的 `LiveOutputBlock`）。这是「单条命令停止」（4.33）的配套：**能看到它在跑，才知道该不该停**。

数据链路（四段，缺一段就退化成「等命令跑完」）：

| 段 | 位置 | 做什么 |
| --- | --- | --- |
| 1 | `agent-core/tools.ts` 的 `runCommand` | `child.stdout/stderr.on('data')` 里除了喂产物写入器，再调 `ctx.onToolOutput?.(toolCallId, 'stdout'\|'stderr', chunk)` |
| 2 | `services/ai/tool-output-throttle.ts` | 攒够 240 字符 / 60ms 才下发一帧（首帧立刻发），stdout 与 stderr 各自保序 |
| 3 | `services/ai/agent.ts` | 每条请求一个节流器（`outputThrottles`），flush 后包成 `tool-output-delta` 事件；**收尾只删不 flush** |
| 4 | `stores/agent-helpers.ts` + `ToolCallRow.tsx` | 折进同 id tool-call 的 `liveOutput`；`commandRunning` 时铺实时输出块并自动展开 |

- ⚠️ **节流器必须在任何非增量事件之前 flush**（`send()` 里统一做，见 2 处的注释）：
  尾部增量若排到 `tool-result` 之后，前端那份「运行中实时输出」会永远停在收口前一刻
  （结果已经换上了，实时块还挂着）。**别绕过 `send()` 直接 `emitEvent`**。
- ⚠️ **收尾（`finally`）只 `delete`、不再 `flush`**：攒着的尾巴早在 `finish` 之前就被 `send()`
  结掉了；在 finally 里再 flush 只会把增量排到 `finish` 之后 —— 那一刻 ipc 层已把 requestId
  的归属摘掉（`chatConversations.delete`），渲染端认不出、白丢。
- ⚠️ **判据用 `commandRunning`（`status === 'running' && STOPPABLE_TOOLS.has(toolName)`），
  `不看 `liveOutput` 在不在**：那个字段只在**第一段输出到达**时才创建，`sleep 30` / 长编译 /
  等网络这类**在跑但什么都不吐**的命令整轮都没有它 —— 拿它当判据会让这类命令退化成一行头部
  （fishwork 也踩过同一个坑，见其 `isCommandRunning` 的注释）。
- ⚠️ `liveOutput` 与 `inputText` 同性质：**只喂渲染**。`tool-result` 到达时在 `appendAgentPart`
  里清掉（卡片换成结果直显），`stripTransientParts` 落盘前再拦一道（每 3 秒的增量落盘正好
  可能卡在命令运行中途）。两条流各自封顶 `MAX_LIVE_OUTPUT = 64_000` 字符、**只留尾部**
  （`yes` / `find /` 这类命令否则会把内存与 DOM 撑爆）。
- stderr 在**渲染端**按行首加 `[stderr] ` 前缀（`appendStreamChunk`）：chunk 边界可能落在一行
  中间，前缀只能插在「这一行的第一个非空字符」前，空行不插。
- 展示时两条流合并成一份（stdout 在前、stderr 在后），**与最终 `tool-result` 的拼法一致** ——
  命令结束时卡片从「实时输出」平滑换成结果直显，读起来是同一份东西。
- 实时块**不设自己的 `max-height` / `overflow`**：滚动统一由 `CollapsibleRow` 的展开体承担
  （它已带 `max-h-64` + `stickToBottom` 吸底），否则会出现套娃滚动条（见 6.18）。
- 终端作用域 / 子 Agent / ACP 都**没有**这条链路：终端的 `run_in_terminal` 进程归用户终端管，
  子 Agent 的只读白名单里没有 `execute_command`，ACP 的命令活在外部 agent 进程里。
- 验证：`scripts/verify-tool-output-throttle.mjs`（节流 + **保序** + **零丢失**）⚠️**已移除**、
  `verify-agent-posix-command.mjs` 第 4 节（真跑一条命令，断言 stdout / stderr 都实时吐出且
  带对的 toolCallId）、`verify-agent-error-parts.mjs`（折叠 / 前缀 / 收口清掉 / 超限留尾 / 落盘摘除）。

### 4.40 工作区目录巡检：目录被删 / 被移走要自己发现（移植自 fishwork）

工作区登记表（`storage` 的 `agentWorkspaces`）**只在「添加工作区」那一刻 stat 过磁盘**，
之后再也不复查。目录被删是**外部事件**（用户在文件管理器里删的、移动硬盘拔了、盘符变了），
应用没有任何回调能感知 —— 结果就是：记录照旧在、侧栏照旧像没事一样，直到用户发消息才撞错，
而错得很难懂（十几个工具各报一句 `ENOENT`）。

链路（四段）：

| 段 | 位置 | 做什么 |
| --- | --- | --- |
| 1 | `services/ai/workspace-health.ts` | 30s 一轮 `sweepWorkspaces`：逐项 `stat().isDirectory()`，翻转了就写标记；**启动时立刻先扫一遍** |
| 2 | `services/storage.ts` 的 `markAgentWorkspaceDirMissing` | 落盘 `AgentWorkspace.dirMissing`；**只把 `applyDirMissing` 的结果写下去** |
| 3 | `ipc/agent.ts` 注册末尾 | 装配 `{ list, mark }` 两个方法 + `ctx.broadcast('agent:workspaces:changed', 全量清单)`（**只在翻转时**） |
| 4 | `preload` → `app-store` → `AgentPanel` | 整份换掉 `agentWorkspaces`；目录没了的工作区**红图标 + 提示 + 禁新建会话** |

- **判据只有一份**：`isWorkspaceDirAvailable`（`stat` 失败 / **不是目录** / 空串都算不在）。
  巡检、内置 agent 的回合开始、ACP 的回合开始三处共用 —— 各写一遍迟早漂成不同结论。
- **`applyDirMissing` 是纯函数**（不碰磁盘、不碰存储），三条语义全在它一处：**幂等**
  （没翻转就返回**原数组引用**，调用方据此免掉一次全量落盘 + 一次广播）、**不动 `updatedAt`**
  （这不是用户的改动，侧栏按它排序的话巡检一次列表就跳一下）、**恢复时删字段**
  （而不是写 `dirMissing: false`）。
- ⚠️ **权威判定在「发消息」，不在「存会话」**：dogi 的会话存在
  `<userData>/agent-conversations/`，**不在工作区目录里** —— 所以「存一条会话记录」根本不需要
  那个目录（`导入会话文件` / `导入 ACP 会话` 也走同一条路）。真正需要目录的是**跑一轮**：
  工具要 chdir 进去、ACP 要 `spawn(..., cwd: workspace.path)`。因此校验加在
  `chatWorkspace` 与 `acpAgentService.chat` 的 `fail()` 分支旁，**不是** `agent:conversations:save`
  （加在那里会把「往失效工作区导入历史会话」一起误杀，而那个操作本来是无害的）。
- 两处校验都**自己再 `stat` 一次、不看 `dirMissing`**：那个标记来自 30s 一轮的巡检，
  可能慢半拍，而「目录刚被删、用户接着发消息」正是最该拦住的一刻。
- 渲染端 `createAgentConversation` 的拦截（弹一句人话）只是**体验层**：让用户当场知道为什么，
  不用白打一条消息。命令面板 / 快捷键等入口绕过去也没关系，主进程那道兜得住。
- **打开已有会话不拦**：目录没了只是不能往里放东西，历史消息 / diff / 产物都在本地，照样能看。
- 侧栏那枚红图标**保留 `Folder` 形状**、只换颜色（不是换个警告三角）：用户扫一眼就对得上
  是哪一个工作区。优先级排在「运行中 / 等待确认」**之后** —— 那两个是瞬时活动态，更该抢眼。
- 「更多」菜单里的**导入会话**不禁（同 fishwork 的取舍）：它是纯数据操作；**重命名 / 删除工作区**
  也不禁 —— 移除是用户唯一的出路，得能把这条失效记录拿掉。
- **恢复路径（`目录回来了` / `换个目录`）**：
  - 目录只是暂时不在（移动硬盘拔了又插上、网络盘挂回来）→ **巡检自己会发现**，下一轮就把标记
    清掉（日志里一条「目录已恢复」），侧栏自动变回正常色，不用用户做任何事。
  - 目录真的没了、要指到别处 → 走工作区行的「更多 → 重命名工作区」（这个弹窗里**同时**有
    名称与目录两个字段，`选择` 按钮能重挑目录）。⚠️ 顺带修了一个老 bug：
    `storage.saveAgentWorkspace` 的更新分支原先**只改 `name`、把 `path` 的改动静默丢掉** ——
    也就是「换个目录」根本改不动，用户改完界面没变、也没有任何提示。现在 `path` 会真的写下去，
    并且**换目录时顺手清掉 `dirMissing`**（旧目录的结论对新目录不成立，不清的话侧栏要顶着
    一个过期的红图标等下一轮巡检，看起来就像「改路径没生效」）。
- 验证：`scripts/verify-workspace-health.mjs`（判据 / `applyDirMissing` 三条语义 / 巡检只对变化）⚠️**已移除**（原脚本：判据 / `applyDirMissing` 三条语义 / 巡检只对变化
  写、`path` 为空跳过 / 启动即扫、`onChange` 只在翻转时来、start-stop 幂等）。
