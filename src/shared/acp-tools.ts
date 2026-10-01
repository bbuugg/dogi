/**
 * ACP（外部 agent：codex / gemini / opencode …）工具相关的**纯类型 / 纯逻辑**，
 * 主进程（组装 part：`acp-history.ts` / `acp-agent.ts`）与渲染端（展示：`ToolCallRow`）共用。
 *
 * 为什么放 shared：「工具名怎么定」这个问题，组装 part 的主进程和负责展示的渲染端必须判成
 * 同一个结果 —— 两边各存一张表一定会漂。口径对齐 fishwork 的
 * `packages/acp/src/acp.ts`（取值）与 `lib/parts.ts`（翻中文名）。
 */

/**
 * ACP 协议里的工具种类（`tool_call.kind`）→ 中文名。
 *
 * 与内置工具名（`read_file` / `execute_command` …）分开：这些是 ACP 协议枚举，
 * 混进内置那张表会被误命中（内置名见 ToolCallRow 的 `TOOL_LABELS`）。
 */
export const ACP_KIND_LABELS: Record<string, string> = {
  read: '读取',
  edit: '编辑文件',
  delete: '删除文件',
  move: '移动文件',
  search: '搜索',
  execute: '执行命令',
  think: '思考',
  fetch: '抓取网页',
  switch_mode: '切换模式',
  other: '工具调用',
  tool: '工具调用'
}

/**
 * ACP agent 没给 `name` 时的占位工具名。
 *
 * 它的语义正是「这次没有工具名，翻名字请去看 `kind`」—— 所以各处拿它当「还没有真名」的
 * 哨兵（<｜hy_place▁holder▁no▁813｜>端据此改用 `acpKind` 翻中文名）。详见 ToolCallRow 的 `toolCardTitle`。
 */
export const ACP_UNNAMED_TOOL = 'tool'

/**
 * 从 ACP update 上取工具名：**只认协议里的 `name`，绝不拿 `title` 兜底**。
 *
 * ⚠️ `title` 是给人看的自然语言描述，不同 agent 往里塞的东西完全不同 ——
 * 有时是「Bash: npm test」这种带前缀的描述，claude-code 这类甚至直接把整段脚本 / 命令塞进去，
 * 还有的干脆塞一条文件路经。拿它当工具名，消息列表里的标题就会变成一串命令 / 路经
 * （用户反馈的「工具名位置显示成文件路经」）。
 *
 * 没有 `name` 就返回占位名；真正的中文名由 `kind` 翻出来，`title` 另作「工具名后面的明细」。
 */
export function acpToolName(name: unknown): string {
  return typeof name === 'string' && name ? name : ACP_UNNAMED_TOOL
}

/** 从 ACP update 上取工具种类（协议里的 `kind`）；缺失 / 非字符串则返回 undefined */
export function acpToolKind(kind: unknown): string | undefined {
  return typeof kind === 'string' && kind ? kind : undefined
}

/**
 * 从一条 ACP update 上取 `kind`（工具种类）。
 *
 * `@agentclientprotocol/sdk` 的 `SessionUpdate` 没把 `kind` 声明到 `tool_call` 上，
 * 但 ACP agent 普遍会发、且协议里本来就有 —— fishwork 也是绕开类型抳的
 * （`typeof update.kind === 'string' ? update.kind : undefined`）。
 * 它是「agent 没给 name 时唯一能翻出中文工具名」的线索，这条链路不能断。
 */
export function acpToolKindOf(update: unknown): string | undefined {
  return acpToolKind((update as { kind?: unknown }).kind)
}

/** 展示用标题：空串 / 缺失时不给，免得多出一行空标题 */
export function acpToolTitle(title: unknown): string | undefined {
  return typeof title === 'string' && title ? title : undefined
}
