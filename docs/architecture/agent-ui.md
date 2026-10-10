# 关键机制 · Agent 界面

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

### 4.21 文件视图（Agent 工作区）：树、菜单、以及「先关标签再动盘」

左侧文件树 + 右侧多标签编辑区（`features/agent/AgentFilesPanel.tsx`）。树懒加载（点开一层读一层），
忽略规则与 Agent 工具一致（`.gitignore` + `DEFAULT_IGNORE_DIRS`，见 4.8）。

**右键菜单 / 触屏长按是同一份 menu**：行上包 antd `<Dropdown trigger={['contextMenu']}>`，
再用 `useLongPressMenu`（同文件）补触屏 —— 500ms 长按、位移超 10px 取消、长按成功后**吞掉随之而来的
那次 click**（否则会顺带展开目录 / 打开文件）。鼠标全程不参与长按逻辑（`pointerType === 'mouse'` 直接return）。

**写操作四条通道**（`agent:fs:delete / rename / create / copy`，实现都在 `services/ai/workspace-fs.ts`，
与 `list/read/write` 共用 `resolveInside` 边界；删除语义与 Agent 的 `delete_file` 工具一致，改一处同步另一处）：

| 语义 | 约定 |
| --- | --- |
| 删除 | 目录 `rm -r`；根目录一律拒绝（删它等于抹掉整个工作区） |
| 重命名 | 只改名字不换目录；名字不许带 `/` `\`、不许是 `.` / `..` |
| 新建 | 父目录自动补；已存在**拒绝**，不覆盖 |
| 复制 | 原名空着就照用；撞名才加后缀 `name 副本.ext` → `name 副本 2.ext`（后缀挂**原名**上，点开头的文件如 `.gitignore` 不算扩展名） |
| 移动 | `mode: 'move'`；撞名**直接报错**（静默改名会让用户以为「移过去了」）；目录不许移进自己子目录；跨设备 rename 报 EXDEV 时退化成 copy+rm |

⚠️ **删 / 移 / 重命名一个已打开的文件，必须先关掉它的标签**（`withTabsClosed`，未保存改动复用关标签那套确认）。
不先关的话：标签还指着旧路径、Monaco 的 model 还按旧 URI 建，之后一次保存就**写到不复存在的路径上**。
反过来把标签路径改到新位置要连 model 一起迁移（撤销栈 / 行尾 / 光标全得搬），所以选「关掉」。

剪贴板是**渲染进程内存态、一组条目**（多选时可以一次带走几个），刻意不碰系统剪贴板
（会污染用户自己复制的内容）；剪切粘贴成功后立即清空（留着会让人以为还能再粘一次）。
⚠️ **剪切只在全部成功后清空**：还有失败项时源都还在，清掉剪贴板用户就没法只重试失败的。
批量粘贴/删除**逐项串行、中途失败不打断后面**，最后一起汇报成功数与失败明细 —— 并发会在
「两项粘到同一个名字」时互相盖掉报错，且磁盘状态不可预测。

**多选（对齐 fishwork）**：`selectedPaths`（第一项是 Shift 区间的锚点）与「键盘锚点
`treeFocusPath`」「当前打开的文件」是三件独立的事。`Ctrl/⌘ + 点` 加减选、`Shift + 点` 选
**可见行**区间、点空白处清空、`Ctrl/⌘ + A` 全选可见行（树是懒加载的，全选只能是看得见的这些）。
- **右键已选中的行保留整组选择**，右键未选中的行先单选它 —— 否则「选中 3 个 → 右键其中一个」
  会把多选压回 1 个，多选就白做了（触屏长按走同一条路径）。
- 行菜单作用于**选择集**（文案会写「N 项」），重命名单项、粘到文件行仍不给（粘父目录）。
- 方向键移动即**替换**选择（与文件管理器一致），`selected` 的底色与 `active`（正在编辑）
  要能分辨。

**树宽可拖 + 持久化**：`ResizeHandle`（双击复位到 `TREE_DEFAULT_WIDTH`），宽度存
`localStorage['dogi.agent.files.treeWidth']`，**必须用 lazy initializer 读**（直接
`useState(read())` 会先按默认值渲染一帧再跳回去，现象是「面板宽度闪了一下」），
读完还要夹一次 `TREE_MIN_WIDTH..TREE_MAX_WIDTH`（窗口变窄时存的值不能把编辑区挤没）。

**标签右键菜单**（对齐 fishwork）：关闭 / 关闭其他 / 关闭右侧 / 关闭左侧 / 关闭全部 / 复制完整路径。
⚠️ 批量关闭逐个走 `closeFile`（有未保存改动的各自弹确认），**别做成「一次确认全部丢弃」** ——
那等于替用户决定扔掉哪几份改动；因为标签顺序会随关闭变化，要按当前下标**倒序**关，
否则下标错位。

**树的键盘导航**（对齐 fishwork 的 `handleTreeKeyDown`）：↑/↓ 移动、→ 展开或进子项、
← 收起或回父目录、Enter/空格 打开（目录=折叠切换）、F2 重命名、Delete/Backspace 删除、
Ctrl/⌘+C/X/V 复制剪切粘贴。锚点是 `treeFocusPath`（**不是**「当前打开的文件」——
点完行直接按方向键时若没有独立锚点，用户会以为键盘坏了）；可见行扁平表 `visibleRows`
必须与 `renderEntries` 用**同一套可见性判定**（目录自己一行、只有展开且已加载才递归），
否则上下移动会跳到看不见的行上。事件挂在**树那一列**上，编辑器里按方向键仍然是移动光标。

### 4.25 会话多了会卡：列表与消息流都不许「订阅整个 conversations」

**症状**：会话列表起初不卡、消息一多就卡；主区域消息流滚动同样随消息数变卡。
**根因不是数据量本身，而是「每个 token 换掉整张表 → 订阅方整棵子树重渲染」**：
流式输出每个 delta 都会 `appendToLast`（换 `messages` 数组）→ `patchConversation`
（换会话对象 + 换**整个** `agentConversations` 数组）。凡是 `useAppStore((s) => s.agentConversations)`
或返回其中**某个对象**的 selector，都会被每个 token 带着重渲染。

**三条已落地的修法**（都是「订阅投影 + 结构共享」，别退回直接订阅）：

| 位置 | 修法 |
| --- | --- |
| 侧边栏会话列表（`features/agent/AgentPanel.tsx`） | 订阅 `selectConversationListMeta(s.agentConversations)`（`features/agent/conversation-list-meta.ts`）：只投影列表可见字段（id / 归属 / 形态 / 标题 / 排序键 / ACP 绑定），可见字段没变就**交出上一次的数组与条目对象**；行再 `memo` 化成 `ConversationRow`，只接原始值 + 固定引用回调。状态图标（等提问 / 等确认 / 运行中）由父组件**一次遍历**算成 `Map` 传给行，别在行里 `Object.values(x).some()`。 |
| 面板标签条（`app/layout/PanelView.tsx`） | Agent 标签的自动标题**只取 `title` 字符串**，别返回会话对象 —— 标签是常驻挂载的（见 6.5 第 26 条），返回对象等于每个 token 重渲染每个 Agent 标签条。 |
| 消息目录（`features/agent/MessageOutline.tsx`） | ① `items` 只依赖「用户提问」投影（`selectUserMessages`，按**引用**比对复用 —— 流式期间用户消息对象不动，只有 assistant 在长），不再每个 token 重算「过滤全部消息 + 抽每条提问的纯文本」；② scroll-spy **缓存消息元素 + 二分查找**（DOM 顺序 = 时间顺序、`rect.top` 单调，二分成立），每帧 O(log n) 次布局读取；③ 重算的 effect 依赖 **`items.length` 而不是 `messages`** —— assistant 正文增长时所有提问的位置纹丝不动，没必要每帧重算（滚动中的位置变化由 scroll 监听覆盖，另外补了 `window.resize`）。 |

⚠️ **别用 `useShallow` 顶替结构共享**：条目对象每帧都是新的，浅比较照样失败；
也别在组件里 `useMemo(..., [s.agentConversations])` —— 依赖项本身就是每帧换的数组。

⚠️ **`use-stick-to-bottom` 别给每个折叠横条都建实例**（`CollapsibleRow` 原先无条件建）：
一个实例 = 一个 ResizeObserver + 一套 scroll / wheel 监听器（每次滚动都读 `scrollHeight`），
一条会话里几十个工具 / 思考横条就是几十份，而**只有真需要吸底的那一行**（流式中的思考面板 /
正在生成的工具行，`stickToBottom` 为真）需要它。现在拆成 `StickyBody`（带 hook）与不吸底的
纯 DOM 分支渲染。

⚠️ **吸底版必须带 `&& open` 才挂载**（`stickToBottom && open`，别改回「吸底就一直挂」）：
这不是省性能，是**正确性**。收起态 grid 轨道是 `0fr`、滚动容器 `clientHeight` 为 0，
挂载那一刻先落底会把 `scrollTop` 设成 `scrollHeight - 1 - 0`（极大值）；紧接着展开过渡
让 `clientHeight` 涨上去，浏览器夹紧 `scrollTop` 并发出 scroll 事件。库**只观察
`contentRef`（内容盒）、不观察 `scrollRef`（滚动容器）**，容器高度变化对它不可见，
那次夹紧在它看来就是「用户上滚」→ `handleScroll` 判 `isScrollingUp` → `escapedFromLock` +
`isAtBottom=false`（`useStickToBottom.js:271`）；此后每次内容变长触发的 `scrollToBottom`
都在 `next()` 第一行 `if (!state.isAtBottom) return false` 直接返回（`:153`），吸底永久停摆。
**现场表现**：流式生成参数的工具行「自动滚动要用户先手动拖到底部才恢复」，且**每行必现** ——
`ToolCallRow` 是唯一「挂载时 `open=false`、靠 effect 立刻 `setOpen(true)`」的横条
（`stickToBottom={autoOpen}` 与 `setOpen(true)` 分属渲染与 effect 两拍）。
`ReasoningPanel` 用 `useState(streaming)` 让 `open` 从 true 起步，所以思考条不受影响 ——
排查时别拿思考条当「正常对照」去推演工具行。只在展开时挂载就没有这个窗口：
新挂载的 grid 直接以 `1fr` 起步，CSS 过渡不在首次样式计算时运行，容器一上来就有真实高度。

- **仍然存在的结构成本（刻意没做）**：消息流**没有虚拟化**，所有消息常驻 DOM
  （`AgentPage.tsx` 里明写「非虚拟列表下每条消息都在 DOM 里」）。滚动长会话的剩余开销就在这里；
  真要治只能上窗口化（react-window / @tanstack/react-virtual），会牵动 Ctrl+F、
  滚动锚定、消息目录跳转与吸底跟随，属独立一轮改造。
- **验证**：`scripts/verify-agent-list-projection.ts`（纯 Node：500 次流式增量后投影引用不变、
  改名 / 转正 / 增删才换引用）+ `scripts/verify-agent-outline-scroll-cost.mjs`（真界面**计数**
  `getBoundingClientRect` / `querySelector`：提问 50 → 300（6 倍）时每帧布局读取比值 1.34，
  修复前那段线性扫在 1200 个消息元素上是每帧 621 次）。

### 4.27 Agent 侧面板的终端标签：**标签身份与会话是两回事**（重连必须就地换会话）

`AgentPage` 的右侧面板（`features/agent/SidePanel.tsx`）里，终端是面板的一种标签，
一个会话一个标签。`TerminalTab.id` 是**标签身份**（`sideTabs` 的 key、选中态、关闭都用它），
**新建时等于会话 id，但此后不再随会话变**。

会话退出后按 Enter 的重连走 `reconnectTerminal`：只 `setTerms` 把 `session` 换掉，
标签身份 / 标签名 / 位次 / 面板展开态全不变。

- ⚠️ **别再写成「`closeTerminalTab` + `openEmbeddedTerminal`」**（旧实现，用户报「滚动跳变」）：
  标签 key 变了 → `TerminalView` 整个重建；更要命的是面板里只有这一个终端标签时
  `fallbackSideTab` 返回 `null` → **面板先收起（宽度动画到 0）再展开**，容器宽度与 xterm 尺寸
  一路重排（TerminalView 的 ResizeObserver → `fit()`），用户看到的就是内容/滚动跳变。
  顺带两个更难看的副作用：标签名从「终端」变成「终端 2」、标签跳到末尾。
- 换会话后 `TerminalView` 的 `session.id` 依赖照样会重建 xterm 并回放新会话环形缓冲 ——
  这是对的（会话是新的），但它发生在**同一个容器、同一块面板宽度**里，没有尺寸动画。
- 建会话与挂标签因此拆成两个函数：`spawnTerminalSession(shellId, cwd)` 只建会话，
  `openEmbeddedTerminal` 才动 `terms` / `sideTab` / 序号。重连要用 `tab.path`（标签自己记的目录，
  可能不是当前工作区）与 `tab.shellId`。
- **同一纪律对 AI 助手状态不成立**：`activeTerminalConv` / `ui.aiOpenSessions` 按**会话 id** 存，
  换会话后不会跟着迁移（旧的已退出，不值得迁移）。
- PanelView 里的终端标签**仍按会话 id 推导 tab id**（`stores/types.ts`），
  `reconnectSession` 原地换 tab id；那边不会收起面板（`reconnectingIds` 屏蔽了 closed），
  所以没有这个跳变，别拿它当反例也别顺手一起改。

### 4.28 侧边栏状态图标：工作区行 = 其下会话的「汇总」，别只标会话

`AgentPanel` 里每个工作区行有一枚**固定宽度（size-4）的图标槽**（展开箭头右边、名字左边）：

- 该工作区下**只要有一条会话还在进行中**，就换成会话用的那枚图标（`running` → 转圈，
  `ask` / `confirm` → 琥珀色暂停）；一条都没有才是安静的 `Folder`。
- 优先级与会话行**完全一致**（等待处理 > 运行中 > 静止，见 4.3 的 `statusByConversation`）：
  等用户回答/确认的那一轮其实已经停下来了，只转圈会让人以为还在跑。
- 折叠状态里也要算：**折叠 / 收起时看不到会话行**，工作区图标是唯一的信号；
  归档会话也一并算（它只是折起来了，仍在跑就该亮着）。
- 槽**始终占位**（静止时渲染一个图标而不是不渲染），否则标题会在「有状态 / 无状态」之间左右跳。
- **第四态**：工作区目录被删 / 被移走时，`Folder` 换成危险色（`text-destructive`，
  形状不变）+ 整行 title 变成「目录不存在」提示（见 4.40）。它排在「运行中 / 等待」**之后**。

⚠️ 状态判定复用 `statusByConversation`（父组件一次遍历算成的 `Map<id, RowStatus>`），
别在工作区行里再写一遍 `Object.values(agentRuns).some(...)` —— 那是当初会话行卡顿的同款成因。

⚠️ **两列对齐契约（改任何一边都要一起改）**：工作区行是 `[展开箭头][状态图标][名称]` **三格**，
会话行是 `[状态图标][标题]` **两格**。所以会话行必须自带 `pl-8`（= 工作区行「名称之前」的
全部宽度：`px-1.5` 6 + 箭头按钮 `p-0.5 + size-4` 20 + `gap-1.5` 6 = 32px），两列才对得上：

| 列 | x | 工作区行 | 会话行 |
| --- | --- | --- | --- |
| 图标列 | 32px | 状态图标（文件夹 / 转圈 / 暂停） | 状态图标（形态 / 转圈 / 暂停） |
| 文字列 | 54px | 工作区名称 | 会话标题 |

- 漏掉这 32px 的症状：会话行整行贴到最左、比工作区名称左 26px，**层级看着是平的** ——
  完全读不出「这条会话属于上面那个工作区」。`b238062` 给工作区行加状态图标槽时就是这么漏的
  （名称从 32px 被推到 54px，会话行没跟着补）。
- 同一批缩进还要跟着改的两处：列表空态提示（`pl-[54px]`，对齐标题）与「已归档」分组头
  （`pl-8`，它的折叠箭头要对齐会话行的**图标**列）。
- ⚠️ **别照抄 fishwork**：它的工作区行是 `[图标][名称][箭头]`（箭头在名称**右边**），
  两边都从 28px 起、天然对齐，所以那边**没有**这层缩进（它那边写 `px-1.5` 是对的）。
  dogi 把箭头挪到了左边，是刻意的分叉 —— 照抄 fishwork 的 `px-1.5` 会把缩进又弄丢。

### 4.29 会话归档：**只改列表归属**，不是「禁用」也不是「删除」

`AgentConversation.archived?: boolean`（缺省 = 未归档，旧存档按未归档读），
落盘走既有 `agent:conversations:save`，用**与 `kind` / `modelId` 同一套 `'x' in input` 语义**
（渲染端 `persistConversation` 每次显式带上，`undefined` 即取消归档）——
照 `conversation-store.ts` 里那条纪律办，别用 `??` 合并，否则「取消归档」永远存不下去。
`normalizeConversation` **必须**列出这个字段（它是显式重建对象，漏掉 → 读回来丢 →
下次发消息触发 save 就把归档状态永久抹掉，与 `contextSummary` 同款事故）。

- **界面**：工作区下的会话列表底部是默认收起的「已归档 (N)」分组，展开态 `archivesExpanded`
  与工作区展开态分开存；行尾浮层第一颗按钮是归档 / 恢复（`SIDEBAR_ROW_NAME.three` 对应三颗按钮，
  见 6.5 第 28 条的换算）。
- ⚠️ **归档不动 `updatedAt`**（同 `setAgentConversationModel`）：归档是展示态，
  让它在两个分组里的相对次序跳来跳去没意义；排序仍按 `updatedAt` 降序。
- ⚠️ **归档 ≠ 禁用**：归档的会话照常能打开、接着聊；`sendAgentMessage` 顺手 `archived: false`
  （又聊起来了的会话不该还躺在归档区），并且 `latestConversation` **跳过**归档会话 ——
  切工作区 / 删掉当前会话后要落到的那一条不该是用户自己收起来的那条。
- 列表投影 `conversation-list-meta.ts` 的 `ConversationListMeta` 带 `archived`（并进
  `sameListMeta` 比较），否则归档切换不换引用、侧边栏不刷新（结构共享纪律见 4.25）。
- **未覆盖自动化**：目前只有手工验证（归档 → 行进「已归档」分组 → 恢复 → 重启后状态仍在 →
  归档中的会话发消息后自动回到未归档列表）。

### 4.30 源代码管理面板（移植自 fishwork 的 GitPanel）

面板 = 头部一行（分支下拉 + 刷新 / 树状↔平铺 / 更多）+ 中部变更与历史 + 底部提交框。

- ⚠️ **status 必须用 `--porcelain=v2`，不能用 v1**（2026-10 对齐 fishwork 时修掉的真 bug）：
  v1 在「刚 init、还没有任何提交」时首行给的是 `## No commits yet on master`，
  按 `## ` 头解析就会把**那句话当成分支名**，面板头部显示成「No commits yet on master」。
  v2 把头部拆成 `# branch.head <name>` 之类的独立字段，没有这个坑。
  v2 的行型与下标（`1`/`2`/`u`/`?`）都写在 `parseStatusV2` 的注释里，别凭印象改：
  `2`（重命名）多一个 `<X><score>` 字段，路径在下标 9 且**原路径用制表符分隔**。
- **改动列表上限 2000**（不是 200）：装完依赖忘了 gitignore 的仓库轻松过千条，
  200 太紧会让用户只看到「已截断」而定位不到任何东西。
- **工作区指向仓库子目录时按前缀过滤**（`rev-parse --show-prefix`）：`git status` 给的是整个
  仓库的改动，用户挑的是 `packages/app` 就不该把根目录一堆无关文件列进来。
- **`init-commit`**：`init` + `add -A` + 首次提交一步到位。空仓库的引导天然是两步，
  而第二步在 unborn HEAD 上完全合法（`add -A` 合法、提交也合法）—— 拆成两次点击不是引导，
  是重复劳动。
- ⚠️ **`GIT_TERMINAL_PROMPT=0` 挂在每条 git 命令的 env 上**：面板没有 TTY，缺凭据时 git 会一直等
  用户输密码，表现为「点推送没反应」。让它立刻失败，用户去补远端凭据 —— 比挂死好。
- ⚠️ **刷新触发点有三个，缺一个用户就会看到过期的列表**：
  ① 面板自己的写操作跑完；② **文件面板改了盘**（`shared/lib/fs-changed.ts` 的
  `notifyWorkspaceFsChanged` 通道，只报「变了」不带内容 —— 变更清单的真源永远是 `git status`，
  它只是「什么时候该去问一次」的信使）；③ **窗口重新可见 / 重新获得焦点 / 面板标签从隐藏变可见**
  （面板组标签是常驻挂载的，切回来不会重跑 effect，靠 ResizeObserver 看 rect 从 0 变非 0）。
  外部工具改文件只能靠 ③ 兜底 —— 主进程没做文件监听。
- ⚠️ **分支下拉占头部标题位**，不再单独占一行状态条 —— 标签条上已经写着「源代码管理」，
  再摆一行分支名是重复表达。分离头指针 / ↑↓ / 上游 / 「未配置远端」的指示一并搬进那个按钮里。
- **行尾垃圾桶删分支**（本地与远端分支各一颗，当前分支那颗禁用）。⚠️ antd `Dropdown` 的
  `label` 里内嵌按钮必须自己 `e.stopPropagation()`：不拦的话点垃圾桶会顺手把该分支检出、
  还会把菜单关掉。三类破坏性动作（删本地分支 / 删远端分支 / 删远端）共用一个确认框。
- **`delete-branch` 默认只删已合并的**（判定交给 git，不自己算 merge-base）；未合并时
  git 会拒绝，此时把错误翻成「勾上『强制删除』才会删（未合并的提交删完只剩 reflog 能找回）」，
  而不是把 git 原话丢给前端。`force` 是**唯一**的破坏性开关，必须由用户在确认框里勾。
- **刻意不提供**强推与 `reset --hard`：面板能改仓库状态，但不会悄悄毁掉用户手上的工作。
  也没有「删本地分支时顺手删远端同名分支」的开关 —— 那是另一条不可逆路径。
- **入参校验**：分支名 / 远端名不许以 `-` 开头（会被 git 当选项）、不许含空白；
  贮藏 `ref` 只认 `stash@{n}`（它是拼进命令行的，别让它变成任意参数）。
- ⚠️ **网络动作带 `GIT_TERMINAL_PROMPT=0`**：面板没有 TTY，缺凭据时 git 会一直等用户输密码，
  表现为「点推送没反应」。让它立刻失败，用户去补凭据 —— 比挂死好。
- ⚠️ **`stash pop` 撞冲突是「失败但也真的改了工作区」**：所以 `applyStash` **不走**只在成功时
  刷新的 `run()`，失败分支也要 `refresh()`，否则屏幕上的改动列表会和磁盘对不上。
  报错同理用「stderr 优先、stdout 兜底」—— 哪个文件冲突、stash 还留着这些都在 stdout 上。
- **贮藏栈放在 `GitStatusResult.stashes` 里**而不是单开接口：它跟改动列表一样是「每次刷新都
  该是最新的」，而贮藏 / 弹出 / 删除都会改工作区。解析 `git stash list --format=%gd%x1f%gs`
  用 `\x1f` 而不是 `:` —— 说明里本来就有冒号（`WIP on main: …`）。上限 50 条。
- ⚠️ 贮藏栈是**独立折叠分组**，不塞进「更多操作」菜单：贮藏是有历史的东西（用户会回来找它）。
- **树状 / 平铺**只影响两组变更列表的排布（选择记在 `localStorage`，用 lazy initializer，
  否则会先按默认值渲染一帧再跳回去）。两种排布共用同一个 `renderRows` —— diff 展开、
  暂存、回退因此只有一份实现，不会出现「某项操作在一种视图下失效」。
- **推送快捷键绑在提交输入框上**（Ctrl/⌘+Shift+Enter），不进全局快捷键表：推送的作用对象是
  「当前这个工作区的仓库」，全局快捷键那一刻不一定知道哪个面板是活的 —— 推错仓库比推不了更糟。
- **没装 git 与「不是仓库」要分开说**（`git:version` 看 `git --version` 的**退出码**）：
  两者都表现为 `isRepo === false`，混起来会把没装 git 的人引去反复 `init`。
  `GitInstallDialog` 只给各平台一条可复制的安装命令与官网链接，**不代跑安装**（改系统必须用户自己敲）。
- **克隆仓库为新工作区**（`git:clone`）：侧边栏「新建工作区」下拉的第二项。安全边界在主进程
  —— `assertSafeRepoUrl`（拒绝空 / `-` 开头 / 含换行）+ `git clone -- <url> <dir>` 双保险，
  且**目标目录必须不存在**（不做「合并进已有目录」）。渲染端的 `GitCloneDialog` 只收集输入与展示
  进度条，⚠️ 进度**不解析 git 的进度输出**（它写 stderr 且格式不保证，硬解析出来的数字会骗人）。
  克隆成功后自动建工作区并切过去；私有仓库凭据仍走用户自己的 git（SSH agent / credential helper）。
- **刻意不提供**：worktree（`.fishwork/worktrees` 那套服务的是 fishwork 的 task / flow 编排，
  本项目没有那条产品线）。
- 验证：`scripts/verify-git-changes.ts`（直接跑 `services/git.ts` 真源码）覆盖分支增删的拦截、
  远端增删、贮藏 push/pop/apply/drop 与非法 ref；`scripts/verify-git-tree.ts` 覆盖折树纯函数。
  ⚠️ 贮藏列表是**有历史的东西**（用户会回来找它），所以是独立折叠分组，别塞进「更多」菜单。
- **树状 / 平铺**只影响两组变更列表的排布（选择记在 `localStorage`，用 lazy initializer，
  否则会先按默认值渲染一帧再跳回去）。两种排布共用同一个 `renderRows` —— diff 展开、
  暂存、回退因此只有一份实现，不会出现「某项操作在一种视图下失效」。
- **推送快捷键绑在提交输入框上**（Ctrl/⌘+Shift+Enter），不进全局快捷键表：推送的作用对象是
  「当前这个工作区的仓库」，全局快捷键那一刻不一定知道哪个面板是活的 —— 推错仓库比推不了更糟。
- 验证：`scripts/verify-git-changes.ts`（直接跑 `services/git.ts` 真源码）覆盖分支增删的拦截、
  远端增删、贮藏 push/pop/apply/drop 与非法 ref；`scripts/verify-git-tree.ts` 覆盖折树纯函数。

---
