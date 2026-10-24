/**
 * 终端命令预测的建议引擎：输入缓冲 → 建议清单（纯函数，无 IO）。
 *
 * 数据源是两路合并：项目命令历史（`lib/terminal-history.ts`，跨会话共享、落
 * `<项目>/.fizz/terminal-history.json`）+ 一份常见命令词表（没历史也能给建议）。
 * 匹配规则与 dogi 的 TerminalView 同款：
 * - 整行前缀匹配（含 `git pu` → `git push` 这类子命令补全）；
 * - 只输入了首个词时，再按首词前缀补一轮（`git` → `grep` 这种词表补充）；
 * - 排序：历史更近的优先（历史在前 = 更常用），其次按长度升序，取前 8 条。
 */

/** 常见命令词表：即使没有任何历史也能给出首词补全建议 */
export const COMMON_COMMANDS = [
  'ls', 'll', 'la', 'pwd', 'cd', 'clear', 'echo', 'cat', 'less', 'more', 'head', 'tail',
  'grep', 'find', 'which', 'where', 'wc', 'sort', 'uniq', 'awk', 'sed', 'cut', 'tr',
  'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'ln', 'chmod', 'chown', 'df', 'du',
  'ps', 'top', 'htop', 'kill', 'pkill', 'jobs', 'bg', 'fg', 'nohup', 'screen', 'tmux',
  'git', 'git status', 'git log', 'git diff', 'git add', 'git commit', 'git push', 'git pull', 'git checkout', 'git branch', 'git clone', 'git stash',
  'npm run dev', 'npm run build', 'npm install', 'npm test', 'npx tsc',
  'docker', 'docker ps', 'docker compose', 'docker logs', 'kubectl', 'helm',
  'ssh', 'scp', 'rsync', 'curl', 'wget', 'ping', 'netstat', 'ipconfig', 'tasklist',
  'vim', 'nvim', 'nano', 'code',
  'sudo', 'whoami', 'uname', 'date', 'env', 'export', 'source',
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'pip', 'go', 'cargo',
  'systemctl', 'journalctl', 'crontab',
  'tar', 'zip', 'unzip', 'gzip',
  'history', 'alias', 'type', 'man', 'help', 'exit'
]

/** 下拉里最多展示的建议条数 */
export const SUGGESTION_LIMIT = 8

/**
 * 算一批建议（已截到 SUGGESTION_LIMIT）。
 *
 * `input` 是当前命令行的 trimEnd 结果；`historyCmds` 是项目历史（最新在前）。
 */
export function computeSuggestions(input: string, historyCmds: string[]): string[] {
  if (!input) return []
  const tokens = input.split(/\s+/)
  const firstTokenOnly = tokens.length === 1
  const items: string[] = []
  const seen = new Set<string>()
  const pool = [...historyCmds, ...COMMON_COMMANDS]
  for (const cmd of pool) {
    if (!cmd || cmd.length <= input.length) continue
    // 整行前缀匹配（含子命令补全，来自历史或常见命令）
    if (cmd.startsWith(input)) {
      if (!seen.has(cmd)) {
        seen.add(cmd)
        items.push(cmd)
      }
      continue
    }
    // 仅输入首个词时，按首词前缀补充更多命令
    if (firstTokenOnly) {
      const head = cmd.split(/\s+/)[0]
      if (head.startsWith(tokens[0]) && head.length > tokens[0].length && !seen.has(head)) {
        seen.add(head)
        items.push(head)
      }
    }
  }
  // 排序：历史更近的优先，其次按长度升序
  items.sort((a, b) => {
    const ia = historyCmds.indexOf(a)
    const ib = historyCmds.indexOf(b)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return a.length - b.length
  })
  return items.slice(0, SUGGESTION_LIMIT)
}

/**
 * 这段输入是否是「纯可打印文本」（可以当作命令行内容来跟踪）。
 *
 * 任何控制字符（Ctrl+A/B/E/R/U/K… 组合键、Tab、方向键 / F 键的 ESC 序列、DEL、
 * 可能带换行的粘贴）都意味着本地缓冲与 shell 真实命令行已经对不上 —— 这时调用方
 * 必须重置缓冲并收起建议，否则组合键之后预测会乱套。
 */
export function isTrackableInput(data: string): boolean {
  return data.length > 0 && !/[\u0000-\u001f\u007f]/.test(data)
}
