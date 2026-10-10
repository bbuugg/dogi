# 关键机制 · 接口调试

> 本文件是 Dogi 根 `AGENTS.md` 的分册，**条目编号沿用原文档**（4.x / 6.x），
> 所以正文里「见 4.24」「AGENTS.md 6.2 第 9 条」这类交叉引用仍然有效，
> 只是承载位置从根文件搬到了这里。
> 改动对应模块前先读本文件；根 `AGENTS.md` 只有索引与全局硬约束。

---

### 4.19 接口调试的请求体四形态：none / raw / x-www-form-urlencoded / form-data

- 类型在 `@shared/types` 的 `ApiBodyType`；界面上是**横向分段**（antd `Segmented`，≈ 横向 radio，
  与主机类型 / 隧道类型同款，**不带描述文案**）。请求条目上是 `bodyType`
  （**缺省 = raw**，兼容历史数据；`none` 是显式选择，不是缺省），
  两种表单**各存一张表**（`bodyUrlencoded` / `bodyFormFields`）—— 来回切模式不会把另一种填好的内容冲掉。
- `none` = **不携带请求体**：主进程 `prepareBody` 直接返回空（body 与 Content-Type 都不碰），
  渲染端切换时也**不动**请求头里的 Content-Type —— 没有正文就没有「对不上」的问题，
  用户自己填的头原样保留。GET / HEAD 本来就不带 body（老行为，别顺手「修」）。
- **Content-Type 谁说了算**：切模式时渲染端把请求头那一行一起换掉（`setContentType`：没填、
  或填的还是另一类表单才覆盖；用户自己写的比如带 charset 的 urlencoded 不动）；
  切回 raw 时表单类换成 `application/json`。发送时主进程再兜一层：
  urlencoded **只在没有** Content-Type 时补标准的那个；form-data **一律删掉**请求头里那份 ——
  它没有 boundary，留着服务端按它解析会把整个 body 当垃圾（boundary 只能由运行时生成）。
- **文件字段**：`ApiFormField.isFile` + `value` = **本地绝对路径**，主进程 `prepareBody` 读文件塞进
  `FormData`（MIME 按扩展名给，认不出的用 application/octet-stream；filename 取路径末段）。
  form-data 表格的列序是**字段名 → 类型（文本 / 文件）→ 值**：先决定这行是什么，再看/填值；
  选「文件」时值那一格变成只读文件名 + 「选择文件」按钮。
  选文件走 `api:pickFile`（主进程弹对话框 + stat 出名字与大小）—— **渲染端只拿路径**，
  不把文件内容搬进内存再走 IPC。文件没选 / 读不到 → `status=0 + error` 且**根本不发包**。
  ⚠️ 原生对话框无法自动化：探针用 `DOGI_API_PICK_FILE` 旁路（同 sftp:uploadDir 的约定），正常运行不设。
- **GET / HEAD 允许携带请求体**：四种形态都可带。Node 全局 `fetch` 的 Request 构造会拒绝
  GET/HEAD 带 body（抛 “Request with GET/HEAD method cannot have body”），所以这条支路由
  `undici.request`（更底层，不强制该限制）发出，逻辑在 `src/main/services/api/http.ts` 的 `executeHttp`。
  ⚠️ 别为了「统一」把它塞回 `fetch`——那样 GET/HEAD 带 body 又会整条失败（status=0 + 该报错）。
- cURL 导入：`-F`（含 `@文件`）映射成 form-data 字段；不再拼成 `a=b&c=d` 文本配一个没有 boundary 的
  multipart 头（那样服务端根本解析不了）。`-d` 仍是 raw 文本。
- 加字段/加形态时**整条链路一起对齐**（落盘、历史、草稿种子、transfer 的 `apiOut` 白名单），
  少一处就是「保存后形态变回 raw」或「导出后请求体空掉」。
- 验证：`scripts/verify-api-body-types.mjs`（主进程真源码 + 进程内 HTTP 服务器，逐字节比对文件内容）、
  `scripts/verify-api-body-ui.mjs`（真界面点选 / 填表 / 选本地文件 / 发送 / 落盘回读）。
