# 踩坑库 · 主进程与生命周期

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

### 6.4 主进程与生命周期

**12. `did-finish-load` 里 `setZoomFactor` 会让隐藏窗口永不显示**

- 现象：构建后（`electron .` 加载 `out/renderer`）进程在任务管理器里活着但窗口不出现；dev（`VITE_DEV_SERVER_URL`）一切正常。
- 根因：窗口是 `show: false` + `ready-to-show` 才 `show()`；`file://` + 隐藏窗口下，zoom 变更触发的重布局让首帧永不产出
  → `ready-to-show` 不触发。dev 走 `loadURL(http)`，有 HMR 等后续活动补触发首帧，掩盖了问题。
- 正确做法：zoom 复位只放在 ① 窗口创建后（loadFile 之前）；② `ready-to-show` 里 `show()` 之后；
  ③ `did-finish-load` 里**仅当 `mainWindow.isVisible()`** 时（reload 场景）。见 `main/index.ts`。
- 排查技巧：这种「进程在、无窗口」的问题主进程 stderr 往往完全干净 —— 给 main 加 `console.error` 打事件时序最快。

**13. spawn 外部 GUI 程序时 `windowsHide: true` 会隐藏窗口**

- `windowsHide: true` 会设 `STARTF_USESHOWWINDOW | SW_HIDE`，explorer.exe 等 GUI 程序**继承该标志**，
  spawn 成功但窗口被隐藏（无任何报错）。
- 正确做法：只用 `{ detached: true, stdio: 'ignore' }` + `unref()`。见 `services/system/opener.ts` 的 `launch`。

**14. zustand create 工厂内引用自身变量会 TDZ 崩溃**

- 在 `create()((set, get) => { … useAppStore … })` 里读 store 变量 → `ReferenceError`，整棵 React 树卸载。
- 需要在模块作用域暴露 store（如调试 `window.__store`）时，写在 `create(...)` 赋值语句**之后**。

**15. pty 输出早于渲染端订阅的丢失风险**

- 渲染端在 React mount 后才订阅 `terminal:data`，shell 启动横幅若早于订阅会丢（PowerShell 启动慢，实测未观察到；SSH 快速 banner 有此风险）。
- 如需彻底修复：挂载后先调 `terminal:recentOutput` 回放缓冲，再订阅实时事件。

**16. 其他主进程约束**

- **单实例锁**：**所有形态都生效**，任何时候只允许打开一个 Dogi —— 已有实例在跑时新进程直接退出，并把已有实例调到前台。锁由 Electron 按 userData 目录互斥。
  ⚠️ dev 与打包版的 userData **是同一个**（`%APPDATA%\dogi` —— package.json 没有顶层 `productName`，Electron 拿 `name` 当目录名），所以常驻打包版在跑时直接 `electron .` 会被锁挡下 `app.quit()`。**不要按环境放行锁**，需要并存就起 `--user-data-dir=<临时目录>` 的隔离实例（见 5.1）。
- **托盘**：关闭窗口默认隐藏到托盘（`preferences.minimizeToTray`），`before-quit` 才置 `isQuiting` 让窗口真关。
  退出时 `will-quit` 要 `tray.destroy()`，否则托盘图标残留。
- **菜单**：自定义菜单刻意**去掉 zoom 角色**，否则 Ctrl +/-/0 会缩放整个页面并抢在渲染端之前触发；
  Reload / Force Reload **不注册加速键**（Ctrl+R 必须透传给终端：vim 的 redo、readline 反向搜索都靠它）；
  F5 在 `before-input-event` 里拦掉（会毁掉终端会话）。
- **凭据只在主进程解密**：`storage.getSshProfile` 返回明文，渲染端永远拿不到；列表接口只给 `hasPassword` 这类脱敏标记。⚠️ RDP 是刻意的例外：NLA / CredSSP 票据必须在渲染进程算，仅连接时经 `rdp:credentials` 单次下发（见 4.17）。

**17. BoringSSL 会拒绝「缺 digitalSignature 用途位」的服务器证书 —— OpenSSL / SChannel 不查这一位**

- **触发信号**：RDP 连接报「接入握手失败：received an RDCleanPath error: general error (code 1); HTTP 502
  bad gateway」时别只信错误码 —— 换个客户端（mstsc / 纯 Node）连同一台服务器往往正常。
- **根因**：Electron 主进程里的 Node 用 **BoringSSL**（`process.versions.openssl` 报 `0.0.0`），客户端会校验
  服务器证书 keyUsage 与协商套件的一致性：证书没有 `digitalSignature` 位时，一切靠证书签名的套件（全部
  TLS 1.3、全部 ECDHE）都被 `KEY_USAGE_BIT_INCORRECT` 掐断；云镜像工具生成的自签证书经常只带
  `keyEncipherment`。OpenSSL / SChannel / rustls 都不做这个检查 —— 「只有我们的桥连不上」的经典现场。
  （RDCleanPath 把一切握手失败统一归成错误 PDU 1/502，真实原因只在主机日志。）
- **正确做法**：识别该错误后自动降级 **TLS 1.2 + 静态 RSA 密钥交换套件**重试一次（证书此时用于加密而非
  签名，语义合法），成功与失败都写主机日志。⚠️ 套件清单必须写 **OpenSSL 风格名**（`AES256-GCM-SHA384`…）
  —— BoringSSL 不认 IANA 全名（`TLS_RSA_WITH_*` 解析成空列表 → `NO_CIPHERS_AVAILABLE`）；也别因
  `tls.getCiphers()` 里看不到 `TLS_RSA_*` 就以为静态 RSA 不可用（实测可协商）。
- **验证**：`scripts/verify-rdp-bridge.mjs` 坏 keyUsage 假服务器场景（默认握手被拒 → 降级成功 → 对端恰两次
  连接 → 日志有告警与成功留痕）。
