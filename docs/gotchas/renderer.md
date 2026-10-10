# 踩坑库 · 渲染端 UI / 数据与文件

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

### 6.5 渲染端 UI 细节

**17. 脚本没有独立功能区；侧边栏纵向分区统一用 StackedSections**

- 脚本只服务主机，`SCRIPTS_ACTIVITY_ID` 已删除，改为「主机」侧边栏的下半区分区。跳转用
  `useAppStore((s) => s.openScriptsSection)`（一次展开「功能区 + 侧边栏 + 分区」三层）。
- 任何「上下分区、各自可折叠」的布局都用 `shared/components/StackedSections.tsx`；
  分区 id 以「功能区.分区名」注册到 `app/section-ids.ts`。
- **空间规则（别改成裸 flex）**：折叠的分区只占标题栏（`shrink-0`），展开的分区 `flex: <grow> 1 0` + `min-height`。
  `SectionContent` 收起时用 `display:none` 而**不卸载**，否则面板里的搜索词、分组展开态会被重置。
- **可拖拽高度**：分区声明 `resizableAbove={上方分区 id}` 后顶部多一条横向拖拽条
  （绝对定位压在边界线上、不占布局高度），拖过的高度写入 `ui.sectionHeights`，此后用 `flex: 0 0 <H>px`。
  拖拽条只在「上下两个分区都展开」时存在；拖动时 `max = 容器高度 - 上方分区的 inline minHeight`（从 DOM 读，别让调用方再传一遍）。

**18. 对话流里的「思考 / 工具」是横条，不是卡片**

- 参考实现是 `D:\Workspace\web\owner\ainav\sdk`（`src/widget/`，`ap-*` 类名）：那边思考与工具调用都是
  **一条扁平行** `[图标] [标签] [内容] [›]`，无边框无底色，hover 才有淡底，展开体只有一条左边框竖线。
  本项目的 `CollapsibleRow` / `ReasoningPanel` / `ToolCallRow` 是它的 Tailwind 移植版，**不要再写成带边框底色的卡片**。
- **折叠动画 `0fr → 1fr` 有前置条件**：展开体（grid item）必须 `min-h-0` 且 `overflow` 不为 `visible` ——
  `fr` 轨道的 `auto` 最小尺寸就是 grid item 的 min-content，item 不是滚动容器时会把 0fr 轨道直接顶开。
  收起态 `overflow-hidden`、展开态 `max-h-64 overflow-y-auto`，两个分支**互斥**
  （`cn` 是 tailwind-merge 语义，`overflow-hidden` 会吃掉后面的 `overflow-y-*`，同时写会静默失效）。
- 折叠容器的**纵向 padding 必须放在 grid item 内部**：写在容器上时收起后会留一条缝。
- **横条按内容宽度收（`w-fit max-w-full`），不占满整宽**（用户明确要求，别改回 `w-full`）；
  工具横条里的**滚动条只能有一条** —— `pre` 不要自己设 `max-height`/`overflow`，统一由展开体承担。
- **思考横条的单行实时预览必须纵向滚，不能横向滚**：现在是
  `block h-[1.4em] leading-[1.4] whitespace-pre-wrap break-words overflow-hidden`，
  流式时 `lineRef.scrollTop = scrollHeight`。⚠️ 别改回 `whitespace-nowrap` + `scrollLeft` ——
  那样换行符被折叠成空格，整段思考挤成一条横线。预览要用 `text.trimEnd()`（模型常在段间吐 `\n\n`，
  视口只有一行高，不去掉尾部空白就显示成空行）。高度用 `em` 而不是写死 px，跟字号联动。
- **字号**：横条 `text-sm`(14px)、正文 `text-[15px]`、代码块 `text-[13px]`。
  **不要用 10px/11px 当正文字号**（用户反馈过「字体太小」）。
- 新增「可折叠的一行」一律套 `CollapsibleRow`；状态与配色用 `ToolCallRow` 的 `toolRunStatus()` + `TOOL_LABELS`
  （Agent 页与终端 AI 助手共用，别各写一份）。

**19. 对话流滚动是共用 hook，且发消息 = 直接滚到底**

- **当前行为（用户明确要求）**：发出去就直接发，消息追加后滚到最底部。
  **不要**再做成终端 `clear` 那种「把刚发的消息钉在视口顶部、旧内容顶出去」——
  清屏观感依赖「下方内容够不够高」，长回复 / 短回复表现不一致。
- 共用实现是 `features/agent/Conversation.tsx` 的 `<Conversation>` + `useConversation()`
  （Agent 页与 `AiPanel` 共用，**别再抄第三份**），底层贴底交给 **`use-stick-to-bottom`**（devDependency）——
  早先那版自研 hook `useMessageListScroll.ts` 已删除，它里面的 `programmaticTopRef` /
  `prevScrollTopRef` / `hasListSelection` 那套手写逻辑**连同它的 bug 一起没了**，别照着旧文档重建。
  - 库的行为是「已贴底时才跟随内容增长，用户上滚即停、滚回底部恢复」，动画是 spring ——
    「消息向上流动」的顺滑观感来自它，不要自己写 `scrollTop` 赋值去接管。
  - **自己发消息 / 切换会话 / 消息装载完成**：调用方递增 `resetKey`，组件里 `useLayoutEffect`
    调 `scrollToBottom({ animation: 'instant' })`，在本帧 paint 之前落底（库默认的 spring 会让
    「从顶部平滑接管下来」，看着像延迟）。这条是用户明确要求的行为：发出去就直接发、滚到底部，
    **不要**做成终端 `clear` 那种「把刚发的消息钉在视口顶部」。
  - **用户手动开合折叠块**：先调 `useConversation().holdScroll()`（转调库的 `stopScroll()`）退出跟随，
    否则刚展开的内容会把视图拽到底部、点开的那张卡被顶走。调用点在 `CollapsibleRow.tsx`。
  - 容器上用 `overflow-anchor: none` 关掉 Chromium 的滚动锚定（流式内容增长 / markdown 重排时
    它会「帮忙」修正滚动位置，造成偶发跳顶）。滚动位置只由 `use-stick-to-bottom` 显式管理。
- **「滚动到底部」按钮**：`<ConversationScrollButton>`，不在底部时才出现，**`sticky bottom-4`**
  （在滚动容器**里面**，所以是 sticky 而不是 absolute —— absolute 会在内容长高时跟着跑掉）、`size-8` 圆形，
  **带 `aria-label="滚动到底部"`**（脚本靠它定位）。Agent 页与 `AiPanel` **各有一个**，
  查找时必须限定在当前消息列表容器内，不能用全局 `querySelector`。
- **编辑并重发**：点 `MessageEditButton` 只把内容灌进底部输入框（**不是就地编辑气泡**），
  发送时走 `resendAgentMessage` / `resendAiMessage` —— 它们**先同步 `set` 截断 `messages.slice(0, index)`**，
  再交给 `sendAgentMessage` / `sendAiMessage`；顺序反了会把「编辑前 + 编辑后」两条一起喂给模型。Esc 取消。
- **AiPanel 的差异**：输入框是**单行 antd `Input`**（不是 textarea）；编辑提示条在卡片顶部；
  点「编辑」会顺手 `setAiMinimized(sessionId, false)` 撑开卡片；它挂在**面板组的终端页面**上
  （`PanelView` 里 `aiOpen && aiSessionId`），不是活动栏功能区 —— 做 fixture 别手搓
  `sessions`/`groups`/`layout`/`ui.panelTabs`，直接调 `createLocalSession()` + `setSessionAiOpen(sid, true)` + `setAiMinimized(sid, false)`。
- 共用的页面内小工具在 `scripts/lib/agent-dom.mjs`（**选择器不写死宽度类**，从 fixture 文本反推容器）。

**20. antd 组件与 CDP 脚本的静默陷阱（写验证脚本时必踩）**

- **antd 会给恰好两个汉字的按钮中间插空格**（`关闭` 的 `textContent` 是 `关 闭`）——
  按 `textContent === '关闭'` 找按钮永远找不到，而 `if (btn)` 会把「没点到」静默咽掉。**比对前先去掉空白。**
- **合成事件关不掉 antd 下拉**：`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))` 实测无效。
  关不掉的后果是后面切换工作区时，旧标签那个**已展开的下拉仍留在 DOM 里**（`offsetParent !== null`），
  数菜单条目时把两层一起数进来 → 断言假 FAIL。正确姿势：Dropdown 的 `trigger=['click']` 是开关，**再点一次触发器**。
- `console.log('文案：', value)` 多参数之间会**插一个空格**，脚本里别按整句比对。
- **探针里 `cdp.eval` 的代码经 Node 模板字面量插值：正则转义会被吃掉一层** —— 源码里写 `/\s+/g`（单反斜杠），页面实际执行的是 `/s+/g`，去空白**静默失效**（按钮按去空白文本匹配永远 `NOT-FOUND`；旁边独立写的同类表达式却正常，因为那里写的是 `\\s`）。**探针源码里的正则一律写 `\\s`**；排查「同名逻辑一处好一处坏」先 dump 页面侧函数源码（`.toString()`）对字节。

**21. antd 的 cssinjs 压过 Tailwind：给 antd 组件写宽度类会被静默吃掉**

- **根因**：antd 6 的样式是运行时注入的 cssinjs，**不在 `@layer` 里**，优先级高于 Tailwind 的
  `@layer utilities`。所以 `<Input className="w-56" />` 里那个 `w-56` **不生效也不报错** ——
  `.ant-input { width: 100% }` 直接把它压掉。
- **踩坑现场**：旧自动化脚本页的起始地址栏写的是 `<Input className="w-56 shrink-0" />`，
  实测计算宽度 **951px**（不是 224px）。它又带 `shrink-0`（不许被压缩），于是整条工具栏被顶出容器：
  溢出 190px，右侧按钮组整个跑到可视区外，**用户直接看不到按钮**。（该功能区已移除，案例保留。）
- **正确写法**：宽度交给**外层 div**，别写在 antd 组件上。
  ```tsx
  <div className="w-56 shrink-0">
    <Input size="small" className="text-xs" />
  </div>
  ```
- **同类风险的判定**：不是所有 antd 组件都这样。`Select` 实测 `className="w-28"` 是 **112px = w-28，正常生效** ——
  因为 antd 没有给 `.ant-select` 根节点设整体 `width`。**只有那些 antd 自己写了 `width: 100%` 的组件
  （`Input` / `Input.TextArea` 等）才会被压掉**。改之前先用 CDP 读一次 `getBoundingClientRect().width` 实测，别猜。
- 顺带记一条 antd 6 的结构变化：`Select` 的边框画在根节点 `.ant-select` 上，内层是 `.ant-select-content`
  （`border-width: 0`），**antd 5 的 `.ant-select-selector` 已经不存在** —— 照旧写法改它不报错也不生效。

**22. `ResizeHandle` 的方向 —— 受控面板在右侧时必须 `invert`**

- 拖拽条自己的逻辑：`delta = clientX - startX`（不动方向）。视觉上「往右拖 = 拖拽条右边的面板变宽」。
- `invert = true` 时取相反数，意思是「往左拖 = 右边的面板变宽」。
- 规则：**分隔条左边的面板用 `invert={false}`**，**右边的面板用 `invert={true}`**（浏览器面板在分隔条右侧，
  往左拖才是把它拉宽）。
- 用户报告「拖动改变宽度方向反了」就是这个：旧自动化页一开始没传 `invert`，鼠标往右拖面板反而变窄，
  体验像坏了（该功能区已移除，案例保留）。
- `ResizeHandle` 还用在侧边栏宽度（`app/App.tsx`）、Agent 页（`agent/AgentPage.tsx`）等多处；
  验证脚本**不能** `document.querySelector('[title="拖动调整宽度"]')` 一把抓，否则命中的可能是旁人的
  那个（实测踩过 —— 跑出来 pane 是 991 / editor 是 288，比例 3.44，根因就是选错了侧边栏的把手）。
  从页内一个已知按钮反推到页面根组件，再在根内 query。

**23. 标签内容宿主必须是 flex 列，否则面板根的 flex-1 静默失效、长列表滚不动**

- **现场**：主机日志多起来后，列表滚不动，可视区以下的内容被裁掉（列表容器自己的类是
  `min-h-0 flex-1 overflow-auto`，看着没毛病，别只盯着它查）。
- **根因**：`PanelView` 里每个标签的包层原来是 `<div className="h-full">` —— **裸块级**。
  面板根（如 `HostLogsPanel` 的 `flex min-h-0 flex-1 flex-col`）的 `flex-1` 只在父级是 flex 容器时才有意义，
  裸块级父下它不生效 → 面板高度 = 内容高度（实测条目容器涨到 24322px）→ 内部 `overflow-auto` 的
  `clientHeight` 永远等于 `scrollHeight`，永远没有滚动条；超出的部分溢到 pane 容器的 `overflow-hidden` 被裁掉。
- **正确做法**：包层写 `flex h-full flex-col`（已改）。这样 `flex-1` 根拿到确定高度、`min-h-0` 生效，
  内部滚动容器才真正被压扁、可滚。`h-full` 根的页面（终端 / 笔记 / SFTP / API / Agent…）不受影响 ——
  100% 高度在块级与 flex 父下都成立；auto 高度的根也不变（flex 列主轴不拉伸）。
- **同类已被此修复覆盖**：`TunnelsPanel`、`PluginsPage`（同款 `flex min-h-0 flex-1` 根），
  此前只是内容不够长没暴露。**新建面板还想用这个根式样，别再怀疑宿主**。
- **验证**：`tmp/probe-logs-scroll.mjs`（开日志标签 → 注 300 条假日志 → 量滚动容器）；修复前
  clientHeight/scrollHeight = 24322/24322、scrollTop 恒 0，修复后 592/24322、能滚到最后一条。
  判断面板「能否滚」不要看有没有滚动条类名，直接量 `clientHeight < scrollHeight` 再说 `scrollTop` 能不能动。

**24. 文本拆进多个 flex 子项时，边界空格会被 CSS 裁掉（命令预测显示成 `gitstatus`）**

- **现场**：终端命令预测下拉框里，多词命令显示成 `gitstatus`（用户报告「命令预测中的命令缺少了空格」）。
- **根因**：建议行 `button` 是 flex 容器，前缀 `{buf}` 与高亮剩余 `{rest}` 是两个子 span ——
  它们各自成为 flex 子项（块容器），边界空格（前段结尾 / 后段开头）落在各自行盒的行尾 / 行首，
  CSS 排版阶段按「行首 / 行尾的可折叠空格被移除」直接裁掉（`textContent` 仍是 `git status`，DOM 看不出）。
- **正确做法**：两段文字放回**同一个元素**（外层 span 照旧 `truncate`，内层 span 只挂 `font-medium text-primary`）——
  空格变成行内文本流的中段空格，不会被裁。⚠️ 前后缀高亮类渲染（diff / 搜索命中标注）都别把边界空格留在两个 flex 子项之间。
- **验证**：`scripts/verify-terminal-prediction.mjs` 按**渲染宽度**断言（range 联合包围盒 vs 同字体「带空格 / 粘连」两个基准）；
  **结构断言测不出来** —— 两种结构渲染出的文本内容一致，只有宽度 / 截图能看出差别。

**25. 全屏程序里「组合键之后的可打印键」被当成命令行输入（tmux 的 `Ctrl+B d` 误弹命令预测）**

- **现场**：tmux 里按 `Ctrl+B` 再按 `d`（detach），终端里没有任何输入回显，却弹出了命令预测面板 ——
  凭 `d` 前缀匹配出 `df` / `du` / `docker`…（用户报告）。vim 里按 `dd`、less 里按 `d`（翻页）同理。
- **根因**：本地预测只按「是不是可打印文本」跟踪缓冲。`Ctrl+B`（`\x02`）是控制字符，会把缓冲重置；
  但紧随其后的 `d` 是可打印字符，于是被当成用户在 shell 里敲的内容累积起来。tmux / vim / less
  这类全屏程序会把「组合键之后的可打印键」当作自己的命令消费掉，屏幕不回显 —— 本地缓冲与真实
  命令行彻底脱节。**本地无从区分 tmux 的 prefix 与 readline 的同类按键**（`\x02` 本身也被 tmux 吞掉），
  所以「精确修复」不成立。
- **正确做法**：这些全屏程序都跑在 xterm 的**备用屏幕**里 —— `term.buffer.active.type === 'alternate'`
  时整段按键都不参与预测（既不累积缓冲、也不拦截 `→` / `Ctrl+↑↓`），原样交给程序。
  ⚠️ 别退回「只看控制字符」的做法，那正是这个坑；也别把判断挪到 `recompute` 之外更宽松的位置。
- **代价**：tmux 窗口里的 shell 提示符下也不再有命令预测（那些键从本地看与 tmux 命令键无法区分）。
  想要「tmux 内也能预测」需要 shell 集成（OSC 133 之类）给出命令行边界，目前没做。
- **验证**：`scripts/verify-terminal-prediction.mjs` 用例 5 —— 先确认普通提示符下按 `d` 确实会弹
  （否则「不弹」说明不了问题），再用 shell 打印 `?1049h` 真进备用屏幕，断言按 `d` 不弹，最后 `?1049l` 回主屏。
**26. 面板组里所有标签常驻挂载：隐藏标签的 ResizeObserver 要防「尺寸塌缩」**
- `PanelView` 的标签不是按需挂载：切走的标签留在 DOM 里（加 `hidden` 类），RDP / 终端这类**有连接状态的页面
  切回来不用重连** —— 代价是**隐藏时观察者回调照样触发**。
- `RdpPage` 的尺寸守卫（`phase === 'connected'` 的 ResizeObserver）：回调里先防抖 400ms（拖拽分屏一秒几十次），
  再量容器 rect，`width < 200 || height < 150` 直接跳过 —— `display:none` 下 rect 全 0，把 0×0 当 resize
  发给远端会让桌面缩成一团；切回可见时观察者会再触发一次，不用手动补。
- 「标签是否可见」不要自己加 prop 透传：量 rect 就够，任何显示层变化都自动覆盖。

**27. React StrictMode 下「异步建连接」的 effect 不能用 cleanup 无脑拆**

- **现场**：dev 下 StrictMode 让 effect「建立 → 清理 → 再建立」跑两遍。天真写法（cleanup 里直接
  `rdp.close(connId)`）：第一次的 cleanup 若晚于第二次 run 的 `rdp.open` 落地，会把新 run 正在用的桥关掉
  （表现为偶发「连不上 / 秒断」，release 正常，只在 dev 复现）。
- **正确做法**（`RdpPage` 的 epoch 守卫）：`epochRef` 世代号 —— 每个 run 开头 `const myToken = ++epochRef.current`，
  每个 await 之后先查 `myToken !== epochRef.current` 就静默退出（让位给新 run，**不动桥**）；只有
  `cancelled && myToken === epochRef.current`（真卸载）才 `rdp.close`。
- 同类竞态：`build.connect()` 的结果回来时若已换代 / 已卸载，要先把 session `shutdown()` 再释放桥，别只丢引用
  —— WASM 会话里跑着 Rust 事件循环。
- 判据：这类 effect 的清理必须**幂等且可归属**（是谁建的谁清）—— 与 4.2「流式事件自带归属」同一思想。

**28. 侧栏列表行的行尾按钮必须绝对定位浮层，不能留在 flex 流里**

- 参考实现是 fishwork 的 `components/Sidebar.tsx`（本仓搬家到
  `shared/components/SidebarRowActions.tsx`）。**问题**：把按钮留在 flex 行里只加
  `opacity-0 group-hover:opacity-100`（或 `invisible` / `hidden`）**照样占一整格宽度** ——
  侧栏本来就窄，悬停才出现的按钮却全程在吃名字的宽度，长名字被提前截成几个字。
  主机 / 脚本 / 接口 / 笔记 / 面板都犯过，插件面板连 `Switch` 右侧那列都被两个按钮撑宽过 16px。
- 正确做法：`SidebarRowActions` 绝对定位在行右侧（`pointer-events-none`，
  hover 时 `group-hover:pointer-events-auto group-hover:opacity-100`，窄屏常显），
  底衬 `bg-gradient-to-l from-sidebar` 渐隐；名字平时吃满整行，只用
  `SIDEBAR_ROW_NAME.{one,two,three}`（`min-w-0 flex-1 truncate group-hover:pe-*`）在 hover 时让位。
  ⚠️ 按钮数与 `pe-*` **必须匹配**（每个按钮 = 18px + 2px 间隙 + 浮层 16px 内边距）：
  少让位文字会压在按钮下，多让位等于没修好。
- 顺带一条：**名称后紧跟的小元素（折叠箭头 / 取色点 / 数量）不能跟着 `flex-1`** ——
  否则它被顶到行尾、正好钻进浮层按钮底下（都是 hover 才显形，撞上看不出来）。
  这类行把让位类用在**外层容器**（`SIDEBAR_ROW_TRAIL_RESERVE`），名称只给 `truncate` 不给 `flex-1`。
- AI Agent 侧里「**新建会话**」从「更多」下拉里提出来常驻行尾、放在 more 左边（最高频动作）；
  探针定位走 `button[title$="中新建会话"]`，见 `scripts/verify-agent-acp-import.mjs`。

**31. `Form.useWatch` 只看得见「已注册字段」—— 别把 Form.Item 拆掉**

- **现场**：新建主机对话框的主机类型分段（Segmented）用 `Form.useWatch('kind')` 驱动分支字段区。
  点击切换后选中态变了（store 里 `kind` 也已是新值），但字段区**永远渲染默认分支**，无任何报错。
- **根因**（@rc-component/form 1.8.6 源码级实测）：WatcherCenter 每批变更后把 `formInst.getFieldsValue()`
  （**不带 `true`**）交给 watcher —— 只遍历 **Form.Item 注册过的**字段实体。分段选择器写成裸
  `<Segmented value={...} onChange={form.setFieldValue('kind', ...)}/>`（没包 `<Form.Item name="kind">`）时，
  store 有值但 watch 永远收到 `undefined`，三元分支静默走错。
- **正确做法**：受 watch 驱动的控件必须包在对应 name 的 `Form.Item` 里（Field 注入 value / onChange）；
  子控件 `onChange` 只放「切换时的副作用」（如端口从 22 换成 3389），不要再手写
  `setFieldValue('kind', ...)` —— Field 先派发 store 更新、再调子组件 onChange，顺序安全。
- **验证**：`scripts/verify-rdp-host-ui.mjs`（切「远程桌面」→ rdp 字段齐备、端口自动 3389）。

**32. 拖块时关笔记标签 → `Context "dropIndicatorState" not found`（上游定时器活得比编辑器久）**

- **现场**：拖动块的过程中把笔记标签关掉（或任何让编辑器卸载的动作），控制台一条没人接的
  `Uncaught MilkdownError: Context "dropIndicatorState" not found`。功能不受影响，只是脏异常。
- **根因**（上游两处叠加，调用点绕不开）：`prosemirror-drop-indicator` 在 drop / dragend / dragleave 时
  **延迟 30ms** 才调 `onHide`，而它插件视图的 `destroy` 只摘监听、**不 `clearTimeout`** ——
  那个定时器活得比 Milkdown 编辑器还久；同时 `dropIndicatorState` 是 `$ctx` 注入的 slice，
  cleanup 就是 `ctx.remove(slice)`，`editor.destroy()` 一跑它就从容器里没了。
  两者一对：定时器落在 destroy 之后触发时，`onHide` 的 `ctx.set(dropIndicatorState.key, null)`
  在 `Container.get` 找不到 slice，直接抛，而它跑在 `setTimeout` 里，谁也接不住。
- **正确做法**：`MilkdownEditor.tsx` 的 `guardDropIndicatorStateWrites` 在建编辑器时（**create 之前**）
  给 `editor.ctx` 的 `set` 套一层护栏，只拦 `dropIndicatorState` 这一个 slice 且 `isInjected` 为假时静默丢弃。
  挂**实例**上就够（`Ctx` 的方法是实例上的箭头函数字段，`#prepare` 里 `ctx.produce(undefined)`
  返回的就是 `#ctx` 本身）；⚠️ **别改成「ctx 写不存在的 slice 一律忽略」** —— 那会把真正的
  「忘了 inject」也一起吞掉，别处的 ctx 缺失仍然是 bug。
- **验证**：`scripts/verify-notes-drop-indicator-teardown.mjs`。⚠️**已移除**（笔记块拖拽改用 `probe-notes-block-drag-real.mjs` 探针）

### 6.7 数据与文件

**29. 导入 / 导出：zip 是自己实现的，凭据不导出**

- 入口：状态栏左下角菜单 →「导入 / 导出」二级菜单 → `DataTransferDialog`。
- 压缩包结构：一类数据一个 JSON（`hosts.json` / `notes.json` / `api.json`），外壳统一是
  `TransferPayload`（`version` + `kind` + `groups` + `items`）。导入**先写分组再写条目**，条目的 `groupId` 才指得到东西。
- zip 实现是 `services/transfer/zip.ts`（`node:zlib` 的 deflate + 手写 ZIP 头 / 中央目录 / EOCD）。
  **不要引 archiver** —— 它只是 electron-builder 间接带进来的，不是声明依赖。
- ⚠️ **凭据不导出**：主机密码 / 私钥 / 口令是 safeStorage 加密且**绑本机与系统账号**，
  拷到别的机器解不开（`decrypt` 只返回 `undefined`）。导出只带连接元数据，导入后要重新填 —— 别改回带凭据。
- 导入按 id upsert（同 id 覆盖、不同 id 新增），回报「新增 / 更新」条数；涉及的分组与列表都要重新拉，
  否则侧边栏还是旧数据。
- 验证用**双向交叉验证**：我们生成的 zip 用系统 `Expand-Archive` 能解开且内容一致；
  系统 `Compress-Archive` 生成的 zip 用 `readZip` 能读出且内容一致（含 UTF-8 文件名）。

**30. 应用图标一共 4 处，换图时必须同步**

改 `resources/app-icon.png` **不会**自动带动其他三处（否则标题栏、安装包、exe 还是旧图）。

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `resources/app-icon.png` | 985×985 | **唯一真源**。`services/system/icon.ts` 的 `resolveIconPath()` → 窗口 / 托盘 / 通知；打包经 `extraResources` 进安装目录 |
| `build/icon.ico` | 多尺寸 16/24/32/48/64/128/256 | `build.win.icon`，安装包 + exe 图标 |
| `build/icon.png` | 512×512 | electron-builder 默认图标（Linux 目标等未被 `win.icon` 覆盖的场景） |
| `src/renderer/src/assets/app-icon.png` | 256×256 | 标题栏左上角 logo（渲染 20px，200% DPI 下最多用 40px，256 足够） |

- ⚠️ `build/` 下**没有** `icon.icns`，`build.mac` 也没配 `icon` → 出 mac 包会退回 Electron 默认图标。
- 生成多尺寸 ICO 用 Pillow：`Image.save(path, format="ICO", sizes=[(s,s) for s in …])`；
  覆盖产物用 `shutil.copyfile` 先写临时目录再拷过去，别 `os.remove` 旧文件。

**31. cURL 导入的协议头补齐**

- `features/api/api-client.ts` 的 `parseCurl` 在 return 前补：url 不以 `http(s)://` 开头则补 `http://`
  （正则 `/^https?:\/\//i`；已有的 `ftp://` 等原样保留）。
- `--data-binary '@'` 这类「占位 / 空 body」按 cURL 规则**保持 POST**，不要自作主张解析成 GET。

**32. 终端命令记录：PTY 输出没有边界标记，别按「命令→输出」严格配对**

- 命中信号：命令条目的 detail 经常为空 / 相邻两条命令的输出混在一条上。根因：PTY 是裸字节流、无
  shell 集成（无 OSC 133），命令重建只能按控制序列推断；ConPTY/PSReadLine 的回显**迟到且分片**。
- 命令侧：方向键 / Tab 补全 / 光标移动等无法跟进的序列把当前行作废（宁缺毋错），**绝不猜一条没执行过的命令**。
- 输出侧：提交下一条命令就收尾上一条会把迟到输出丢成孤儿 —— `submit` 里上一命令 `pendingRaw.length === 0`
  时**不收尾**（槽位保留等它）；无效行回车不抢占槽位。极速连发时输出整段后移只能接受，以原始文件为准。
- ⚠️ `hostLogger.update(seq, { detail })` 即使 detail 为空 / 与上次相同也会广播 + 落盘一行 —— 回填前先比对
  （纯界面重绘清洗后是空串，直接跳过），否则 host.log 被空 update 撑爆。
- ⚠️ bracketed paste 标记不是所有 shell 都认（Windows PowerShell 5.1 未启用 `?2004h`，合成标记会吞输入）——
  探针里该用例必须放最后（见 5.2）。
- 验证：`scripts/verify-terminal-logging.mjs`。

---

**33. 「目录条目」展开成一大片文件名 = 被用户当成「一堆被修改的文件」**

- **现场**：源码管理面板的「更改」区，用户「明明没有改动」，却列出了很多「被修改的文件」，
  而且这些名字**点不开、也没有 diff**（原话：面板彻底崩了）。
- **根因**：那些名字**不是变更行**，而是**未跟踪目录条目**（嵌套仓库 / 链接目录，`status` 里只有
  `?? sub/` 一行）被展开后从磁盘递归列出来的**只读预览** —— 当时上限 200 条、且没有任何说明文字。
  真实项目里一展开就铺满整屏（实测 `activity-platform` 里嵌着 `activity-platform-app-v2`）。
- **正确做法**：目录条目展开必须①写明「只读、不参与提交」，②限制条数
  （`services/git.ts` 的 `listGitDir` 默认 **20**），③整块用浅色卡片与变更行明显区分。
  ⚠️ 不要因此去掉展开（用户会回头问「为什么点不开」），也不要放宽上限。
- **排查提示**：先分清「更改列表本身」和「某一行展开后的内容」—— `git status --porcelain -uall` 的
  行数才是前者（本次实测外层仓库只有 3 行：`M go.mod` + `?? activity-platform-app-v2/`）。
- **验证**：`scripts/verify-git-changes.ts`（目录条目预览上限 20）。

**34. 导入的 ACP 会话「正文被折进折叠条、复制按钮却复制看不见的文本」= 两处叠加**

- **现场**（用户报告）：ACP 导入的会话里很多消息被折成一行「思考 ×n · 工具调用 ×n」，
  **正文（最终回答）也跟着被折进去**，屏幕上看不到任何输出；折叠条下方却有一个复制按钮，
  复制出来的正是那段看不见的正文。纯思考 + 工具调用（没有正文）的消息整条折叠是**正常**的。
- **根因一（主进程装配）**：`session/load` 回放的「工具调用 → 完成更新」之间可能夹着**下一条消息的正文**
  —— 分段只看 `ContentChunk.messageId`，而 `ToolCall` / `ToolCallUpdate` **协议里就没有 messageId**，
  唯一线索是 `toolCallId`。原来 `pushTool` 一律把结果塞给「当前消息」，于是结果落到新那条消息上，
  渲染端按 `toolCallId` 找不到调用，只能当**孤儿结果**补在末尾 → 那条消息的末尾成了工具。
- **根因二（渲染端折叠）**：`turn-fold.tsx` 的 `findTailStart` 只认「末尾连续正文」，
  末尾不是正文时 `tailStart === units.length`，**整条消息（含正文）**全被折进折叠条。
- **正确做法**：①`services/ai/acp-history.ts` 的 `HistoryAssembler.pushTool` 按 `toolCallId`
  把结果路由回**调用所在的那条消息**（查不到才兜底给当前消息，结果不能丢）；
  ②`findTailStart` 在「末尾不是正文」时退到**最后一个正文块**，它之后的过程留在可见区 ——
  正文绝不能被折进折叠条。两处都要留：①治数据、②保证任何排序下正文都可见（mastra 的轮次也可能末尾是工具）。
- **验证**：`scripts/verify-acp-history.ts`（装配器单测，含「结果不许落到下一条消息」）+ 
  `scripts/verify-agent-acp-import.mjs`（注入 `[思考, 工具, 正文, 工具, 工具]` 断言正文在折叠条**外面**、
  纯工具轮次没有复制按钮）。⚠️ 断言要量「正文在不在折叠体里」（`bar.nextElementSibling`），
  只看 `innerText` 是看不出被折没折的 —— 折叠体收起时内容仍在 DOM 里。

**35. 标签关闭确认是「页面主导的裁决 + 回执」，别改回全局 Modal、单槽位 guard，或「先激活再赌 50ms」**

- **触发信号**：给某类标签加关闭确认时不知道往哪加；或关笔记 / Agent 标签只弹「确定关闭标签？」
  通用确认，页面自己的确认（未保存三选一 / Agent 运行中）永远不出现 —— 后者就是单槽位事故的现象。
- **根因（旧实现事故）**：旧 `ui.tabCloseGuards` 是 `Record<tabId, guard>` 单槽位，`TabContentGuard`
  （父组件）与页面（子组件）注册**同一个 tabId** —— React 子组件 effect 先跑、父组件后写，
  页面级 guard 被通用 guard **覆盖成死代码**，而注释还写着「按注册顺序逐一调用」（从未存在过）。
- **协议（`shared/lib/tab-event-bus.ts`，按 tabId 一条总线、多 handler）**：用户入口一律走
  `store.requestClosePanelTab`（× / 右键菜单 / `Ctrl+W` / 关整组都汇到它）→ `requestTabClose({ tabId, groupId, title })`
  → 总线依次 `await` 页面注册的 `close-guard`（`useTabCloseGuard`）→ 全放行才经
  `setTabCloseExecutor` 注入的回调回到 `closePanelTab`。页面 guard 返回**结构化裁决**：

  | 返回值 | 含义 |
  | --- | --- |
  | `{ allow: false }` | 拦下，标签原样留着（用户取消 / 未保存且选了不关） |
  | `{ allow: true, owned: true }` | 放行，且**这次确认由页面负责** → shell 的通用防手滑**让位** |
  | `{ allow: true }`（无 `owned`） | 放行，页面没接管 → shell 兜底问一句「确定关闭标签「x」？」 |

- **`owned` 是「谁负责这次确认」，不是「有没有弹过窗」**：笔记 / Agent 无论脏不脏都返回 `owned: true`
  （干净时直接放行、不再问一句）；终端 / 脚本 / 插件不注册 guard，于是由 `TabContentGuard` 注册的
  `onFallback` 兜底防手滑。旧实现用**写死的类型白名单** `PAGE_MANAGED_CLOSE_TYPES`（note / agent）来区分
  这两类页面，新增页面漏加就弹两次窗 —— 现在这个事实由页面自己在返回值里声明，白名单已删除。
- **四条硬约束（改这个模块时别破坏）**：
  1. **fail closed**：guard 抛错 / 返回非法裁决（缺 `allow`）→ 拦下并回报 `guard-error`，
     **绝不静默放行**。旧实现在 catch 里 `return true`，笔记保存一出错就静默丢草稿 —— 方向反了。
     所以 `useTabCloseGuard` 刻意**不 try/catch**，让总线统一处理。
  2. **没有总线就不关**：总线由 `TabContentGuard` 在标签内容挂载时创建（`releaseTabBus` 在卸载时释放）。
     查不到总线 = 没有任何页面能对这次关闭表态，放行等于绕过全部确认 → 按 `unmounted` 拒掉。
     正常不会发生（`PaneTree` 递归渲染每个叶子组、组内标签**全部保活挂载**，见 PanelView）。
  3. **不抢焦点**：确认框由**组级宿主**提供（`registerCloseHost` / `getCloseHost`，按 `groupId` 存），
     与「哪个标签是激活的」无关。旧实现要先 `activatePanelTab` 再 `setTimeout(50)` 等 React 摘掉 `hidden`
     —— 那是**赌渲染时序**：慢机器上 50ms 不够，确认框留在 `hidden` 里既不可见也不可点，
     `await` 永不落地 → 关闭**静默卡死**；批量关闭时标签条还会挨个闪过去。
  4. **本模块不 import store**（会与 app-store 成环）：注册表都是模块级 Map，「真正执行关闭」由 store 经
     `setTabCloseExecutor` 注入。
- **`useInlineConfirm` 的两种取用方式别混**：`useInlineConfirm()` 是**拥有者**（返回 `confirm` + `element`，
  `element` 必须渲染在自己的 `relative` 容器里）—— 全应用只有 `PanelGroupView` 用，它把 `confirm` 经
  `CloseConfirmProvider` 发给组内所有标签；页面（笔记 / Agent）用 `useCloseConfirm()` **消费**那个确认框，
  自己不再渲染 `element`。缺 provider 时按「一律取消」处理（fail closed，正常不会走到）。
- **确认框本体是 antd Modal**（`shared/components/InlineConfirm.tsx`）：`getContainer={false}` 内联渲染
  在标签面板里（**别省略它** —— 缺省 portal 到 body，`styles.mask/wrapper` 的 absolute 就会以视口为
  包含块、遮罩盖满整窗），`styles.mask/wrapper` 行内样式把 antd 的 `position: fixed` 压成
  `absolute`，定位基准 = 消费方的 `relative` 根容器。
- **`confirmCloseTab` 是所有关闭确认的总开关**（含页面级）：兜底防手滑与笔记「未保存三选一」/
  Agent「运行中」确认都在各自 handler 里读它 —— 关掉后笔记**直接走「不保存直接关闭」**
  （置 `discardingRef` 丢弃草稿、跳过卸载冲刷），Agent 直接放行中断关闭。
  开关只决定「要不要确认」：干净的笔记 / 空闲的 Agent 开着开关也是直接关（没有可确认的状态）。
- **批量关闭逐个独立判断**（`requestCloseGroup` / `requestCloseSiblingTabs`）：快照后 `for` 循环
  `await requestClosePanelTab`，**任一取消即中止剩余**。按用户明确要求**不引入**「全部应用」批量勾选，
  保持每个标签单独问；但确认框挂在组上，所以不再逐个激活标签、标签条不再闪。
  `requestClosePanelTab` 返回 `Promise<boolean>`，`false` = 取消或失败（后者已弹 message，
  `unmounted` 提示「这个标签还没加载完」，`guard-error` 提示原因），**静默失败会表现成「点了 × 没反应」**。
- **验证**：`npm run typecheck` +
  **协议纯逻辑** ⚠️**已移除**（原协议纯逻辑脚本，连同上条的 UI 脚本都已删除；机制本身见上一条）
  （26 项：fail closed / `owned` 让位 / 顺序短路 / 快照迭代 / `unmounted` / 宿主注册表 /
  executor 恰好一次 / 批量逐个独立且取消即中止）+ **界面链路** `node scripts/verify-tab-close-ui.mjs`（⚠️**已移除**）
  （38 项：关非激活标签时确认框可见**且不抢焦点**、内联渲染与遮罩非全窗宽、取消 / 关闭 /
  「以后都不再提示」落盘、开关关掉后不弹、批量按顺序逐个问且取消即中止、笔记干净直接关 /
  改脏弹页面自己的三选一 / 「不保存」不写脏磁盘 / 「取消」标签留着）+ 手工清单 ——
  Agent 流式中确认、保存失败不关、其他分屏不受影响、接口草稿的程序化关闭不受影响。
