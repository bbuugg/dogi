/**
 * 「用本应用打开系统里的 `.md`」：外部文件的收集与分发（主进程侧）。
 *
 * ## 三路入口，一条代码路径
 *
 * 1. **首实例**：双击关联时 Windows / Linux 把文件路径放进 `process.argv`
 *    （`deliverStartupArgs()`，在 `whenReady` 之后读）；
 * 2. **二实例**：应用已在跑，用户又双击一个文件 → `second-instance` 的**第二个参数**带 argv。
 *    ⚠️ `index.ts` 里原来那个监听只调了 `showMainWindow()`、**完全不读 argv** ——
 *    照那样写窗口是拉起来了，但文件被静默丢掉，看起来就是「双击没反应」；
 * 3. **macOS**：`app.on('open-file')`。它**可能早于 `whenReady` 触发**，所以必须在模块求值期
 *    就把监听挂上（`initExternalFiles` 在 `index.ts` 的模块顶层被调用，不是放在 ready 回调里）。
 *
 * ## 先存后取（这个坑仓库里踩过一次）
 *
 * 系统事件可能在渲染端挂上监听**之前**就发完 —— 事件直接丢，症状是「有时灵」，最难查。
 * `@fizz/agent-kit` 的 `features/files/open-file.ts` 文件头为同一个坑写过长注释。
 *
 * 所以这里**一律先存进 `pending`**，再广播；渲染端启动时用 `takePendingExternalFiles()`
 * 拉一次存量，之后才靠订阅接增量。广播发丢了也不要紧 —— 条目还在队列里，
 * 窗口重建时渲染端重新挂载会再取一次。
 *
 * ## 授权
 *
 * 入队之前**必过 `allowLocalDocument`**（`@fizz/agent-host` 的路径闸）。这是唯一一处
 * 让系统交来的路径进入白名单的地方，别在别处绕过它。
 */
import { app, type BrowserWindow } from 'electron'
import { statSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { allowLocalDocument, promptLocalMarkdownFile } from '@fizz/agent-host'
import { WINDOW_IPC } from '../shared/window'

/** 认得的 markdown 扩展名（与 agent-host 的路径闸同一份口径） */
const MARKDOWN_EXTS = new Set(['.md', '.markdown'])

/** 待渲染端取走的外部文件（`allowLocalDocument` 规范化过的绝对路径） */
const pending: string[] = []

let broadcast: ((channel: string, payload: unknown) => void) | null = null
let getWindow: (() => BrowserWindow | null) | null = null

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 从一段 argv 里挑出「用本应用打开的 markdown 文件」（已过闸、已去重）。
 *
 * 三条过滤规则各自挡一类垃圾：
 * - `-` 开头 = Electron / Chromium 的开关（`--inspect`、`--remote-debugging-port`…），不是路径；
 * - 不是绝对路径 = **dev 模式下 argv 里的 app 目录**（`apps/desktop` 之类）以及各种相对参数；
 * - 不是 markdown 扩展名 / 不是一个真实存在的文件 = 剩下的噪声。
 *
 * ⚠️ 顺序要紧：**先 `statSync` 确认是真文件，再 `allowLocalDocument`**。反过来的话，
 * 一条不存在的路径会先被记进白名单 —— 闸里就多了一条指向未知目标的条目。
 */
export function collectMarkdownPaths(argv: readonly string[]): string[] {
  const found = new Set<string>()
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue
    if (!isAbsolute(arg)) continue
    if (!MARKDOWN_EXTS.has(extname(arg).toLowerCase())) continue
    if (!isExistingFile(arg)) continue
    const allowed = allowLocalDocument(arg)
    if (allowed) found.add(allowed)
  }
  return [...found]
}

/** 入队 + 广播（同一批次里重复的不再报一次） */
function deliver(paths: string[]): void {
  for (const path of paths) {
    if (pending.includes(path)) continue
    pending.push(path)
    broadcast?.(WINDOW_IPC.externalFileOpen, path)
  }
}

/**
 * 取走待处理队列并清空 —— 渲染端启动时调一次（「先存后取」的取）。
 *
 * 取完才广播增量，所以不存在「同一个文件既被 take 到、又被事件推一次」的重复：
 * 时间上晚于 take 的事件才会进队列。
 */
export function takePendingExternalFiles(): string[] {
  const out = [...pending]
  pending.length = 0
  return out
}

/**
 * 挂上三路入口。
 *
 * ⚠️ **必须在 `whenReady` 之前调用**（见文件头第 3 条）—— 调用点在 `index.ts` 的模块顶层。
 */
export function initExternalFiles(options: {
  broadcast: (channel: string, payload: unknown) => void
  getWindow: () => BrowserWindow | null
}): void {
  broadcast = options.broadcast
  getWindow = options.getWindow

  // macOS：Finder 双击 / 拖到 Dock 图标。`preventDefault` 是文档要求的
  //（不调的话 Electron 会按默认行为处理，而默认行为就是什么都不做）
  app.on('open-file', (event, path) => {
    event.preventDefault()
    deliver(collectMarkdownPaths([path]))
  })

  // 二实例：见文件头第 2 条（必须读 argv，不能只拉窗口）
  app.on('second-instance', (_event, argv) => {
    deliver(collectMarkdownPaths(argv))
  })
}

/** 首实例启动时读一次 `process.argv`（在 `whenReady` 里调） */
export function deliverStartupArgs(): void {
  deliver(collectMarkdownPaths(process.argv))
}

/**
 * 菜单「文件 → 打开 Markdown…」/ `Ctrl(Cmd)+O` 的动作。
 *
 * 与双击关联**走同一条出口**（选完照样过闸、入队、广播），所以渲染端只有一条处理路径，
 * 不必为「菜单打开的」和「系统交来的」写两套。
 */
export async function openMarkdownDocument(): Promise<void> {
  const picked = await promptLocalMarkdownFile(getWindow?.() ?? null)
  if (picked) deliver([picked])
}
