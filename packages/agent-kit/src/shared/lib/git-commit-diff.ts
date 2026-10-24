/**
 * 「一次提交」diff 的客户端解析（**纯函数，零依赖** —— 单测直接 jiti 跑，不拉起 React）。
 *
 * ⚠️ 这个文件跑在浏览器里，**别从 `@fizz/git` 运行时导入任何东西**（`import type` 没事）：
 * 那个包的 index 会带出 git-panel.ts —— 它 import simple-git、模块顶层还写 process.env，
 * 进了浏览器 bundle 就是一声 `ReferenceError: process is not defined`（130655c 踩过）。
 * 服务端/浏览器两边都要用的纯函数，放这里或 contracts，服务端从自己那边引。
 *
 * 独立成 `lib/` 而不是塞在 `GitHistory.tsx` 里：那个文件引 react / lucide，
 * 单测要陪它加载整棵 UI 树。而这里两个函数值得被单测钉住：
 * 多文件切分错了，用户看到的 diff 就是「后一个文件的行接在前一个文件后面」。
 */
import type { DiffHunk } from '@fizz/agent-kit/shared/lib/diff'

/** unified diff 里切分文件的边界行（`diff --git a/x b/x`） */
const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/

/** hunk 头（`@@ -1,5 +1,7 @@`）—— 与 `parseUnifiedDiff` 的正则逐字一致，别只改一边 */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * 把一段（可能是**多个文件**的）unified diff 按文件切开。
 *
 * ⚠️ 不能直接 `parseUnifiedDiff(整段)`：它只认 `@@` 行，多文件的 hunk 会被**扁平成
 * 一个数组**，行与行的文件归属全丢 —— 而 commit 的 diff 几乎总是多文件的。
 *
 * 返回顺序按 diff 里出现的次序（与 `--numstat` 的文件顺序无关），调用方逐段喂给
 * `FileDiffView`：它自带文件头和增删计数，正好一段一个。
 *
 * ⚠️ `let current` 要能跨循环体赋值：写成「初始化为 null + 闭包 helper 里赋值」的
 * 话，TS 的控制流分析解除不了 null 窄化，每个 `current.hunks` 都会报 `never`。
 */
export function splitDiffByFile(diff: string): { path: string; hunks: DiffHunk[] }[] {
  const out: { path: string; hunks: DiffHunk[] }[] = []
  let current: { path: string; hunks: DiffHunk[] } | undefined
  for (const line of diff.split('\n')) {
    const header = FILE_HEADER.exec(line)
    if (header) {
      // `b/<path>` 是新路径（重命名时 `a/` 是旧名）；带引号的路径原样留着，这里不解析它
      current = { path: header[2] ?? header[1] ?? '', hunks: [] }
      out.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) {
      const m = HUNK_HEADER.exec(line)
      current.hunks.push({
        header: line,
        lines: [],
        oldStart: m ? Number(m[1]) : undefined,
        newStart: m ? Number(m[2]) : undefined
      })
      continue
    }
    const last = current.hunks[current.hunks.length - 1]
    if (!last) continue
    if (line.startsWith('+')) last.lines.push({ type: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) last.lines.push({ type: 'del', text: line.slice(1) })
    else if (line.startsWith(' ')) last.lines.push({ type: 'context', text: line.slice(1) })
    // `\ No newline at end of file` 等元信息忽略（parseUnifiedDiff 同样忽略）
  }
  // 一个 hunk 都没有的段（纯 mode 变更 / 空文件）不留：渲染出来是个空壳文件头
  return out.filter((seg) => seg.hunks.length > 0)
}
