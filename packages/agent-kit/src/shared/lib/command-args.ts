/**
 * 命令行参数解析：把设置页输入框里的一行文本拆成 argv 数组。
 *
 * 为什么不直接 `split(/\s+/)`：用户几乎总是从 MCP 文档 / Claude Desktop 的 JSON 配置里
 * 复制命令行，那里带引号和逗号（`"-y", "@playwright/mcp", "--headless"`）。
 * 按空格硬切会把引号和逗号留在 token 里，npx 收到包名 `"-y",` 会报
 * EINVALIDTAGNAME 直接退出 —— 用户看到的只有 `Connection closed`，很难查。
 *
 * 认得两种写法：
 * - 空格分隔：`npx -y @playwright/mcp --headless`
 * - JSON 数组：`["-y", "@playwright/mcp", "--headless"]`
 *
 * 引号内的空格算一个 token 的内部（`--root "C:\Program Files\x"`），
 * 输出时该补引号的补上（见 `formatCommandArgs`，编辑回填要靠它还原）。
 */

/**
 * 把一行命令参数文本拆成 argv 数组。
 *
 * 引号只用于分组、不保留在结果里；裸逗号视为分隔符尾（JSON 复制进来的痕迹）。
 */
export function parseCommandArgs(input: string): string[] {
  let text = input.trim()
  // 整段是 JSON 数组写法：先摘掉括号，剩下的交给同一套词法分析
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1).trim()
  if (!text) return []

  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (const ch of text) {
    if (quote) {
      // 引号内：另一个引号是分组结束（`""` 单独成 token 时也不是转义，直接闭合）
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) args.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) args.push(current)

  // 去掉 JSON 复制带进来的尾逗号：`"-y", "@playwright/mcp",` → `-y` / `@playwright/mcp`
  return args.map((a) => a.replace(/,+$/, '')).filter(Boolean)
}

/**
 * 把 argv 数组拼回一行文本（编辑时回填输入框）。
 *
 * 与 `parseCommandArgs` 互逆：token 里有空格 / 引号时补引号，
 * 这样「打开编辑 → 原样看到自己填的 → 改一个字保存」不会把参数改坏。
 */
export function formatCommandArgs(args: string[]): string {
  return args
    .map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')
}