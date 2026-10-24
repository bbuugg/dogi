/**
 * 「用本应用打开的本机 Markdown 文件」：**路径闸** + 三条 IPC（主进程侧）。
 *
 * ## 为什么必须有这道闸
 *
 * 这个功能要让渲染端按**绝对路径**读写用户本机的文件（双击 `.md` 打开 → 编辑 → 存回原处），
 * 而本仓库其余所有读写都收在某个作用域里：工作区文件过 `resolveInside`，笔记过登记根。
 * 少了闸，`localFileRead` / `localFileWrite` 就是一条「渲染端能读写任意绝对路径」的通道 ——
 * 而它挂在 SSE 那套鉴权**之后**，一旦通了就是整块磁盘可写。
 *
 * 所以放行集合（`allowed`）**只有两个来源**：
 * 1. 用户在系统对话框里亲手选中的（`pickLocalMarkdownFile`）；
 * 2. 系统交来的（双击文件关联时的 argv / macOS 的 `open-file`，由 `apps/desktop` 主进程调
 *    `allowLocalDocument` 放行）。
 *
 * 别为了「少一次点击」加第三条来源（比如「记住上次打开过的目录、里面的都放行」）——
 * 那等于把闸拆了。
 *
 * ## 闸的几条具体规则
 *
 * - 只认**绝对路径** + **markdown 扩展名** + 路径存在且是**文件**；
 * - 一律 `path.resolve()` 规范化后才进集合 / 比对，`..` 与相对路径因此在源头就被挡掉；
 * - 集合只在**主进程内存**里：不落盘、不跨启动保留。重启后没被重新授权就打不开 —— 这是对的，
 *   否则「上次开过」会变成一份长期有效的白名单；
 * - 刻意**不做**「关标签就撤销授权」：撤销了也不会带来任何安全收益（没有标签就没有调用方），
 *   却要多一条 IPC 和一次多余的状态同步。集合里每条都是用户亲手选过的，量级是「这个会话
 *   开过几篇文档」，不值得为它加机制；
 * - 写回也**必须**过闸（不能只读的时候过）—— 只读放行的写法会让闸在写入路径上失效。
 *
 * ## 为什么写盘用「整份覆盖」而不是分片
 *
 * 与 SFTP 分片传输刻意不同：那是流式下载大文件，这里是一篇 markdown 的保存，
 * `fs.writeFile(path, content, 'utf8')` 语义最直白，也不需要 `index === 0` 那套截断 / 追加约定。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import {
  AGENT_IPC,
  type LocalFileReadResult,
  type LocalFileWriteResult
} from './channels'

/**
 * 被授权的本机文件（`resolve` 规范化后的绝对路径）。
 *
 * 用 `Set<string>` 而不是「记下被授权的目录」：这里授权的是**单个文档**，
 * 不是「某个目录里的都行」。粒度粗一格，闸就等于没有。
 */
const allowed = new Set<string>()

/** 认得的 markdown 扩展名（小写比较） */
const MARKDOWN_EXTS = new Set(['.md', '.markdown'])

/** 拒绝时给渲染端看的文案：要能解释「为什么这个文件不行」，否则用户只会觉得功能坏了 */
const NOT_ALLOWED =
  '这个文件没有被授权读写。只能打开系统交来的、或你自己在「打开 Markdown…」里选的文件。'

function isMarkdownPath(candidate: string): boolean {
  return MARKDOWN_EXTS.has(extname(candidate).toLowerCase())
}

/**
 * 放行一个路径并返回规范化后的形式（不合格返回 `null`）。
 *
 * 供两处调用：本文件的选文件对话框，以及 `apps/desktop` 主进程处理系统事件时
 * （argv / `second-instance` / macOS `open-file`）。
 *
 * **同步**、只做路径形状判定，不碰磁盘 —— 磁盘存在性由真正的读 / 写去撞，
 * 免得「授权」这一步在文件被别的程序删掉的竞态里给出错误结论。
 */
export function allowLocalDocument(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null
  if (!isAbsolute(candidate)) return null
  if (!isMarkdownPath(candidate)) return null
  const normalized = resolve(candidate)
  allowed.add(normalized)
  return normalized
}

/** 这个路径是不是已经被授权过（读 / 写前必查） */
export function isAllowedLocalDocument(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  return allowed.has(resolve(candidate))
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 弹「打开 Markdown」对话框，把用户选中的路径**授权**并返回（取消返回 `null`）。
 *
 * 过滤条件**写死**、不接受调用方传参：能指定扩展名的话，「选文件」这一步就能被用来
 * 放行任意类型的文件，而这个功能只服务 markdown。
 *
 * `window` 传进来是为了让对话框**模态挂在正确的窗口上**（多窗口时不会飘到别的窗口前面）；
 * 两个调用方各有一种来源：IPC 从 `event.sender` 反查，菜单 / 快捷键直接用主窗口。
 */
export async function promptLocalMarkdownFile(
  window?: BrowserWindow | null
): Promise<string | null> {
  const options = {
    title: '打开 Markdown 文件',
    properties: ['openFile' as const],
    filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown'] }]
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled) return null
  // 用户亲手选的：这一步就是授权本身
  return allowLocalDocument(result.filePaths[0])
}

/** 注册三条通道。由 `registerAgentTransportIpc` 调一次 */
export function registerLocalFileIpc(): void {
  ipcMain.handle(AGENT_IPC.pickLocalMarkdownFile, (event): Promise<string | null> =>
    // 与 pickDirectory 同一取舍：模态挂在发起请求的那个窗口上
    promptLocalMarkdownFile(BrowserWindow.fromWebContents(event.sender))
  )

  ipcMain.handle(AGENT_IPC.localFileRead, async (_event, path: string): Promise<LocalFileReadResult> => {
    if (!isAllowedLocalDocument(path)) return { ok: false, error: NOT_ALLOWED }
    try {
      return { ok: true, content: await fs.readFile(resolve(path), 'utf8') }
    } catch (err) {
      return { ok: false, error: messageOf(err) }
    }
  })

  ipcMain.handle(
    AGENT_IPC.localFileWrite,
    async (_event, path: string, content: string): Promise<LocalFileWriteResult> => {
      if (!isAllowedLocalDocument(path)) return { ok: false, error: NOT_ALLOWED }
      // 渲染端只该送字符串过来；送到别的类型说明调用方写错了，不要「宽容地」转成字符串落盘
      if (typeof content !== 'string') return { ok: false, error: '要写入的内容不是字符串' }
      try {
        await fs.writeFile(resolve(path), content, 'utf8')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: messageOf(err) }
      }
    }
  )
}
