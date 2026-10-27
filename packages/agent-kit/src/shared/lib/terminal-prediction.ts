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

// ---------------------------------------------------------------------------
// 命令行跟踪（带光标位置）
// ---------------------------------------------------------------------------

/**
 * 本地跟踪的一条命令行：**文本 + 光标偏移**。
 *
 * 为什么必须有光标：预测的历史是「用户敲的行首前缀」，而 shell 的行编辑允许把光标挪到
 * 中间改字。以前这里只存一段字符串，方向键一到就**整段清空**（当成不可跟踪的控制输入），
 * 于是「左移进 `docker ps` 中间 → 删掉一个字符 → 再敲回去」之后，缓冲里只剩下最后敲的
 * 那个字符 —— 预测拿着 `r` 去套历史，给出的当然是 `rm` / `rsync` 这类毫不相干的建议。
 * 跟踪光标之后，这一整类「在行中间编辑」的场景都能正确累积。
 */
export interface InputLine {
  /** 已敲入的整行文本（不含光标） */
  text: string
  /** 光标位置（0..text.length）。只在 `caret === text.length` 时才允许多行尾补全 */
  caret: number
}

/** 空行（清空跟踪时的唯一常量，避免各处新建对象） */
export const EMPTY_INPUT_LINE: InputLine = { text: '', caret: 0 }

/** 夹到 [0, text.length] */
function clampCaret(line: InputLine, caret: number): number {
  return Math.min(Math.max(caret, 0), line.text.length)
}

/**
 * 把一段输入事件套用到跟踪行上。返回 **null** = 这段输入无法在本地复现
 * （Ctrl 组合键、Tab、历史召回、粘贴里的换行…），调用方必须清空跟踪并收起建议。
 *
 * 只认**在提示符上编辑命令行**的那几个键：左右方向键、Home/End、退格、Delete、
 * 可打印文本。别的控制序列一律 null —— 宁可清空重来，也不要猜错（猜错的表现是
 * 预测拿一条根本不存在的行去套历史）。
 *
 * ⚠️ 方向键在**应用光标模式**下是 `\x1bOD` / `\x1bOC`（DECCKM，vim / tmux 会开）。
 * 两种写法都按同一次光标移动处理：行内编辑的语义没有区别。
 */
export function trackInputLine(line: InputLine, data: string): InputLine | null {
  // 光标移动：不改文本，只挪位置
  if (data === '\x1b[D' || data === '\x1bOD') {
    return { text: line.text, caret: clampCaret(line, line.caret - 1) }
  }
  if (data === '\x1b[C' || data === '\x1bOC') {
    return { text: line.text, caret: clampCaret(line, line.caret + 1) }
  }
  // 行首 / 行尾：Home = \x1b[H / \x1b[1~ / Ctrl+A，End = \x1b[F / \x1b[4~ / Ctrl+E
  if (data === '\x1b[H' || data === '\x1b[1~' || data === '\x01') {
    return { text: line.text, caret: 0 }
  }
  if (data === '\x1b[F' || data === '\x1b[4~' || data === '\x05') {
    return { text: line.text, caret: line.text.length }
  }
  // 退格：删光标**前**一个字符
  if (data === '\x7f' || data === '\x08') {
    if (line.caret === 0) return line
    const text = line.text.slice(0, line.caret - 1) + line.text.slice(line.caret)
    return { text, caret: line.caret - 1 }
  }
  // Delete（\x1b[3~）：删光标**处**那个字符
  if (data === '\x1b[3~') {
    if (line.caret >= line.text.length) return line
    const text = line.text.slice(0, line.caret) + line.text.slice(line.caret + 1)
    return { text, caret: line.caret }
  }
  // 可打印文本：插在光标处（粘贴一段也照此处理）
  if (isTrackableInput(data)) {
    const text = line.text.slice(0, line.caret) + data + line.text.slice(line.caret)
    return { text, caret: line.caret + data.length }
  }
  return null
}

