# 关键机制 · 终端与主机

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

### 4.1 终端数据链：缺一环就黑屏

```
Session.onData → sessionManager.emit('data') → ipc/terminal.ts broadcast → preload 订阅 → xterm.write
```

- 新增会话类型（telnet / 串口 / …）时复制 `SshSession` 的 handlers 模式 —— 它的构造函数**强制**传 handlers，
  所以不会漏；`LocalSession` 当初就是漏了转发导致终端黑屏。
- **重挂载要回放，PTY 不会自己重来**：`TerminalView` 持有 xterm 实例（挂载时 `new Terminal()`、卸载时
  `dispose()`），而渲染端只收**增量**流（`terminal:onData`）。标签一旦**换父节点**就重挂载、新实例缓冲为空 ——
  用户能碰到的入口是「把终端标签拖到分屏」（`splitTabToGroup`）或「拖到另一组」（`moveTabToGroup`）：
  `PaneView` 的 `PaneTree` 只保证 leaf↔split 切换时组子树不卸载，**跨组移动仍然换父节点**。
  修法是挂载时回放主进程环形缓冲（`terminal:recentOutput`，与 `MAX_OUTPUT_BUFFER` 同为 256KB）：
  **先订阅、再取缓冲**（取缓冲这段时间到达的输出先缓存、回放写完再冲出去；反过来接缝处会重复），
  回放走 `term.write` **绕过 zmodem**（传输会话不可能跨重挂载存活，把旧 ZMODEM 帧再喂给 Sentry
  只会伪造出一场传输）。取失败 / 会话已结束（返回 null）不是致命错误，直接进实时模式。
  代价（明确取舍）：重建的屏幕按新列宽重新折行，滚动位置与选区仍不保留。
  ⚠️ 别改成「把 xterm 实例提到跨组复用的缓存」——看着更彻底，但要把实例所有权从组件里挪出去，
  而 `dispose()` 现在有五六个入口（切标签 / 删会话 / 关组 / 卸载 / 组件重挂），漏一个就是泄漏；
  回放方案对**任何**未来新增的重挂载原因都生效，还顺带把「组件卸载期间主进程仍在产出」的输出找回来。
  验证：`scripts/verify-terminal-replay.mjs`。
- 验证：创建会话后调 `window.api.terminal.recentOutput(sessionId)` 应能看到 shell 提示符。

### 4.12 Mosh 会话：SSH 只做引导，终端数据走本地 mosh-client

主机表单勾选「使用 Mosh」（`SshProfile.useMosh`）后，`createFromProfile` 改走 `sessionManager.createMosh`
（`sessions.ts` 的 `MoshSession`），会话带 `SessionInfo.mosh = true` 供连接卡片区分文案（「启动 Mosh」/「Mosh（UDP）」）。

**引导链路**：ssh2 连接（复用 `sshConnectConfig`，与 SshSession 同一套参数）→ `exec('mosh-server new -s -c 256 -l LANG=C.UTF-8')`
→ 从 stdout 解析 `MOSH CONNECT <port> <key>`（`MOSH_CONNECT_RE`；20s 引导超时；mosh-server 打印后自行脱离，
exec 通道关闭不算失败）→ 本地 PTY 里拉 `mosh-client <host> <port>`（原生客户端经 `MOSH_KEY` 环境变量传密钥；
WSL 回退用 `wsl.exe -e env MOSH_KEY=... mosh-client ...` —— Windows 环境变量不会自动带进发行版）。
之后与 SSH 无关：断网 / 切网由 mosh 自己的 UDP 协议恢复，因此**没有** SshSession「断开重开会话」那套逻辑，
只有引导阶段的失败重试（`maxConnectAttempts = 3`，退避 600ms × 次数）。

- ⚠️ **SSH 引导连接特意保持不关**：`MoshSession.exec()` 复用它（mosh 协议没有 exec 通道），
  `ServerMonitor` 的周期采集就靠这条连接。UDP 漫游后它必然失效 —— 监控连续多次失败后自行停止，
  终端照常用。这是明确取舍，别为了「引导完就关」把监控弄死。
- **本地客户端探测**在 `services/terminal/mosh.ts`：PATH（where / which）→ MSYS2 / Cygwin / Homebrew /
  发行版常见路径 → Windows 无原生客户端时回退 WSL（`wsl.exe -e sh -lc 'command -v mosh-client'`，只认默认发行版）。
  命中结果缓存，「没找到」不长期缓存（装好不必重启，下次触发重扫）。渲染端查询走 `terminal:moshStatus`。
- **没有本地 mosh-client 时 `createMosh` 同步抛错**（消息带平台化安装指引），由调用方弹 message ——
  不建立远端连接、不留必然失败的标签页。渲染端两个入口已对齐（`app-store.ts` 的 reconnect 不再静默回退本地终端、
  命令面板 `connectHost` catch 后弹错误），新增连接入口别再想当然地 fallback。
- 远端没装 mosh-server 是引导失败最常见原因：`remoteMoshHint()` 识别 stderr 的 "not found" 附安装命令；
  防火墙需放行出站 **UDP 60000-61000**。
- ⚠️ **zmodem 过不了 mosh**：mosh 不是字节流透传，mosh-server 要维护终端状态再发差分
  （mobile-shell/mosh#1135），`sz` / `rz` 的裸二进制会被当控制序列处理。zmodem 通道只对 SSH / 本地会话有效。
- Windows 无原生 mosh 客户端（mosh.org 明确不提供；纯 JS 实现不存在），只能 MSYS2 / Cygwin / WSL。
  代码给 MSYS2 / Cygwin 版补了同目录 PATH（运行时 DLL 依赖），但 ConPTY 下表现与 WSL 回退的端到端连接
  **尚未实测**（开发机没装 mosh）—— 首次实测后更新本条。

### 4.13 主机日志：记录点在各业务服务，logger 只当汇聚层

「连不上 / 隧道断了 / 指纹变了」的第一现场。数据源是 `services/log/logger.ts` 的 `hostLogger` 单例：
内存环形缓冲（1000 条，`logs:list` 全量读）+ JSONL 落盘 `userData/logs/host.log`（启动回填尾部、
坏行跳过；超 2MB 滚动一代为 `host.log.1`）。落盘经 promise 链串行（滚动与追加不交错），
失败静默降级为仅内存 —— 日志绝不能拖垮业务。

- **记录点分散在各业务服务里**（刻意不做集中采集）：`ssh/connect.ts` 每跳 `[标签] 正在连接 / 已连接（Xms）/
  失败`（标签来自 `ConnectPurpose`：终端会话 / Mosh 引导 / SFTP / SSH 隧道 / 连接测试）+ TOFU
  `首次连接 …已记录主机指纹`；`terminal/sessions.ts` 会话就绪 / 关闭 / 断开（`logClosed` 幂等）/
  握手失败自动重试；`ssh/tunnels.ts` 启动中（带路由）/ 已启动 / 启动失败 / 已停止（`reason`，
  意外中断用 `level: 'error'`）/ 入站与 SOCKS5 转发失败；`sftp/sftp.ts` 三条失败路径 / 已连接 /
  已关闭 / 连接已断开；`ipc/hosts.ts` 指纹重置。新增事件时在**产生事件的业务服务里**调
  `hostLogger.<level>(scope, message)`，别在 IPC 层补。
- 作用域 `ssh` / `tunnel` / `sftp` / `terminal`，级别 `info` / `warn` / `error`，条目带自增 `seq`（类型在 `@shared/types`）。
- **终端命令 + 输出**由 `terminal/recording.ts` 的 `terminalRecorder` 记录进 `terminal` 作用域：`SessionManager`
  在写入真正送达后 `feedInput`、收到输出时 `feedOutput`、会话结束 `close`。命令重建是**尽力而为**——PTY 是
  裸字节流、没有 shell 集成：方向键 / Tab 补全 / 光标移动等无法跟进的转义序列会把当前行作废（宁缺毋错），
  换行仅在 bracketed paste 区间内视为行分隔；来源按写入方标记（键入 / `[AI] ` / `[脚本] `）。
- 输出以 800ms 节流 `hostLogger.update(seq, { detail })` 回填**同一条目**：同 seq 广播 = 覆盖更新 ——
  渲染端 store 按 seq 替换（`onEntry` 里别无条件 append），host.log 同 seq 多行后写为准（启动回填按 seq
  去重取末行）。清洗后为空（纯界面重绘）或与上次回填相同的内容**不重复 update**，防 host.log 被撑爆。
- 每会话另有逐字节原始记录文件 `userData/logs/sessions/<时间戳>-<标题>-<id8>.log`（首个输出块惰性创建、
  20MB 封顶；条目 detail 截 4000 字符并在超长时指回它，文件名进「会话结束：已记录 N 条命令」条目）。
  **条目宁缺、文件保底**：输出没有命令边界标记，块按到达时刻归属「进行中的命令」——作废行回车不抢占
  尚未收到任何输出的槽位；极速连发时输出可能整段落在相邻条目上，以原始文件为准。`logs:clear` 连
  `sessions/` 一起删。
- ⚠️ **`hostLogger.init()` 必须 await 完再 `registerIpc`**（`main/index.ts`）：`filePath` 在 init 里才赋值，
  且要先把历史回填进内存、把 `seq` 校准为文件最大值 —— 顺序反了，注册期事件既不落盘、还会插到历史前面。
- ⚠️ **`registerLogsIpc` 是 `registerIpc` 里的第一个**（`ipc/index.ts`）：`registerTunnelsIpc` 会同步触发
  隧道自启，注册期就有日志产生；订阅（`hostLogger.on('entry')` → 广播 `logs:entry`）必须早于任何会写日志
  的模块。注册期窗口还没创建、广播被静默丢弃没关系 —— 记录已在 logger 内存里，渲染端 bootstrap 的
  `logs:list` 兜住。
- 渲染端镜像封顶 `HOST_LOG_LIMIT = 1000`（与主进程同值）：bootstrap 灌全量 + `logs:entry` 实时追加；
  清空（`logs:clear`）同时清内存与文件，`seq` 继续递增不复用（列表 key 不撞车）。
- 面板（`features/logs/HostLogsPanel.tsx`）是**全局单例标签**（`id: 'logs'`）：工具栏含刷新 / 打开日志目录 /
  清空（Popconfirm），作用域过滤（Segmented）+ 关键字搜索。四个入口：命令面板 / 状态栏左下角菜单 /
  主机侧边栏标题栏图标 / 隧道页工具栏。
- 验证：`scripts/verify-host-logs.mjs`（见 5.2）—— 测试服务器故意拒绝 SFTP 子系统，专门走
  「失败也进日志」的路径。

### 4.14 平台探测：会话就绪后异步探一次，只记在会话上

「这台机器是 Windows 还是 Linux」由 `terminal/sessions.ts` 的 `SshSession.probePlatform()` 在
shell 就绪后异步执行（每次重连重新探测；Mosh 不探测 —— 其本身 Linux-only）：

- **探测顺序**：`cmd /c ver` → `/microsoft windows/i` ⇒ `windows`；否则 `uname -s` → `/linux/i` ⇒ `linux`、
  `/(darwin|bsd|sunos)/i` ⇒ `other`；两条都失败 / 超时（单条 4s，`execTimed`）⇒ 保持 `undefined`
  （旧行为：监控靠「无效结果」兜底，见 4.16）。
- **结果只写 `SessionInfo.platform`（会话级）**，不写进主机配置 —— 同一主机多会话各探各的；
  识别成功落一条 `hostLogger`（「已识别主机平台：Windows（user@host）」）。
- **下游消费者**：监控门控（4.16）、AI 的 `boundHint` 与 `list_terminal_sessions` 输出（`ai/terminal-tools.ts`）。
  Windows 的默认 shell 可能是 cmd 也可能是 PowerShell，所以 AI 提示按「平台」措辞而不是按标题猜。

### 4.15 每主机终端编码：只在 SshSession 边界转码，下游契约恒为 UTF-8

中文 Windows（GBK 代码页）的输出会乱码，而 SSH 传输的是裸字节。方案是**主机级开关 + 边界转码**：

- `SshProfile.terminalCharset: 'utf-8'（缺省）| 'gbk'`（主机对话框「终端编码」字段，仅 `kind === 'ssh'` 显示）。
  **不做自动探测** —— 手工切换是显式操作；探测错了是随机乱码，用户会以为是 bug。
- **转码只发生在 `SshSession`**（`terminal/sessions.ts`），渲染端与记录器契约一律 UTF-8：
  - 输出：stdout / stderr 各一份**有状态** `iconv.getDecoder`（多字节字符跨 chunk 不破），统一走 `emitOutput`：
    utf-8 原字节透传 `onData(buf)`；gbk 解码后重编码为 UTF-8 下发 `onData(utf8Buf, rawBuf)`。
  - `raw` 给 `SessionManager.handleData` 喂 `terminalRecorder`（`raw ?? data`）—— 原始会话日志保持
    **字节级保真**（4.13 的逐字节文件）。
  - 输入：`write()` 里字符串按会话字符集 `iconv.encode`；`Uint8Array` 直通（zmodem 二进制）。
  - `exec()`（监控 / 探测走它）：先整段累积 buffer、close 时一次性 decode —— 分块 decode 会把跨 chunk 的
    多字节字符切成两个替换符。
- **已知限制**（刻意不修，代码有注释）：非 UTF-8 会话里 zmodem 等二进制协议帧会被解码破坏 ——
  Windows 本就没有 sz/rz，UTF-8 会话不受影响。
- 依赖 `iconv-lite`（仅主进程）。

### 4.16 监控不支持态：非 Linux 是**明确终态**，不是静默停

监控采集依赖 Linux 的 `/proc` 与 `df`，Windows / BSD / macOS 永远采不到数据。旧行为是「采不到就不推」，
用户看到的是「监控条没了」而不是「为什么不支持」—— 现在做成显式状态：

- **判定**（`terminal/monitor.ts`）：平台已识别且 ≠ `linux` ⇒ 立即上报 `unsupported(platform)` 并自停；
  平台未知但连续 3 轮结果无效（`MAX_INVALID`）⇒ `unsupported('unavailable')`（覆盖探测失败的 Unix 系）；
  采集命令连续失败 15 次（`MAX_EXEC_FAILURES`）才停 —— 连接抖动要能自愈，不能一失败就判死。
- **链路**：`SessionMonitor('unsupported')` → `MonitorService`（转发 + 移除管理表）→ `ipc/monitor.ts`
  广播 `monitor:unsupported` → preload `monitor.onUnsupported` → store `monitorUnsupported[sessionId]` →
  状态栏 `MonitorBadge` 退化为「不支持监控」静态标识（带 Tooltip；仅当无新鲜指标时显示）。
- **清理时机**（store）：收到新鲜 `monitor:data`、`terminal:closed`、会话重连迁移 —— 三处都会清标记。
- 本地终端且本机非 Linux：`MonitorService.start` 直接静默跳过（不给徽标噪音）。
- 验证：`scripts/verify-windows-host.mjs`（Windows 会话 0 条 `monitor:data` + 恰好一次 `unsupported`）。
