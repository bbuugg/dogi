# 踩坑库 · AI / Agent 专项

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

### 6.6 AI / Agent 专项

**21. 「思考内容」不显示 = provider 把 `reasoning_content` 丢了**

- 根因（实测，不是推测）：`@ai-sdk/openai` 的 **chat-completions 分支完全不解析思考字段** ——
  源码里 `reasoning` 相关标识全是 Responses API 的，chat 分支一个都不认，`forceReasoning` 也只影响请求参数兼容性。
- 而各家兼容网关字段还不统一：GLM / airouter / StepFun 用 `delta.reasoning_content`（字符串）；
  OpenRouter 用 `delta.reasoning` + `delta.reasoning_details`（数组）。
- 正确做法：`openai-compatible` + `chat-completions` 改走 **`@ai-sdk/deepseek`** 的 chat 模型
  （它解析 `reasoning_content`，请求体同样是标准 chat-completions），
  并在 fetch 层加 SSE 字段归一化（把 `reasoning` / `reasoning_details` 改写成 `reasoning_content`）。
  两个都在 `services/ai/resolve-model.ts`。
- ⚠️ **不要**给 `kind: 'openai'`（官方）也换成 deepseek —— 官方 chat 分支的 `max_tokens` 对 o1/o3 会被拒
  （要用 `max_completion_tokens`），官方走 Responses API 本来就有思考。
- `resolveModel` 单独成文件（不依赖 electron / node-pty）就是为了能直接跑真代码验证：用 vite lib 模式把它打成单文件 ESM 后 import。

**22. 兼容网关把流式 `tool_calls[].type` 发成空串 → 整条流 `Type validation failed`**

- 现象：一调用工具就报 `Type validation failed`，zod 错误 `invalid_union` →
  `path: ["choices",0,"delta","tool_calls",0,"type"]` → `expected "function"`。
  实测于 StepFun：首个增量正常发 `type:"function"`，**后续增量把 `type`/`id`/`name` 全发成空串**（只带 `arguments` 片段）。
- 根因：AI SDK 的 chat chunk schema 里 `type` 是**字面量** `z.literal('function')`（不是 `z.string()`），
  空串不合法；且 `function` 对象必须存在。一个字段脏 → 整条流被丢弃。`@ai-sdk/openai` 与 `@ai-sdk/deepseek` schema 一样严。
- 正确做法：在 fetch 层 SSE 归一化里补两条（`resolve-model.ts` 的 `rewriteSseLine` / `normalizeReasoningFetch`）：
  ① `tc.type !== 'function'` 一律改成 `'function'`；② `function` 缺失时用平铺的 `name`/`arguments` 补一个壳。
- ⚠️ 归一化 fetch 必须挂到**所有 chat-completions 分支**（含 `kind:'openai'` 官方分支 —— 用户可能把它指向兼容网关）。

**23. 历史消息里的工具过程必须用原生 `tool-call` / `tool-result` 结构**

- **不能**压成 `[调用工具 xxx]` / `[工具 xxx 返回] xxx` 这类纯文本摘要 ——
  模型会把这个格式当成「助手的说话方式」，多步工具链之后开始在正文里照抄 `[调用工具 read_file]` 这种假调用（用户直接看到过）。
- 转换见 `agent-core/agent.ts` 的 `toModelMessages`（终端 AI 助手复用同一份）：
  - 一轮历史的 parts 是**扁平交错**的（text, call, result, text, call, result…），
    要按「一批 tool-call 及其全部结果」切成若干段：`assistant`（文本 + tool-call）紧跟 `tool`（结果），顺序与 API 要求一致。
  - `tool-result.output` 是**包装结构**（`{ type: 'text' | 'json' | 'error-text', value }`），不是裸值；
    `ToolResultOutput` 类型 `ai` 包**没有导出**，用 `ToolResultPart['output']` 派生。
  - 悬空 tool-call（用户中止）要补占位 `error-text` 结果、孤儿 tool-result 要丢弃，否则 provider 直接拒请求。
  - ⚠️ **`historyLimit` 必须在转换前按历史条数截断**（`toModelMessages(history.slice(-N))`）——
    转换后一条历史会展开成多条模型消息，在模型消息上 `slice` 会把 `tool` 消息和它的 `tool-call` 拆开。
  - 系统提示词里同时明令禁止复述 `[调用工具 xxx]`（双保险，防旧历史里的残留文本继续带偏）。

**24. ACP 联调「prompt 挂起」先查权限模式，别怀疑 Web Streams**

- 外部 ACP agent 在应用里 `session.prompt()` 迟迟不 resolve、主进程日志停在「session ready」：
  示例 / 真实 agent 会在回合中发 `session/request_permission` 并**等待客户端响应**；
  应用处于 `permissionMode: 'confirm'` 且无人批准时，整轮 prompt 都不会返回。
- 正确做法：① 联调用 `permissionMode: 'full'` 或让确认卡自动批准；
  ② `acp-agent.ts` 的 runTurn **不要 await prompt** —— 先 `session.prompt(text).catch(() => undefined)` 发出，
  立即用 `session.nextUpdate()` 流式消费（错误同样经 updates 队列抛出），这样权限等待期间 UI 也能看到已产生的事件；
  ③ 进程 / 连接关闭会使 updates 队列 fail，`nextUpdate()` 抛错即可走异常路径。
- 已知安全区：完整 Electron 主进程作为 ACP 客户端 + 纯 Node agent（codex-acp 即此形态）通信正常；
  仅当 agent 自身也以完整 Electron 运行时协议会挂（真实场景不会出现）。
- Windows 下 npm 脚本入口要带 `.cmd` 后缀（`AcpAgentConfig.command`）。

**25. 技能发现的两个静默失效**

- **`Dirent.isDirectory()` 对软链接 / Windows 目录联接（junction）恒为 false**。
  别人用 skills CLI 装的技能常常就是这么挂进来的（本机实测 `~/.agents/skills/superpowers` 就是个 junction），
  只认 `ent.isDirectory()` 会**静默漏掉**。非目录时要补一次 `fs.stat`（跟随链接；断链抛错 → 跳过）。
- 判断「根目录本身就是技能」时**别写 `isDir(join(root, 'SKILL.md'))`** —— `SKILL.md` 是文件不是目录，
  这个条件永假，整条分支从来没生效过（静默失效，构建与类型检查都不报）。直接调 `readSkillDir(root)` 让它自己 stat。

**26. Agent 完成通知：前台判定必须在主进程**

- `isAppInForeground(win)` = 窗口存在且未销毁 / 可见 / 未最小化 / 已聚焦 —— 渲染端的 `document.hasFocus()`
  判断不了「隐藏到托盘」这类状态。渲染端只负责**凑内容**（会话标题 + 回复开头 120 字），主进程负责**发不发**。
- 开关是 `preferences.notifyOnAgentFinish`（缺省开，`getPreferences()` 会合并默认值）；用户主动中止（`finishReason === 'aborted'`）不发。
- 主进程在决策处**打日志**（跳过原因 / 已发送）——「通知怎么没弹」只能从这两行看出来。
- 会话行状态图标按「**等回答 > 运行中 > 静止**」选：`followupRequests` 里有条目的 `requestId` 等于该会话
  `agentRuns[cid].requestId` 就是「等用户回答」。
  ⚠️ 别用返回新对象 / 新 `Set` 的 selector 取这两张表（zustand 用 `Object.is` 比快照，会无限重渲染）——
  取整表再在渲染里按行推导。

**27. 会话选的模型重启后丢失 = `modelId` 没落盘**

- **现场**：每个会话选的模型，重启应用后回到默认（用户报告；ACP 与内置后端都一样）。
- **根因**：`modelId` 在**整条落盘链路上都缺席** —— `app-store.ts` 的 `persistConversation` 只传了
  `backend` + `configId`，preload 的入参类型、`ipc/agent.ts` 的入参类型、`storage.saveAgentConversation`
  都没有这个字段。于是「这个会话选了哪个模型」从来没写进磁盘，重启后只剩 `configId`，
  看起来就是「恢复成默认模型」。
- **正确做法**：`kind` / `configId` / `modelId` / `acpAgentId` / `acpSessionId` 同款处理
  （`'x' in input` + 每次显式带上），从渲染端到 storage 一路对齐（见 4.3）。
- ⚠️ **`kind` 是可缺省的（未定形态）**：新建的会话**不要**在落盘时缺 `kind` —— storage 的兜底会把它
  当成 `mastra`，于是「首条消息定型成 ACP」的会话在重启后显示成内置。正确顺序是
  `sendAgentMessage` 里**先按选中的模型算出 kind 写进会话，再落盘**（未定形态的会话则干脆不落盘）。
- ⚠️ 同一套语义现在也覆盖 **ACP 绑定**：`acpSessionId` 是 `session/new` 时由 agent 返回的，
  靠 `agent:acp-state` 广播回填 —— **回填那一刻必须落盘**，否则重启后那条会话成了「没有绑定」的
  孤儿记录。另外 ACP 会话的**消息永远不进 storage**（`saveAgentConversation` 里对 `kind: 'acp'`
  直接写空数组），别为了「能离线看历史」把它存回来。
- **验证**：`scripts/verify-agent-conversation-model.mjs` —— 真启动两次应用（同一 userData），
  覆盖 mastra 的形态 / 模型落盘语义与 ACP 的绑定落盘 + 「消息恒为空」。

**28. ACP agent 报 `Method not found: fs/write_text_file` = 客户端那两个方法没实现**

- **现场**：用 opencode 等 ACP agent，写文件那一轮直接失败，agent 侧吐
  `RequestError: "Method not found": fs/write_text_file`（用户报告）。
- **根因**：ACP 里客户端要实现 `fs/read_text_file` / `fs/write_text_file`；`acp-agent.ts` 当时只注册了
  `session/request_permission`，agent 发文件请求时服务端找不到 handler。
- **正确做法**：① initialize 的 capabilities 里广告 `fs: { readTextFile: true, writeTextFile: true }`；
  ② 用 `acp.methods.client.fs.readTextFile` / `.writeTextFile` 注册 handler；
  ③ ⚠️ 路径必须限制在**工作区内**（`services/ai/acp-fs.ts` 的 `resolveInsideWorkspace`）——
  agent 是我们 spawn 的外部进程，不能让它借这条通道读写工作区外的文件。
- **验证**：`scripts/verify-acp-fs.ts`（不起 Electron，直接跑 `acp-fs.ts` 真源码）。

**29. Windows 上 Agent 的 `execute_command` 要走 Git Bash（模型发的是 Linux 风格命令）**

- **触发信号**：Windows 上 Agent 执行 `ls` / `grep foo | wc -l` / `for f in *.md; do …; done` 全部报
  「不是内部或外部命令」「无法将…识别为 cmdlet」，而同样的命令在别的编码代理（Claude Code / Codex）里正常。
- **根因**：模型受训练语料影响，绝大多数时候按 POSIX 习惯写命令，**它不知道该改写成 PowerShell 语法**。
  原来的实现 Windows 走 PowerShell，等于每条 Linux 风格命令都要模型自己翻译一遍 —— 失败率高且 token 浪费。
- **正确做法**：Windows 上优先用 **Git Bash**（`<Git>\bin\bash.exe -lc <cmd>`）执行，模型直接拿到
  POSIX 工具链（ls / grep / sed / find / 管道 / `$VAR` / 通配）。
  - 探测复用 `services/terminal/shells.ts` 的 `findGitBash()`（**已导出**，与终端下拉同一份逻辑：
    常见安装路径 + `where git.exe` 推导）；结果在 `services/ai/agent.ts` 里**进程级缓存**（含扫盘）。
  - 注入方式是 `AgentToolOptions.bashPath`（**由调用方传，agent-core 不 import electron/shells**）——
    agent-core 保持零环境依赖，才能脱离 Electron 跑真源码做单测。
  - PATH 里显式前置 `<Git>\usr\bin`：coreutils 在那里，继承的 Windows PATH 通常不含它。
  - **没有 Git Bash 时回退 PowerShell**（不能因为缺 Git 就让工具不可用）；POSIX 平台恒为 bash。
  - 工具描述按实际环境措辞（「命令运行在 Git Bash（POSIX）环境…」/「…在 PowerShell 环境」）——
    模型要据此决定命令风格，描述与实际不符比不写更糟。
- ⚠️ **不要**改成 WSL：`wsl.exe` 里 `cwd` 得换成 `/mnt/c/...` 做路径翻译、且默认发行版可能没装，
  比 Git Bash 脆得多（终端里的 WSL 是另一回事，那是用户显式选的 shell）。
- **验证**：`scripts/verify-agent-posix-command.mjs`（跑 agent-core 真源码）—— 注入 bashPath 后
  `ls` / 管道 + 通配 / `grep -n` / for 循环 / `$HOME` 全按 POSIX 语义工作；不注入时回退 PowerShell
  且仍能执行；工具描述如实声明环境。需要 Git 时用 `DOGI_TEST_BASH` 指定 bash.exe 路径。

**30. 错误文案要「可替换」而不是「可追加」；重试次数是 mastra 的 `modelSettings.maxRetries`**

- **现场**：一次断流后消息里出现好几段几乎一样的 `⚠️ …` 文案（用户报告「多次重试的文案都追加显示出来了」）。
- **根因（渲染端）**：`error` 事件在 `agent-helpers.ts` 的 `appendAgentPart` /
  `appendAssistantPart` 里是往消息尾部 **push** 的。同理，任何「一轮里发两次 error」的路径都会堆出两段。
  ⚠️ **别把它归因成「p-retry 每次尝试各发一个 error chunk」—— 实测不是**：
  `scripts/probe-mastra-error-chunks.mjs` 用假 LanguageModel 跑 mastra 真源码，
  always-500 时 `maxRetries=0` → 1 个 error chunk、`maxRetries=2`（模型被调 3 次）→ **仍只有 1 个**；
  多步（先工具调用后失败）也只有 1 个；流中途 `controller.error()` / 迭代器抛 也都只 1 个
  （mastra 把它包成 `deferredErrorChunk` 且 `for await` 不抛）。
  升级 mastra 后**重跑这个探针**再下结论。
- **正确做法**：错误 part 落成 `{ type: 'text', text: '⚠️ …', error: true }`
  （两个 part 联合类型都加了这个可选标记，**不是**新 part 类型 —— 新类型要动
  `toModelMessages` / 渲染 / ACP 装配一整条链，代价不值）。
  - 后到的错误**替换**末尾那段（同一轮只留最后一条失败原因）；
  - `text-delta` **不合并进**带 `error` 标记的段 —— 否则后续正文被接在错误文案后面。
- ⚠️ 别用「文本以 `⚠️ ` 开头」来判：那会让模型正常输出的运维告警（`⚠️ 磁盘 90%`）也带上标记。
- **重试次数**（顺带加进设置）：mastra 把 `modelSettings.maxRetries` 直接交给 p-retry 的 `retries`
  （缺省 2），只在 `doStream` **开流前**失败时重试（`agent-BOxKOk3n.js` 的 `retryWithExponentialBackoff`）。
  生效值见 `@shared/ai-timeouts` 的 `resolveMaxRetries`，界面在「设置 → AI → 超时 → 请求失败重试次数」，
  `0` = 不限制。`agent.ts` 两条作用域的路径都要传（工作区 Agent / 终端助手）。
  ⚠️ **`0` 的代价**：翻译成 p-retry 的 `Infinity`，而 mastra 没设 `maxTimeout`，
  退避延时趋近 `Infinity` 后被 Node 夹成 1ms —— 不会空转（每次尝试都是真请求），
  但等于拿网关连接数去赌。别把 0 设成默认值。
- **验证**：`scripts/verify-agent-error-parts.mjs`（跑 `agent-helpers.ts` 真源码）。

**31. 工具入参也要「流式」：写文件时卡片必须能看到内容在长**

- **触发信号**：让模型用 `write_file` 写一个几 KB 的文件，工具卡只有一行「写入文件 + 转圈」，
  什么都不显示，直到整个文件写完才突然出现 diff（用户报告「看不出它在写什么」）。
- **根因**：工具**入参**也是流式生成的，上游把写文件这种大入参拆成成百上千帧
  （Mastra 1.x 的 `tool-call-input-streaming-start` 只有 id + 工具名，随后一串
  `tool-call-delta` / `payload.argsTextDelta`）。`adaptMastraPart` 此前没有这两个分支，
  整条落进 `default` 被丢掉 —— 只有完整 `tool-call` 那一刻界面才有东西可显示。
- **正确做法（四处，缺一不可）**：
  1. `agent-core/mastra-stream.ts` 把两个 chunk 转成 `{ type: 'tool-call-delta' }` 事件
     （`inputTextDelta` 可以为空串：那一帧的用处是**先把卡片建出来**，标题立刻是真实工具名）；
  2. **下发节奏**统一由 `services/ai/tool-input-throttle.ts` 节流（240 字符 / 60ms）。
     `agent.ts` 两条作用域的路径里**所有**事件都要走包好的 `send()`：
     ⚠️ 非增量事件前必须先 `flush()`，否则同一个 `toolCallId` 的增量会排到它自己的完整
     `tool-call` 之后，前端又用旧增量盖回去（顺序错了比不发还糟）。
  3. 渲染端（`stores/agent-helpers.ts`）按 `toolCallId` 攒进 `part.inputText`。
     ⚠️ **完整 `tool-call` 到达时必须按 id 收口**（把 input 覆盖上去、丢掉 inputText），
     **不能 push 新 part** —— 否则一次调用会渲染成两张卡，一张永远停在「正在生成…」。
     半截卡片先落 `input: null`（`buildRenderUnits` / `buildFileDiff` 都吃 null），收口才填真入参。
  4. 卡片（`features/agent/ToolCallRow.tsx`）用 `partialJsonString` 从**半截 JSON**（`JSON.parse` 必抛）
     里抠 path / command / content → 横条明细 + 「正在生成…」块；块**不要自己设 max-height**，
     滚动仍归 `CollapsibleRow`（见 6.18）。
- ⚠️ **`inputText` 只喂渲染，绝不落盘**：流式期间每 3 秒增量落盘（`persistConversationThrottled`），
  正好卡在生成中途会把半截 JSON 写进盘里 → 重开会话那张卡永远停在「正在生成…」。
  `persistConversation` 里的 `stripTransientParts` 是唯一守卫点，别删。
- ACP 会话**不发**增量事件，走的是原来那条路（只有完整 tool-call）—— 这条链路允许缺失，
  渲染端不能假设「调工具必然先来一串 delta」。
- **验证**：让 Agent 写一个 ≥2KB 的文件，卡片应从「转圈」变成文字逐帧变长（明细先出路径）；
  写完自动收回并显示 diff；中途「停止」后重开会话，消息里的工具卡不应残留「正在生成…」。

**32. 「思考 / 缓存命中」token 恒为 0 = usage 只读了顶层字段**

- **触发信号**：圆环详情里的「其中思考」「其中缓存命中」永远是 0（或整条不显示），
  而思考内容本身是正常流出来的 —— 两条通道互不相干，别被「有思考内容」误导。
- **根因**：AI SDK v6/v7 把这两项从顶层字段挪进了 `outputTokenDetails.reasoningTokens` /
  `inputTokenDetails.cacheReadTokens`，顶层只留 inputTokens / outputTokens / totalTokens。
  而 `services/ai/agent.ts` 当时只读 `u.reasoningTokens` / `u.cachedInputTokens`，
  一个字段都命中不了（v5 时代的口径）。
- **正确做法**：统一走 `agent-core/usage.ts` 的 `normalizeUsage`（多级兜底，含 OpenAI 原始形状的
  `completionTokensDetails` / `promptTokensDetails`），并且**优先从 `finish` chunk 取**
  （`readChunkUsage`）—— Mastra 的 `stream.usage` 是它自己归一化过的形状，明细不一定保留，
  只当兜底。两条路径（工作区 Agent / 终端助手）共用同一份，别各写一遍。
- **顺带**：`0` 与「没报」要分开 —— `normalizeUsage` 只在字段确实存在时才带上，
  调用方据此决定显不显示；拿 0 冒充「上游报的 0」等于骗人。
- **验证**：同一段长上下文连发两轮（第二轮会命中缓存），圆环详情的「其中缓存命中」不再为 0；
  用推理模型（deepseek-reasoner / o 系等）时「其中思考」也不再为 0。

**33. 纯 Node 探针跑主进程源码：`@shared/*` 的运行时导入会直接炸，且会连带让断言悄悄过期**

- **触发信号**：`verify-acp-history.ts` 报 `ERR_MODULE_NOT_FOUND: Cannot find package '@shared/acp-tools'`
  —— 或者更糟：**它已经这样坏了好几轮没人发现**（首次跑就挂在 import 上，前面的断言一条没执行）。
- **根因**：`--experimental-strip-types` 只擦**类型**，`import { x } from '@shared/types'` 这种**运行时**
  别名导入照旧交给 Node 解析，而 `@shared` 是 vite/tsconfig 的构建期别名，Node 不认。
  `import type` 才擦得掉（这也是大多数探针一直没踩到的原因）。
- **正确做法**：需要真源码 + 有运行时别名导入时，走 `.tooltest` 那一套 ——
  **把源文件与它依赖的 `@shared` 模块一起复制到临时目录**，把说明符改写成相对路径再跑
  （`verify-acp-history.ts` 现在复制 `acp-history.ts` + `acp-tools.ts` 到 `.acphistorytest/`）。
  ⚠️ 临时目录加进 `.gitignore`（`.tooltest` / `.cmdtest` / `.filetest` / `.acphistorytest` / `.artifacttest`）。
- **连带纪律**：探针跑不起来时**断言也跟着腐烂** —— 本次就发现第 7 节还在断言
  「无 messageId 多轮要拆成多条」，而 `pushTool` 早已改成**刻意糊成一条**（工具调用不是轮次边界）。
  改实现时同步改断言，或断言直接写新语义（本次改成断言「糊成一条 + 末段正文仍在」）。
- **验证**：修完必须真跑一遍到 `ALL PASS`，别只把 import 改通就收工。

**34. 客户端工具：任何分支都必须回填，否则整轮静默卡死**

- **触发信号**：模型调用客户端工具后界面一直转圈、没有报错、通知也不弹。
- **根因**：主进程侧 `clientToolBroker.invoke()` 返回的是**挂起的 Promise**，只有
  `clientTools:result` 能 settle 它。渲染端 `handleClientToolInvoke` 只要有一个分支忘了
  `resolve(...)`（工具没注册 / 权限确认抛错 / handler 抛错 —— 或者干脆忘了那个 `if (!handler)`），
  那个 Promise 永远不 settle，`streamText` 的当前步就卡住。abort 时的 `cancel(requestId)` 只是兜底，
  正常路径不会走到。
- **正确做法**：渲染端入口**只留一个出口** —— 所有分支都走同一个 `resolve(...)` 包装；
  「用户拒绝」按**正常结果**回填（模型要看到原因并改道），不是 tool error。
- **验证**：`verify-terminal-chat.mjs` 第 4 节（confirm 模式弹框 → 点「拒绝」→ 本轮仍正常收尾，
  且第二轮请求里带着拒绝原因）；`verify-tool-registry.mjs` 第 7 节（broker 侧的挂起 / 回填 / 取消）。

**35. 「先记长度、事后取增量」读终端输出 —— 环形缓冲有损，刷屏时直接返回空串**

- **触发信号**：AI 在终端跑了一条输出很多的命令（`ls -R /`、大日志 `tail`），工具结果里
  **一个字输出都没有**，模型接着瞎猜命令是不是失败了。
- **根因**：`recentOutput` 背后是 **256KB/会话的环形缓冲**（`MAX_OUTPUT_BUFFER`），超了就把最旧的挤掉。
  于是「先 `outputLength()` 记下当前长度 → 命令跑完 → `outputFrom(start)` 取增量」在刷屏场景下
  取回的**恰恰是被挤掉的那段**，得到 `''`。这不是边界条件，是这类命令的常态。
- **正确做法**：**写命令之前**就订阅 `sessionManager.on('data')` 边跑边收（`terminal-tools.ts` 的
  `captureDuring()`，`finally` 里必须摘监听），超长部分交给产物文件（见 4.24）。
  ⚠️ 顺带把 `TerminalSession.outputLength()` / `outputFrom()` **删干净**（接口 + 三个会话类 + `SessionManager`），
  只在注释里留「为什么删」——留着就等于给这个 bug 留一个看起来很顺手的入口。
  `execute_command` 同理：从 `child.stdout.on('data')` 边收边写，别再 `slice` 截断。
- **产物 id 是安全边界**：模型能传参数就能传 `../../`。`artifactPath()` 必须先过
  `/^[a-z0-9-]{6,80}$/` 再拼路径，**任何地方都不要把 `dir` 或真实路径交给模型**（同 `resolveInside`）。
- **验证**：`scripts/verify-output-artifact.mjs`（最后一条就是 >256KB 的回归用例）、`verify-terminal-chat.mjs` 第 3b 节。

**36. 插话 / 子 Agent / 插件钩子都挤在工具结果的出口上 —— 顺序与 drain 语义是硬约束**

- **触发信号**：给工具加了一层统一包装（插话 / 钩子 / 脱敏）之后出现这些**互相看起来无关**的现象：
  用户插的话没人理；子 Agent 跑起来之后父 Agent 再也收不到插话；脱敏插件漏掉了一段文本；
  插件卸掉了还在拦工具调用。
- **根因**：`tool-registry.buildToolset` 里的 `invokeTool` 是**所有工具的唯一出口**
  （内置 / 客户端 / MCP 都走它），三件事挤在同一个位置，各有各的隐含约束：
  - `appendSteer` 是 **drain（取走）** 语义 —— 谁先取谁拿走。子 Agent 若没关掉插话
    （`allowSteer: false`），它内部的某一步就把用户的插话吞了，父 Agent 永远等不到；
  - 钩子的**顺序**：`tool:call` → 执行 → `tool:result` → `appendSteer`。
    把 `appendSteer` 挪到 `tool:result` **之前**，脱敏插件就会看到（并可能改写）插话文本；
  - `pluginHooks.clearPlugin(id)` 必须挂在 `unregisterHandlers` 上（停用 / 卸载 / 重载三条路都经它）。
- **正确做法**：见 4.34 / 4.35 / 4.38。改这一层时**先想清楚这三件事各自的顺序要求**，别只测自己那一件。
- ⚠️ 相关的第二个坑：插话会在**正在流的助手消息之后**插一条 user 消息，于是
  `messages[messages.length - 1]` 不再等于「最后一条助手消息」—— 所有这么写的地方都要改成
  「从后往前找第一条 `role === 'assistant'`」（`lastAssistantIndex` / `notifyAgentFinished`）。
  漏改的症状很隐蔽：流式光标消失、重试按钮挂错位置、系统通知正文取到那条插话。

**37. 会话新加的字段必须在三处同时登记，否则「界面改了、重开又变回去」**

- **触发信号**：在会话上加了个新字段（`mcpServerIds` 就是这么来的），界面上改得动、看着也生效了，
  **关掉会话再打开又回到旧值**；或者反过来 —— 显式设成空数组，重开后变成「全部启用」。
- **根因**：会话落盘走 `conversation-store.ts`，它是**显式白名单**（`normalizeConversation` 重建对象、
  `SaveConversationInput` 声明入参、`save()` 里逐字段 `'x' in input ? input.x : prev?.x`）。
  新字段漏在任一处，就会被静默丢掉 —— **不报错、不告警**，表现就是「改了没记住」。
- ⚠️ `'x' in input` 这套语义下 **`undefined` 是「显式清空」而不是「不改」**。
  所以「可选字段」的空值必须想清楚代表什么：`mcpServerIds` 用 `undefined` 表示「不限制（全部）」、
  `[]` 表示「一个都不用」，两者语义相反，写反了不会报错但行为完全错。
- **正确做法**：新增字段时按 `normalizeConversation` → `SaveConversationInput` → `save()`
  → preload 的类型 → 渲染端 `persistConversation` 这条链**一路查下去**，一处都不能跳。

**38. `AiModelConfig.models` 是 `string[]`，不是对象数组**

- 它只装**模型 id**（含主键 `model`），**没有单独的展示名**。所以「按模型 id 反查可读名」时，
  命中就只能显示这个 id 本身 —— 别写 `cfg.models.find((m) => m.id === key)`，
  那在类型上直接报错（`Property 'id' does not exist on type 'string'`），
  运行期也只会得到 `undefined`（`'abc'.id` 是 undefined）。
- 上下文窗口那份配置（`contextWindows`）也是按**模型 id** 作键 —— 一个配置下可以挂很多模型，
  窗口是模型自己的属性，不是网关的属性（见 `@shared/context-budget`）。

**39. 子 Agent 的 `model` / `modelSettings` 必须在 `ctx` 之前算好**

- **触发信号**：加子 Agent 时想「顺手」把 `ctx.subAgent` 塞进现有的 `ctx` 字面量里，
  却发现 `model` 是在 `ctx` **之后**才 `resolveModel` 的 —— 于是要么写不出这个字段，
  要么在 `execute` 里临时再解析一次模型（那时 `req` 已经不在手上了）。
- **正确做法**：`prepareWorkspaceTurn` 里把 `const model = resolveModel(config, req.modelId)` 与
  `this.mastraModelSettings(config, settings)` **提到 `ctx` 上方**。两者都是纯同步计算、
  不依赖 `ctx` / `tools`，提前没有任何副作用（`ctx.subAgent` 必须在组装工具集**之前**存在，
  因为 `available` 是**组装期**判定的）。
- ⚠️ 顺带：`resolveModel` 的注释说明「必须带上 `req.modelId`」—— 会话在同一配置下切换具体模型时，
  漏传会静默回退到配置默认模型，表现为「切换模型不生效」。

**40. 流式增量与「收口事件」的先后顺序：`finish` / `tool-result` 之后发出的增量全是白丢**

- **触发信号**：给命令加实时输出后，出现两种「数据明明发了却看不见」的现象：
  ① 实时输出块永远停在**收口前一刻**（结果已经换上去了，实时区还挂着最后几行没跟上）；
  ② 一轮结束后台日志里有 `tool-output-delta`，但界面上最后几帧从来没出现过。
- **根因**：**增量是攒着发的**（节流器），而 `tool-result` / `finish` 是**立即发**的。
  - 攒着的尾巴若排在 `tool-result` **之后**，前端那份「运行中实时输出」就永远差最后一帧；
  - ipc 层收到 `finish` 会 `chatConversations.delete(requestId)` —— 之后广播的事件**认不出归属**，
    渲染端整条丢掉（同 4.2「事件必须自带归属」）。所以**任何在 `finish` 之后 flush 的增量都是白丢**。
- **正确做法**：`agent.ts` 的 `send()` 里在**所有非增量事件之前**统一 flush（`inputDelta.flush()`
  + `outputThrottles.get(requestId)?.flush()`），任何事件都别绕过 `send()` 直接 `emitEvent`；
  收尾的 `finally` **只 `delete`、不 flush**（尾巴早在 `finish` 之前结掉了，在这里再 flush
  只会把增量排到 `finish` 之后）。
- **第二个坑（同一条链路）**：「命令在跑」的判据**不能看流式字段在不在**。`liveOutput` 只在
  **第一段输出到达**时才被创建，`sleep 30` / 长编译 / 等网络这类**在跑但什么都不吐**的命令
  整轮都没有它 —— 拿它当判据会让这类命令退化成一行头部，用户看不到「它在跑」、也找不到停止按钮。
  判据用「工具名 + 还没出结果 + 入参已定型」（`commandRunning`）。fishwork 踩过同一个坑。
- **验证**：`scripts/verify-tool-output-throttle.mjs`（保序 + 零丢失）⚠️**已移除**、
  `verify-agent-error-parts.mjs`（`tool-result` 收口时清掉 `liveOutput`）、
  `verify-agent-posix-command.mjs` 第 4 节（真命令的 stdout / stderr 都实时吐出）。

**41. 「把校验加在存会话那里」是错的 —— dogi 的会话**不**存在工作区目录里**

- **症状**：想拦「工作区目录没了就别新建会话」，很自然地在 `agent:conversations:save` 里加一道
  「创建时 stat 一下工作区目录」。结果**导入会话文件 / 导入 ACP 会话**一起被拒 —— 那两个操作
  写的是本地存档，跟工作区目录一点关系都没有。
- **根因**：把 fishwork 的结论直接搬过来了，但**两边的存储位置不一样**。
  fishwork 的会话在 `<workspace>/.fizz/conversation/`，**建会话 = 往工作区目录里写**，
  所以它把校验放在 `POST /api/conversations` 是对的。dogi 的会话在
  `<userData>/agent-conversations/`（见 `conversation-store.ts`）—— **建会话记录不需要那个目录**。
- **正确做法**：权威校验加在**真正需要目录的那一刻**，也就是「跑一轮」：
  `agent.ts` 的 `chatWorkspace` 与 `acp-agent.ts` 的 `chat`，各自 `fail()` 分支旁边
  （工具要 chdir 进去、ACP 要 `spawn(..., cwd: workspace.path)`）。
  渲染端 `createAgentConversation` 里那道只是**体验层**（当场给一句人话，不用白打一条消息）。
- **顺带一条**：这类「外部事件导致的状态变化」的权威判定，**都别只信巡检标记**。
  30s 一轮的 `dirMissing` 天生慢半拍，而「目录刚被删、用户接着发消息」正是最该拦住的一刻 ——
  两处校验都自己再 `stat` 一次（复用同一个 `isWorkspaceDirAvailable`，别再写第二份判据）。
- **验证**：`scripts/verify-workspace-health.mjs`（判据与标记语义）⚠️**已移除**。
