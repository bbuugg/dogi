# 验证工具链 · 现有脚本清单

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

### 5.1 隔离实例 + CDP（无 GUI 环境下的标准做法）

用户本机常驻着打包版 Dogi（单实例锁 + Windows 路径大小写不敏感会让 `electron .` 直接 `app.quit()`）。
**不要杀他的进程**，起一个隔离实例：

```bash
MSYS_NO_PATHCONV=1 node_modules/electron/dist/electron.exe . \
  --remote-debugging-port=9333 \
  --user-data-dir="C:/Users/<user>/AppData/Local/Temp/dogi-cdp" \
  --no-sandbox --in-process-gpu --disable-gpu-sandbox   # 必须 run_in_background 启动
```

- 只加 `--disable-gpu` 不够（GPU 起不来会 FATAL），要 `--in-process-gpu` + `--disable-gpu-sandbox`。
- ⚠️ **隔离实例的首次 `loadFile` 不会提交首帧**（实测：`window.__store` 已就绪、`document.body.innerText`
  是空的、`#root` 一个子节点都没有、控制台**没有任何报错**；窗口也是可见的）。
  只等 `window.__store` 就下断言会全部落空。探针里连上之后固定做两件事：
  `await cdp.bringToFront()` + `await cdp.send('Page.reload', { ignoreCache: true })`，
  再轮询界面元素出现（见 `verify-agent-acp-import.mjs` 的 `waitReady`）。
  用户的常驻实例与 `npm run dev` 都不受影响，这是探针环境的特性。
- ⚠️ **CDP 探针里写正则一定要 `\\s`**（模板字面量会把 `\s` 吃成 `s`，见 6.5 第 20 条）——
  `verify-agent-acp-import.mjs` 里按按钮文案匹配（antd 会给两个汉字的按钮插空格）就是踩这个。
- 取调试目标**别用 curl**（本机走代理会回 `upstream connect failed`），用 Node 自带 `fetch`。
- 连 CDP 用 `scripts/lib/cdp.mjs`（Node 22 自带 WebSocket，零依赖）：
  `connect()` → `eval()` / `reload()` / `bringToFront()` / `screenshot()` / `report(checks)`。
- **发按键前必须 `bringToFront()`**（`Page.bringToFront` + `Emulation.setFocusEmulationEnabled`），
  否则 reload 之后 keydown 根本不派发。
- ⚠️ **终端上的滚轮必须用 CDP 真事件**（`Input.dispatchMouseEvent` + `type: 'mouseWheel'`，坐标取元素中心）：
  往 `.xterm-viewport` 上 `dispatchEvent(new WheelEvent(...))` **滚不动** —— xterm v6 的 wheel 监听挂在
  `.xterm-scrollable-element` 里的屏幕元素上，而从 viewport 派发的事件是**向下**传播、到不了监听点。
  实测踩过：回放明明生效（真滚轮能一路滚到会话第一行），合成滚轮却永远停在当前屏幕顶，
  看起来像「修复没起作用」，白查一轮。**断言「历史还在」之前，先确认真事件能滚。**
- **造数据直接 `window.__store.setState(...)`**，别点一串 UI 绕到目标页面；
  切功能区用 `ui: { ...s.ui, activeActivity: 'agent' }`，写完 `sleep(900)` 给 React 一帧。
- **改渲染端后**：`npx vite build --outDir <临时目录>` + `cp -rf` 回 `out/renderer` + `Page.reload`，
  不必重启 Electron。
- **截图要自己 Read 一遍再下结论**：断言只能证明结构，配色 / 对齐 / 图标位置得靠眼睛。
  强制主题：`Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'light' }] })`。

### 5.2 现有验证脚本

| 脚本 | 覆盖 |
| --- | --- |
| `scripts/verify-agent-browser.mjs` | Agent 内嵌浏览器面板：工作区/会话准备 → 点工具栏浏览器按钮 → 面板出现且拿到帧（**验证会话 id 契约**）→ 收起面板不关会话 |
| `scripts/verify-agent-browser-tools.mjs` | Agent 浏览器工具行为：**直接跑 `services/browser/agent.ts` 真源码**（本地假站点），覆盖 navigate → ref 点击 → evaluate 验状态 → 中文输入 → press → wait_for → 截图落盘 → close → 关闭后能重建 |
| `scripts/verify-browser-persistent-profile.mjs` | 浏览器会话持久化 profile：**直接跑 `services/browser/session.ts` 真源码**（本地假站点发持久 cookie）—— 登录态（cookie + localStorage）跨会话重启存活、关会话不删 profile 目录、`purge` 连目录一起清、未注入 profilesRoot 回退临时上下文且不落盘 |
| `scripts/verify-builtin-playwright-mcp.mjs` | 内置 Playwright MCP（`browserToolMode: system` 用的那个）stdio 冒烟：真实子进程跑 CLI —— initialize → tools/list → **真实 browser_navigate**（headless Edge 打开页面）→ browser_snapshot 看到内容。防的是 overrides 强制 mcp 用顶层 playwright 1.63 稳定版后，某次升级 mcp 引入了 1.64+ 才有的 API |
| `scripts/verify-tool-registry.mjs` | 工具注册表与客户端工具（`tool-registry.ts` + `client-tools.ts` 真源码，不起 Electron）—— 同名重复注册抛错、`names()`、`scope` 过滤、`available` 谓词（MCP 带 browser_* 时让位）、MCP 覆盖内置、描述函数按 ctx 现算、**随请求携带的客户端工具进工具集且与内置同名时让位**、confirm 模式下主进程**不**请示（权限在渲染端）、broker 的广播载荷 / 回填 / 执行失败 / `cancel(requestId)` / 通道未就绪。⚠️ `tool-registry.ts` 有运行时依赖（`./steer` / `./plugin-hooks`），复制清单里少一个就 `ERR_MODULE_NOT_FOUND`（见 6.6 第 36 条） |
| `scripts/verify-sub-agent.mjs` ⚠️**已移除** | 子 Agent（`delegate`）+ `buildToolset` 的 `only` / `allowSteer` + 插件钩子（`sub-agent.ts` / `tool-registry.ts` / `steer.ts` / `plugin-hooks.ts` 真源码，不起 Electron；`agent-core` 用桩替掉，只需要 `createAgentFileState`）—— 只读白名单**不含任何改动 / 执行类工具**且全为 `read_*`/`list_*`/`find_*`/`search_*`/`git_read`、`delegate` 未注入执行器时**整体不暴露**（available=false）、`scope` 是 workspace、三种失败路径（无执行器 / 空 task / runner 抛错）都**回说明文本而不抛错**、runner 返回空与超长报告的处理、`only` 只组装白名单里的内置工具、**`allowSteer:false` 不吞插话**（插话仍在注册表里等父 Agent）而缺省档会拼在结果末尾且只注入一次、钩子四条语义（`tool:call` 拦下即不执行且理由当结果 / `tool:result` 改写生效 / 钩子抛错当没挂 / **钩子看到原始结果、插话拼在最末尾**）、两种角色的提示词都声明只读与「不要反问」、步数上限远小于父 Agent 的 500 |
| `scripts/verify-terminal-chat.mjs` | 终端助手并入统一引擎的全链路（隔离实例 + CDP + **进程内 mock LLM**：OpenAI 兼容 SSE，按脚本逐次应答并记录每次请求的工具清单）—— `scope:'terminal'` 工具集含 `run_in_terminal` 且不含工作区工具、客户端工具随请求上报并在**同一请求内**回填续跑、full 不弹确认框 / confirm 由**渲染端**弹框且拒绝对模型是正常结果、`run_in_terminal` 真写进 PTY、终端会话落 `terminal-conversations/` 且不进 agent 列表、草稿转正 / 左侧列表 / 逐条删除 / **面板里没有「清空历史」**、重启后仍在、客户端工具注册表重启后为空、**超长输出落产物**（第 3b 节，见 4.24：`run_in_terminal` 跑 3000 行 → 结果给出产物 id 与精确的下一次读取参数、开头结尾保留在中段之外、再发一轮 `read_tool_output({id, offset, length})` 把中段读回来且读取头给出下一个 offset）。需先 `npm run build`。⚠️ 第 3b 节的命令是**终端 PowerShell 的原生命令**，别再套 `powershell -Command "…"`：双引号里 `$_` 被外层先展开、单引号里的 `"` 又在组装原生参数行时被剥掉，两层壳各吃掉一层引号（两种写法都产不出内容，报错信息长得像工具坏了）；断言产物 id 也要注意 `inlineText` 是 **JSON 字符串**（引号长成 `\"`，正则两边都得容错） |
| `scripts/verify-output-artifact.mjs` | 工具输出的「产物」机制（`services/ai/output-artifact.ts` 真源码，`.artifacttest` 包装跑，**不需要 Electron**，见 4.24）—— 短输出**不建文件**、超限落盘且文本里带 id / 总量 / 续读指引、内联的滚动结尾**确实是真正的末尾**（用 `MIDDLE_UNIQUE_MARK` 哨兵区分头尾中）、**第一块就超内联上限时开头照样填**、按 offset 分段读能逐字拼回全文、`AnsiStripper` 跨块不吞半截转义序列（CSI / OSC 都被劈开过）、非法 id（含 `../`、绝对路径、Windows 保留名）一律拒绝、4MB 上限标 `truncated`、`purgeArtifacts` 只删本会话、**回归：>256KB 输出不再变成空串** |
| `scripts/verify-agent-posix-command.mjs` | Agent `execute_command` 的 Windows POSIX 执行环境 + **命令实时输出旁路**（`agent-core/tools.ts` 真源码，**按 `buildWorkspaceToolDefs()` + 假 ctx** 调用，见 4.23 的静态定义 API）：注入 Git Bash 后 `ls` / 管道 + 通配 / `grep -n` / for 循环 / `$HOME` 按 POSIX 语义工作；不注入时回退 PowerShell 且仍可执行；工具描述如实声明环境；**第 4 节：真跑 `echo L1; echo L2; echo E1 1>&2`，断言 `ctx.onToolOutput` 收到 stdout / stderr 两条流且 toolCallId 正确**（见 4.39）。⚠️ 复制清单里有 `output-artifact.ts`（落盘，见 4.24）、`command-stop.ts`、`shared/confirm.ts`（都是 `tools.ts` 的运行时依赖，见 4.33）—— 少任何一个都 `ERR_MODULE_NOT_FOUND`；需 `DOGI_TEST_BASH=<bash.exe>` 指定 Git Bash，**不指定时 POSIX 用例会失败、第 4 节会 SKIP**（回退 PowerShell 跑 `ls` 只能得到报错，属环境问题不是回归） |
| `scripts/verify-tool-output-throttle.mjs` ⚠️**已移除** | 命令实时输出节流器（`tool-output-throttle.ts` 真源码，纯 Node）—— 首帧立刻下发、随后攒够字符阈值才发、`flush()` 结尾巴；**保序**（换 stream / 换 toolCallId 先把上一条结掉）、**零丢失**（500 条随机切分跨流跨工具 push 后，下发内容的拼接 == push 内容的拼接）、每帧只含单一 key（见 4.39） |
| `scripts/verify-workspace-health.mjs` ⚠️**已移除** | 工作区目录巡检（`workspace-health.ts` 真源码，纯 Node —— 该模块**不 import 任何 Electron / electron-store**，只依赖注入的 `{ list, mark }`，所以一个假宿主就能全测到，见 4.40）—— 判据（真目录 / 不存在 / **路径是文件** / 空串）、`applyDirMissing` 三条语义（幂等时返回**原数组引用**、**不动 `updatedAt`**、恢复时**删字段**而不是写 false、其余项原对象引用不变）、`sweepWorkspaces`（每个有 `path` 的都问一次、`path` 为空整个跳过、返回「有没有翻转」、再扫一轮返回 false）、**目录回来时一轮就恢复**、启动即扫一遍、`onChange` 只在翻转时回调、重复 start / 重复 stop 幂等 |
| `scripts/verify-agent-status.mjs` | 会话列表三态图标 + 系统通知三条路径（前台挡下 / 开关关闭 / 最小化后真发出 —— **会真的弹一条通知**） |
| `scripts/verify-agent-edit-match.ts` | edit_file 匹配引擎（`agent-core/edit-match.ts`，`node --experimental-strip-types` 直接跑）—— 精确替换、找不到 / 多处 / oldString===newString 的报错、replaceAll、9 级模糊匹配链逐个触发（行 trim / 块锚点 Levenshtein / 空白归一 / 缩进弹性 / 转义归一 / 边界 trim / 上下文感知）、转义还原撑大匹配被拒、CRLF 辅助函数（换行符归一是 Windows 下编辑 CRLF 文件的前提） |
| `scripts/verify-agent-file-tools.mjs` | Agent 文件工具行为（`tools.ts` 真源码 + 真临时工作区，包装机制同 posix-command）—— read_file 大文件分段读取（旧实现 >20 万字符连 offset/limit 都抛错的回归）、单行截断、续读 offset 提示、相似文件建议、目录 / 二进制指引；**先读后改**（edit / 覆盖写前必须本会话 read_file 过，外部改动后要求重读，写入也记快照）；edit_file 多处命中不猜 / replaceAll / **CRLF 文件用 LF 的 oldString 编辑且保留 CRLF** / 缩进不一致仍命中；确认模式 guardWrite 拒绝与放行。⚠️ 复制清单里同样有 `output-artifact.ts`（见上一行） |
| `scripts/verify-agent-file-preview.mjs` | `dogi-ws://` 图片解码、SVG 预览↔编辑、`<video>` 的 206 Range、压缩包提示、`../` 越界 |
| `scripts/verify-agent-list-projection.ts` | 会话列表投影的结构共享（`features/agent/conversation-list-meta.ts` 真源码，`node --experimental-strip-types`，**不需要 Electron**）—— 500 次流式增量后投影数组与条目对象**引用不变**（= 不重渲染）、会话内容确实在变（防「修成不更新」）、改名 / `updatedAt` 变化 / 草稿转正 / ACP 绑定回填 / 删除 / 顺序变化才换引用 |
| `scripts/verify-agent-outline-scroll-cost.mjs` | 消息流滚动的每帧开销（隔离实例 + CDP，先 `npm run build`）：页内**打桩计数** `getBoundingClientRect` / `querySelector`，造 50 / 300 轮提问各滚 30 帧 —— 每帧布局读取必须是**对数级**（实测比值 1.34，线性会是 6）、`querySelector` 不再逐条（每帧 1 次而不是几百次）。修复前那段线性扫在 1200 个消息元素上是**每帧 621 次** |
| `scripts/verify-agent-error-parts.mjs` | 错误文案 part 的追加语义 + **命令实时输出的折叠**（`stores/agent-helpers.ts` 真源码，只桩掉 `app-store` / `types` 两条 import）—— 同一轮连着多个 `error` 事件（模型级重试每次尝试失败都发一个）**只留最后一条**、错误文案之后的正文增量另起一段、正文不会被接在 `⚠️ …` 后面；Agent 会话与终端 AI 助手两条路径都验（后者走 `errorPrefix`，`appendAssistantPart` 是统一前的旧入口、早已不存在）；另覆盖 `tool-output-delta` 折进同 id tool-call 的 `liveOutput`、stderr 行首前缀（chunk 落在行中间不重复插）、`tool-result` 收口时清掉、孤儿增量被忽略、超 `MAX_LIVE_OUTPUT` 只留尾部、`stripTransientParts` 摘除且不改原 part（见 4.39） |
| `scripts/verify-agent-project-doc-web-fetch.ts` ⚠️**已移除** | 项目约束文档注入（4.31）+ `web_fetch`（4.32）：**真源码**（`project-doc.ts` / `agent.ts` / `web-fetch.ts` / `output-artifact.ts`），**不起 Electron**。⚠️ 源文件之间是无扩展名相对导入，Node 的 `--experimental-strip-types` 解析不了 —— 先 `npx esbuild scripts/verify-agent-project-doc-web-fetch.ts --bundle --platform=node --format=esm --outfile=tmp/verify-web-fetch.mjs` 再 `node tmp/verify-web-fetch.mjs`。覆盖：无文档返回 null / BOM 剥离 / 空文件跳过回落 `CLAUDE.md` / 超长按 `## ` 边界截断并给 section 名、段落声明优先级 + 截断时给 `read_file` 指引、提示词里权限段落按模式切换且**项目文档排在最后**、本地 HTTP 服务器真抓（标题 / 正文 / script·style·nav·footer 剔除 / 链接绝对化）、`file:` 被拒、非法 URL、长页面落产物并能 `readArtifact` 按 offset **读回中段**（不是开头） |
| `scripts/verify-quick-actions.mjs` | `.dogi/workspace.json` 自动建目录、脏数据降级、下拉入口与顶栏同排、执行命令开终端、弹窗开关 |
| `scripts/verify-host-logs.mjs` | 主机日志全链路：隔离实例 + 进程内 ssh2 测试服务器 —— SSH 四类来源标签与实时推送（`logs:entry`）、TOFU 指纹、隧道强断（error 级）/ 改名重启 / 停止、SFTP 失败路径、JSONL 落盘与清空归零、面板单例标签 / 过滤 / 搜索 |
| `scripts/verify-windows-host.mjs` | Windows 主机支持全链路：三台进程内 ssh2 假服务器（Windows / GBK / Linux）—— `cmd /c ver` 平台探测、Windows 会话 0 条 `monitor:data` + `monitor:unsupported(windows)` + 徽标「不支持监控」、GBK 输出 xterm 渲染与输入字节=GBK 编码比对、Linux UTF-8 透传 + `monitor:data` 回归 |
| `scripts/verify-rdp-bridge.mjs` | RDP 本地桥：假 RDP 服务器（X.224 确认 + STARTTLS 升级 + 回显）—— RDCleanPath 应答同构（3390 / X.224 / 证书链 / server_addr）、WS↔TLS 透传字节一致、脏数据与 destination 不匹配回错误 PDU 且不触碰目标、错误 token 连不上、open 幂等 / 目标 host:port 取自主机配置 / 非法端口兜底 3389 / ssh 类型主机被拒 / `rdp:credentials` 与桥端口同口径 / close 后端口关闭 / `rdp:wasm` 魔数 / **坏 keyUsage 证书降级**（第二台假服务器：默认握手被拒后自动重试 TLS 1.2 静态 RSA 成功、对端恰两次连接、主机日志告警与成功留痕） |
| `scripts/verify-rdp-host-ui.mjs` | 远程桌面主机类型界面链路（隔离实例 + CDP）：新建对话框三分段（默认 SSH → 切「远程桌面」出 rdp 字段、端口 3389 与用户名 administrator 同步预填）→ 保存落库（kind=rdp / 域 / 加密密码）→ 主机菜单无「远程桌面 (RDP)」直达、rdp 无 SFTP / 隧道项 → 编辑对话框类型可切换与回填 → 「连接」开 `rdp-<id>` 标签且不建终端会话 → 读配置开桥自动连接（无真实服务器 → 进入断开态）→ 无密码主机弹凭据对话框、勾选保存把凭据写回配置、rdp 弹窗 footer 按钮贴右缘（防 flex 布局回归）。⚠️ 目标端口无真实 RDP 服务，断言的是流程不是画面 |
| `scripts/verify-sftp-transfers.mjs` | SFTP 上传文件夹 + 传输托盘：进程内假 SFTP 服务器（ssh2 服务端事件式 API，见下方 ⚠️）——「上传 → 上传文件夹…」逐层 MKDIR + 每文件 WRITE（内容比对）、3 笔独立传输落 store（含 `localPath`）、完成条目 6.5s 后仍在（不自动移除）、上传 / 下载带「打开文件位置」/ 已取消不带、`revealPath` 错误路径 `ok:false`、清除已完成清空且入口消失。⚠️ 会真实弹出一次系统文件管理器 |
| `scripts/verify-port-killer.mjs` | 端口占用插件全链路：插件播种/视图注册 → 探针 spawn 的 node 子进程真占随机端口 → 查询命中（PID / 进程名 / 监听中）→ 行内复制命令（`killCommand` 平台格式）→ **Popconfirm 真杀**（子进程退出 + 端口连接被拒 + 自动复查为空）→ 保护/校验分支（kill PID 1 / 非法 / 不存在、search 70000）→ **UDP 占用**（netstat UDP 行没有状态列）→ 重新查询 |
| `scripts/verify-terminal-logging.mjs` | 终端命令 + 输出记录：命令装配（普通 / 退格 / Ctrl+C / 不可还原行不记 / bracketed paste）、`[脚本]` 来源标记、输出增量回填同一条目、原始会话文件（含未记录命令的裸输出）、关闭条目、JSONL 同 seq 多行、面板终端过滤、清空连 `sessions/` 归零。⚠️ bracketed paste 用例必须放最后：部分 PowerShell（如本机 5.1）未启用 `?2004h`，合成标记会吞掉后续回显 |
| `scripts/verify-terminal-prediction.mjs` | 终端命令预测：CDP 真键盘注入（先点终端给 xterm 焦点）——未输入无下拉、「键入 git → 'git status' 行渲染宽度带空格」、「前缀以空格结尾 → 仍带空格」、`→` 接受 → 下拉收起 + PTY 回显补全后的 `git log`、备用屏幕（tmux / vim）里按 `d` 不弹（见 6.5 第 25 条）。⚠️ 防的是 flex 子项边界空格被裁的坑（见 6.5 第 24 条）：断言必须量渲染宽度，`textContent` 测不出来 |
| `scripts/verify-terminal-replay.mjs` | 终端标签换父节点后回放环形缓冲（机制见 4.1）：本地终端灌 60 行 → 拆分**前**能滚到会话第一行（对照组）→ `splitTabToGroup` 分屏后仍能滚到第一行、当前屏幕仍是最新输出 → 拆分后再打哨兵只见一次（**接缝不重复**，证明「先订阅、再取缓冲」的顺序对）且新输出照常到达 → `moveTabToGroup` 跨组并入同样能滚回第一行。⚠️ 滚轮必须用 CDP `Input.dispatchMouseEvent`（见 5.1 的真事件那条），用合成 `WheelEvent` 会误判成回归 |
| `scripts/verify-command-history.ts` | 终端命令历史的服务层（`services/terminal/history.ts` 真源码，`node --experimental-strip-types`，不需要 Electron）—— 空启动、add 落盘、去重置顶（重复执行刷新时间）、trim / 空串拒绝、超长截断、上限 1000 丢最旧、「重启」再 init 读回一致、单条删除（不存在静默）、清空归零、损坏 / 非数组 / 坏条目文件逐条校验降级。⚠️ 落盘是异步链，断言文件内容前必须 `flush()` |
| `scripts/verify-command-history-ui.mjs` | 命令历史的界面链路（隔离实例 + CDP，先 `npm run build`）：真实键盘在终端执行命令 → 回车记入全局 store → **第二个终端标签**的预测下拉出现跨标签历史 → 设置 → 终端管理卡片（条数 / 搜索过滤 / 最新在前 / 行内删除 / Popconfirm 清空）→ 再真实记录一条 → 杀进程重启 → bootstrap 灌回且已删除条目不再出现。⚠️ Modal 底部的版本号 `v0.0.12` 也是 `font-mono`，行断言要选 `span.font-mono[title]`（管理行才有 title）；antd 两字按钮按去空白 textContent 匹配 |
| `tmp/verify-terminal-drop-upload.mjs` ⚠️**已移除** | 终端拖拽上传（SFTP）：进程内假 sshd（pty + shell + SFTP 子系统，REALPATH 固定回家目录）+ 隔离实例，`Input.dispatchDragEvent` 注入**真实原生拖拽**（`data.files` 传绝对路径 → `webUtils.getPathForFile` 拿得到）——拖入文件 + 子目录 → 确认条默认 = 家目录 → 改目录上传 → 远端逐层 MKDIR + 每文件 WRITE 内容逐字节一致、终端「已上传 N 项到 …」、传输托盘 2 笔 done → 再次拖入默认目录被记住 → 本地会话拖入被拒且不建连不传文件。⚠️ CDP 对终端 DOM 刚挂载后的**首次** drop 可能整串被忽略（非代码问题），探针带最多 3 次真实重试 |
| `scripts/verify-tab-close-ui.mjs` ⚠️**已移除** | 标签关闭协议的**界面链路**（隔离实例 + CDP，先 `npm run build`；机制见 6.7 第 35 条）—— ①**关非激活标签**：确认框照样出现且**可见**（宽高非 0、`getContainer={false}` 内联渲染即 `parentElement !== body`、遮罩只盖面板 `maskWidth < innerWidth`）、**且不抢焦点**（`groups[gid].activeTabId` 前后不变 —— 旧实现要先 activate 再 `setTimeout(50)` 赌渲染时序）；②通用防手滑：取消 → 标签与激活态都不动、关闭 → 只关那一个且仍不抢焦点、勾「以后都不再提示」→ `confirmCloseTab` 落盘 `false`、开关关掉后**不再弹**直接关；③**批量关闭逐个问**：`requestCloseGroup` 给两个标签起 `BATCH-A` / `BATCH-B` 可区分名字，断言**按顺序**各问一次（`body` 里是各自标题），中途取消一次 → 整批中止且 `BATCH-B` 从未被问；④**笔记页面接管**（`owned` 让位）：干净笔记**不弹**通用防手滑直接关、改脏后弹的是页面自己的三选一（标题「有未保存的修改」、按钮 `取消 / 不保存 / 保存并关闭`、**没有**「以后都不再提示」勾选框）、选「不保存」→ 关闭且磁盘文件保持原样（草稿真被丢弃）、选「取消」→ 标签留着。⚠️ **`cdp.eval` 是 `awaitPromise:true`：`requestClosePanelTab` / `requestCloseGroup` 这类要等用户点按钮才 resolve 的动作必须 `void` 掉再 eval，否则 eval 会挂到用户点完（第一次跑就是这么死锁超时的）**；⚠️ antd 关掉 Modal 后 **DOM 不移除**（只是 `.ant-modal-wrap` 变 `display:none`），所以「有没有确认框」必须看**可见性**，只看节点在不在会把取消后的残留当「还开着」；⚠️ 改脏笔记要用 **CDP `Input.dispatchKeyEvent` 真键盘**（合成 `execCommand('insertText')` 在后台窗口里被忽略，编辑不脏 → guard 直接放行 → 探针卡在等确认框）；⚠️ 本探针 `launch()` 会**删掉 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`**：沙箱 / CI 里这两个变量会让 `electron.exe` 退化成纯 Node 跑 `out/main/index.js`（报 `does not provide an export named 'BrowserWindow'`），表现为「CDP page not found」的假超时 |
| `scripts/verify-tab-close-bus.ts` ⚠️**已移除** | 标签关闭协议的**纯逻辑**（`shared/lib/tab-event-bus.ts` 真源码，**不起 Electron**）—— ①**fail closed**：guard 抛错 / 返回非法裁决（缺 `allow`）都拦下报 `guard-error` 且 executor 一次不调；②**`owned` 让位**：页面接管（`owned:true`）→ shell 防手滑不问两遍，未带 `owned` / 完全没注册 guard → 兜底问一次，兜底自己拦下 → `rejected`，**拦下时（哪怕带 owned）兜底也不跑**；③**顺序与短路**：guard 按注册顺序跑、拦下即停（后续 guard 与兜底都不跑），兜底只在全部 guard 放行后跑；④**快照迭代**：请求进行中新增的 guard 不参与本轮、下一轮才参与，`onGuard` 的注销函数生效；⑤**`unmounted`**：没有总线 / 没有组级确认宿主都不静默放行（注销宿主后回到 `unmounted`）；⑥**组级宿主注册表**：组重建时旧清理函数按实例比对，不误删新注册的宿主；⑦`ctx.confirm` 就是组级宿主的确认框、`ctx.title` 透传、executor 全放行才调且**恰好一次**；⑧**批量关闭逐个独立**：复刻 store 的循环形状（快照 + 逐个 await + 任一取消即 `break`），第 2 个拦下后第 3 个不再推、只有放行的被关掉。⚠️ 源文件用了 TS **参数属性**（`constructor(private readonly tabId: string)`），Node 的 strip-only 模式不支持（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）—— 先 `npx esbuild scripts/verify-tab-close-bus.ts --bundle --platform=node --format=esm --outfile=tmp/verify-tab-close-bus.mjs` 再 `node tmp/verify-tab-close-bus.mjs`（type-only 的 `@/…` import 会被 esbuild 直接丢掉，不需要别名配置） |
| `scripts/verify-git-changes.ts` | 源代码管理「更改」列表的数据层：**直接跑 `services/git.ts` 真源码**（`node --experimental-strip-types`，不需要打包 / 不起 Electron）—— 临时仓库里验证未跟踪目录被 `-uall` 摊平成目录下的每个文件、列表里没有「以 `/` 结尾的折叠目录」条目、未跟踪文件用 `--no-index` 拿到「整份新增」的 diff、已跟踪文件的 diff 不受影响、未跟踪的**嵌套仓库**输出成带尾斜杠的目录条目（`nested/`，取 diff 返回空）、回退能**递归**删掉整个目录、`listGitDir` 能列出目录条目里的文件（跳过 `.git`，仅只读展示）且**预览上限 20 项**；**`--porcelain=v2`** 的重命名条目带 `origPath`、工作区在**仓库子目录**时只列该前缀下的改动、**空仓库**（unborn HEAD）的分支名不是「No commits yet on …」、`init-commit` 一步到位；分支增删的拦截、远端增删、贮藏 push/pop/apply/drop 与非法 ref |
| `scripts/verify-git-tree.ts` | 源代码管理列表的折树纯函数（`features/agent/git-tree.ts`，`node --experimental-strip-types` 直接跑）—— 多级 / 中文目录名取**路径末段**且非空、不含问号，根目录文件显示文件名，同一目录的多个文件合并成一个节点，完整路径留在 `path`（tooltip 用），重命名按新路径折树且 `origPath` 仍可读，git 的**目录条目**（`nested/`，尾斜杠）取到末段名而不是空串、目录节点带上其下**全部变更路径**（整目录暂存 / 回退用） |
| `scripts/verify-acp-config-options.ts` | ACP 会话配置项与 usage_update 的映射（`services/ai/acp-config-options.ts` 真源码，`node --experimental-strip-types`，**纯逻辑不需要 Electron**）—— select / boolean 的收下与丢弃规则（没 id、没候选项、未知 type 都丢掉）、**分组拍平**、缺 name 退回 value、**未知 / 缺失 category 一律放过**（协议要求优雅处理，自定义项天然可用）、模型项提取（category=model）、`usage_update` → `context-usage` 且**数字缺失时返回 null**（不用 0 冒充「上游报的 0」，圆环会因此显示「没占过」） |
| `scripts/verify-acp-fs.ts` | ACP 客户端文件访问（`services/ai/acp-fs.ts`，`node --experimental-strip-types`）—— 工作区内读写（相对 / 绝对路径、父目录自动创建、覆盖写）、`line` / `limit` 按行截取、越界一律拒绝（`../`、工作区外绝对路径、工作区根、前缀相同的兄弟目录、`sub/../../`） |
| `scripts/verify-acp-history.ts` | ACP 历史回放装配（`services/ai/acp-history.ts` + `src/shared/acp-tools.ts`，复制到 `.acphistorytest/` 后 `node --experimental-strip-types` 跑真源码）—— 按 `messageId` 分段、**工具结果回到调用所在的那条消息**（回放里夹着下一条消息正文的场景，见 6.6 第 34 条）、无 messageId 的启发式（**多轮糊成一条是刻意降级**，见 `pushTool` 的注释）、进行中的 `tool_call_update` 不落结果卡、孤儿结果不丢、思考块成 reasoning、空消息丢弃 |
| `scripts/verify-agent-conversation-model.mjs` | Agent 会话「形态 / 模型选择」的持久化：**真启动两次应用**（同一 `--user-data-dir`）—— 保存带 `modelId` 读得回、不带 `modelId` 再存时保留旧值（`in` 语义）、显式 `undefined` 才清空、重启后 `kind` / `modelId` / `configId` 仍在；**ACP 会话**的 `acpAgentId` / `acpSessionId` 落盘、不带 `kind` 再存时绑定保留、**消息恒为空**（哪怕传了消息） |
| `scripts/verify-agent-acp-import.mjs` | AI Agent 侧边栏 + ACP 会话「登记 → 新建/导入 → 回放」的界面链路（隔离实例 + CDP，见 4.3 / 4.18）：工作区行尾只有「新建会话」下拉（**形态在这里就选**：内置 Agent / 每个已登记的 `ACP · <名字>`）+ 一个「更多操作」下拉（导入 / 重命名 / 删除）→ **新建出来的是草稿**（`draft === true`）、**不进侧边栏列表**、页面上写明「发出第一条消息才建会话」、同一工作区连点两次是同一个空页 → 选内置模型只写草稿 → 发首条消息转正（标题取那条消息、清掉 `draft`、进列表）→ **导入弹窗只做 选 agent / 拉取会话 / 导入**（无检测 / 手动添加 / 新建会话按钮），无 agent 时提示、footer「ACP 设置」打开设置弹窗并定位到 ACP agent 分组、「拉取会话」对起不来的 agent 有反馈 → 用**真实路径**建 ACP 草稿（`createAgentConversation(ws, 'acp', acpAgentId)`，见 4.3）+ `setAcpConversationModel` 选模型→ 模型下拉只列**设置里勾选的**模型、**宽度被限死** → `history` 事件渲染成消息流、**正文不被折进折叠条**（注入 `[思考, 工具, 正文, 工具, 工具]`：正文在折叠体**外面**、纯工具轮次无复制按钮，见 6.6 第 34 条）、ACP 没有「编辑重发」入口 → ACP 草稿发首条消息转正（`acp` + 绑定带上、消息不落盘、进列表）、无草稿残留 → **标签右键菜单**：一级只有「关闭标签」，其余关闭方式收进「关闭」二级。⚠️ 断言列表行数要用 `[data-conversation-id]`（store 条数含草稿）；模型下拉要取**可见标签**里那个（每个标签各渲染一份，隐藏的那份选项按它自己的会话算，会是「暂无数据」）；**悬停展开 antd 子菜单**：真鼠标移动推不出 React 的 `onMouseEnter`，要对标题元素派发**带 `relatedTarget` 的 mouseover**；子菜单弹出层类名是 `.ant-dropdown-menu-submenu-popup`（不是老的 submenu-popup）；合成 contextmenu 没有 clientX/Y，右键要用 `Input.dispatchMouseEvent` 真事件（菜单弹在 (0,0) 会让后续坐标全错）；见 5.1 的「隔离实例首帧不提交」坑（探针里要先 `bringToFront` + `reload`） |
| `scripts/verify-skills.mjs` | 技能发现（含 junction 安装）、无 frontmatter 退化、额外根目录、设置页渲染与开关落盘 |
| `scripts/verify-context-compression.mjs` | 上下文压缩与会话累计（见 4.20）：`.tooltest` 包装直接跑 `services/ai/context.ts` 与 `@shared/agent-usage` **真源码** —— `estimateTokens` 口径、未超预算**零拷贝**、空历史、单轮超预算不压缩、摘要失败回退截断（含 `truncated` 标记与占位说明）、保留比例决定留几轮、非法预算回退默认值；累计 token 累加 / `totalTokens` 不反推 / 缺字段不产生 NaN。⚠️ 摘要失败用例靠**指向本机没人监听的端口**（`127.0.0.1:1`）触发，不碰外网 |
| `scripts/verify-notes-drop-indicator-teardown.mjs` ⚠️**已移除** | 笔记块拖拽的**编辑器销毁期**回归（隔离实例 + CDP，先 `npm run build`）：打一次 `dragleave` 挂上 drop 指示线的 30ms 隐藏定时器 → 只拖不关标签不得抛 → **拖完立刻关标签**，那个落在 destroy 之后的回调也不得抛 `Context "dropIndicatorState" not found`。脚本在页内 hook `setTimeout` 数 30ms 定时器、并断言关闭时定时器仍在排队且编辑器确已从 DOM 摘掉，保证这条门不是空跑（见 6.5 第 32 条） |
| `scripts/check-missing-color-utils.mjs` | 扫描产物 CSS，找出「语义色令牌漏映射导致整族工具类没生成」 |
| `scripts/shot-titlebar.mjs` | 强制 hover 截图 + 计算样式，查标题栏配色 |
| `scripts/browser-input.test.ts` | 浏览器面板的坐标映射纯函数（`object-contain` 留白 / 画面矩形 / 黑边丢点 / 滚轮）。**能直接跑**：`node --experimental-strip-types scripts/browser-input.test.ts`（被测文件只有 type-only import，不需要 `.tooltest` 包装） |
| `scripts/verify-api-body-types.mjs` | 接口请求的请求体四形态（见 4.19）：**直接跑 `services/api/http.ts` 与渲染端 `api-client.ts` 真源码** + 进程内真 HTTP 服务器 —— `none` 不带 body 且 Content-Type 原样不动、urlencoded 序列化（中文 / 空格 / & / 空键跳过）与「没填 Content-Type 才自动补」、显式 charset 不动、form-data 的 boundary / 文件名 / 文件 MIME / **文件字节逐字节一致**（文本 + 含 0x00 的二进制）、请求头里那份没 boundary 的 Content-Type 被丢掉、文件没选或路径不存在 → status 0 且**不发包**、raw 原样透传（回归）、GET/HEAD 不带 body、不就地改调用方 headers；渲染端纯函数（标准 Content-Type 表含 none/raw 为 null、表单空槽位整理、`setContentType` 覆盖/新增、路径取文件名、cURL `-F` 含 `@文件` 与 `-d` 回归） |
| `scripts/verify-openapi-import.ts` | OpenAPI / Swagger 规格导入解析（`features/api/openapi-import.ts` 真源码，`node --experimental-strip-types`，**不需要 Electron**）—— 双格式转换：**OpenAPI 3.x**（servers 拼地址 + {变量} 展开、requestBody.content 挑媒体类型、components.schemas 的 `$ref` 展开、3.1 的 multipart / urlencoded 映射、操作级 security 覆盖根级）与 **Swagger 2.0**（schemes+host+basePath、`in: body` 生成 JSON 示例、consumes 给 Content-Type / produces 给 Accept、formData 文件字段标 isFile、definitions 引用）；公共规则：tag 分组（无 tag 统一进「标题」组 / 混标签时无 tag 进未分组）、路径参数示例替换、查询参数序列化进 URL、JSON 示例生成（example > default > enum[0] > 按类型推断、循环 `$ref` 守卫）、apiKey / http bearer / basic 安全方案预填；错误输入三连（非法 JSON / 缺格式字段 / 不支持的版本号） |
| `scripts/verify-api-body-ui.mjs` | 接口请求请求体四形态的**界面链路**（隔离实例 + CDP，先 `npm run build`）：草稿默认 raw → 切 x-www-form-urlencoded（表格出现、请求头自动补 Content-Type）→ 填表发送 → 服务器收到标准序列化正文 → 切 form-data（「类型」列**在值这一列前面**，DOM 顺序断言）→ 一行改「文件」并**真的选本地文件**（`DOGI_API_PICK_FILE` 旁路，见下）→ 发送后 multipart 文本字段与**文件字节一致**、响应 200 → Ctrl+S 落盘（`bodyType` / 两张表单 / 文件路径 / 历史都带上）→ 换成真实标签后重新载入仍是 form-data 且字段回填 → 切回 raw 时 Content-Type 换成 application/json → 切 `none` 时编辑器与表单都让位、发送后服务器**零字节 body** 且 Content-Type 保持不变。截图落 `tmp/api-body-*.png`。⚠️ 横向分段（Segmented）要读 / 点里面 radio 的 input，不能点 label（同 verify-rdp-host-ui） |

⚠️ 这些脚本**都在自己的临时 `--user-data-dir` 里跑**，跑完会 `fs.rm` 掉它 ——
不清的话上一次留下的会话会累积，store 里的「当前会话」未必是本次建的那个，断言会漂到别的会话上。

⚠️ **假 SFTP 服务器（`verify-sftp-transfers.mjs`）必须用 ssh2 服务端的事件式 API**：
`session.on('sftp')` 的 `accept()` 返回的是**已就绪的 SFTP 协议实例**（不是裸 Channel）——
它自己完成 INIT/VERSION 握手、按请求类型发事件（`OPENDIR` / `READDIR` / `OPEN` / `WRITE` / `CLOSE` /
`STAT` / `LSTAT` / `MKDIR` / `REALPATH` / …），**没有监听者的类型会被自动回 `OP_UNSUPPORTED`**
（现象就是「`sftp:list` 失败：Operation unsupported」），它也**从不发 `'data'` 事件**（自己解析字节流是死路）。
响应一律用实例方法：`status(reqID, code)` / `handle(reqID, Buffer)` / `attrs(reqID, { mode, size, atime, mtime })` /
`name(reqID, { filename, longname, attrs })`；READDIR 读完要发 `status(reqID, 1)`（EOF）；
`OPEN` 的 pflags 里 `0x02` 是 WRITE（只有写句柄在 CLOSE 时落盘）；句柄自建 4 字节 uint32 编号。
主进程侧对应的旁路契约：原生目录选择框无法自动化，`sftp:uploadDir` 读 `DOGI_SFTP_UPLOAD_DIR`
环境变量（**仅探针设置**，正常运行不设就走真对话框；新增「弹原生对话框」的能力照此留旁路）。

⚠️ **假 RDP 服务器（`verify-rdp-bridge.mjs`）的 STARTTLS 升级**：先按 TPKT 长度读齐 X.224 连接请求、
回确认，然后 `socket.pause()` 再把裸 socket 交给 `tls.createServer(...)` 实例 `emit('connection', socket)`
完成服务端 TLS 握手（tls.Server 的 STARTTLS 标准做法）。证书用脚本内嵌的一次性自签固件（仅 127.0.0.1
回环）即可 —— 桥端本就是 `rejectUnauthorized: false`（RDCleanPath 设计：证书链回传给 WASM 客户端判定），
探针只断言「链完整 / 字段对」。坏 keyUsage 的第二台假服务器（29390）沿用同一 STARTTLS 骨架，只换证书固件（keyUsage 仅 `keyEncipherment`）与服务端套件（只留 RSA 密钥交换）—— 专门复现 BoringSSL 的 `KEY_USAGE_BIT_INCORRECT` 与桥的降级重试（见 6.4 第 17 条）。

⚠️ **本地回环 WebSocket 拨号偶发失败**：Windows 负载中极少数情况下，对刚建好的桥的首条 WS 连接会直接
`onerror`（重跑即过，与桥实现无关 —— 已实测复现一次、重跑两次全绿）。探针的 `wsOpen` 为此带 2 次退避重试；
负路径（`expectWsFail`）传 `0` 不重试，保持「单次拨不通 = 连不上」的断言语义。再遇到同类失败先怀疑它，
别急着改桥代码。

⚠️ `verify-port-killer.mjs` 里「被占用的端口」都是**探针自己 spawn 的 node 子进程**（TCP 监听 / UDP 绑定）：
结束时杀的是这个子进程，能拿准退出码、且伤不到任何真实服务 —— **永远不要拿宿主或系统进程当靶子**。
「权限不足 → 弹管理员命令弹窗」分支需要真实高权限进程才能触发（如 SYSTEM 进程），自动化里不制造，
只覆盖命令生成（`killCommand`）与受保护 PID（kill PID 1）分支。

⚠️ 跑浏览器相关脚本时，**DOM 里可能同时存在多个 `alt="浏览器画面"` 的 `<img>`**（历史遗留的隐藏面板）。
按 `querySelectorAll` 取第一个会命中隐藏的那个（rect 为 0），断言全落空 ——
取 img 时要挑 rect 非零的那个。

⚠️ 定位 Agent 顶栏按钮**别按图标类名找**：活动栏的「接口请求」用的也是 `lucide-globe`，
所以那个按钮带 `aria-label="浏览器"`，脚本按它精确定位。

⚠️ `scripts/agent-browser-tools.test.ts` **不能直接 `node` 跑**（无扩展名的相对 import +
`@shared/*` 别名，`--experimental-strip-types` 认不了），要跑包装脚本
`scripts/verify-agent-browser-tools.mjs` —— 它把真源码复制到 `.tooltest/` 只改写 import 说明符，
跑完删掉。见 skill「node-run-ts-without-build」。

⚠️ 「等某条日志出现」要防命中旧记录：同名文案（如隧道「已启动」）重启后会第二次产生，`find` 会立刻
命中旧条 —— 先轮询运行态（`window.__store` 里的 `tunnelRuntime` 等）回到目标值，再等日志。

⚠️ 历史脚本（`verify-agent-msglist` / `verify-agent-scroll-edit` / `verify-agent-aipanel` /
`verify-acp-e2e` / `verify-acp-confirm` / `probe-reasoning` 等）**已不在本仓库**，
本文档里引用它们的地方是保留当时的方法论，不是「去跑它」。

**其他探针**（不起 Electron，直接 `node scripts/xxx.mjs`）：

| 探针 | 回答的问题 |
| --- | --- |
| `scripts/probe-mastra-error-chunks.mjs` | 模型请求失败时 mastra `fullStream` 到底吐几个 `error` chunk —— 用于验证「错误文案为什么堆了多段」的归因（**升级 mastra 后必重跑**，见 6.6 第 30 条） |

**浏览器相关的探针**（不起 Electron，直接 `node scripts/xxx.mjs`；**升级 Playwright 时重跑这几个**）：

| 探针 | 回答的问题 |
| --- | --- |
| `scripts/probe-playwright-screencast.mjs` | screencast 抓帧 + CDP 合成鼠标 / 键盘是否可用 |
| `scripts/probe-playwright-recorder.mjs` | `recorderMode: 'api'` 是否不弹 Inspector、事件流是否给出官方选择器代码 |
| `scripts/probe-aria-ref.mjs` | `ariaSnapshot({ mode: 'ai' })` 是否产出 `[ref=eN]`、`aria-ref=eN` 能否回解析并点击 |

---

## ⚠️ 清单之外（脚本已新增，本文未收录）
下列脚本在 `scripts/` 下存在，但本清单还没写条目 —— 用到前请先读源码确认覆盖范围：

| 脚本 |
| --- |
| `scripts/agent-error-parts.test.ts` |
| `scripts/api-body-types.test.ts` |
| `scripts/context-compression.test.ts` |
| `scripts/probe-notes-block-drag-real.mjs` |
| `scripts/probe-notes-block-drag.mjs` |
| `scripts/verify-agent-chat-handoff.mjs` |
| `scripts/verify-agent-queue.mjs` |
| `scripts/verify-notes-folders.mjs` |
| `scripts/verify-resolve-model-fetch.mjs` |
| `scripts/verify-updater-release.mjs` |
