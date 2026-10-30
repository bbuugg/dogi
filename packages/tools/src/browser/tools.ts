/**
 * 给工作区 Agent 用的浏览器工具（注册进 runAgent 的 extraTools）。
 *
 * 用**自己的会话 id**（`agent-browser:<conversationId>`，见 @fizz/contracts/browser）：
 * 一个 Agent 会话一份浏览器，互不串台；会话池与渲染端面板共用，事件按 sessionId 各回各家。
 * 会话 id 在**构建时**由调用方（chat-turn，已绑定某条会话）捕获进闭包 —— 工具定义是
 * 静态注册的，不捕获任何一次对话的绑定。
 *
 * 定位用 **ref**（`aria-ref=eN`）而不是让模型拼 CSS 选择器：
 * `locator.ariaSnapshot({ mode: 'ai' })` 会为每个可交互元素生成 `[ref=eN]` 并标出
 * `[cursor=pointer]`，模型照着 ref 点就行 —— 这是 Playwright 自家 MCP 的做法（公开 API）。
 * ref 只在当前页面状态下有效，页面一变（导航 / 重渲染）就得重新 snapshot。
 */
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import type { BrowserChannel } from '@fizz/contracts'
import { agentBrowserSessionId } from '@fizz/contracts'
import { resolveInside } from '@fizz/contracts/workspace'
import { tr } from '@fizz/i18n'
import {
  browserSessions,
  createBrowserSessionHandlers,
  type BrowserSession
} from './engine'
import { pageErrorMessage } from '../headless'

/** 回给模型的快照字符上限 */
const MAX_SNAPSHOT_CHARS = 6000
/** 单次动作的默认超时 */
const DEFAULT_ACTION_TIMEOUT = 15_000
/** browser_evaluate 返回值的字符上限 */
const MAX_EVAL_CHARS = 6000

export interface BrowserToolOptions {
  /** 浏览器来源偏好（函数：执行时现取，偏好可随时改） */
  channel: () => BrowserChannel
  /** 本轮对话 id（闭包捕获，用于推导会话 id） */
  conversationId: string
  /** 工作区绝对路径（browser_screenshot 落盘用） */
  workspacePath?: string
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字符）`
}

function errText(err: unknown): string {
  // 只回第一行（Call log 太啰嗦），但要先剥掉 playwright 附带的终端样式
  return pageErrorMessage(err).split('\n')[0]
}

interface Target {
  ref?: string
  selector?: string
}

/** 解析定位参数为 Locator；两者都没给直接报错 */
function locate(page: import('playwright').Page, target: Target) {
  if (target.ref) return page.locator(`aria-ref=${target.ref}`)
  if (target.selector) return page.locator(target.selector)
  throw new Error('必须提供 ref 或 selector。ref 来自 browser_snapshot 的 [ref=eN]')
}

/** 页面的 AI 可访问性快照：模型据此决定下一步点哪里 */
async function snapshot(page: import('playwright').Page): Promise<string> {
  const url = page.url()
  const title = await page.title().catch(() => '')
  let tree = ''
  try {
    tree = await page.locator('body').ariaSnapshot({ mode: 'ai' })
  } catch (err) {
    tree = `（无法生成快照：${errText(err)}）`
  }
  if (!tree.trim()) tree = '（页面没有可访问的元素）'
  return `页面：${title || '(无标题)'}\nURL：${url}\n\n${truncate(tree, MAX_SNAPSHOT_CHARS)}`
}

/** 动作后的回执：附一份最新快照，省掉模型「点完再问一次页面长什么样」的往返 */
async function afterAction(page: import('playwright').Page, what: string): Promise<string> {
  return `${what}\n\n${await snapshot(page)}`
}

export function buildBrowserToolSet(opts: BrowserToolOptions): Record<string, unknown> {
  const { channel, conversationId, workspacePath } = opts
  const sessionId = agentBrowserSessionId(conversationId)

  async function ensureSession(): Promise<BrowserSession> {
    let session = browserSessions.get(sessionId)
    if (session && !session.isAlive()) {
      await browserSessions.close(sessionId, '会话已失效，重建')
      session = undefined
    }
    if (!session) session = browserSessions.create(sessionId, createBrowserSessionHandlers())
    if (!session.isAlive()) {
      await session.start(channel())
    }
    return session
  }

  const navigate = tool({
    description: tr(
      '在浏览器中打开一个网址并返回页面快照。浏览器是真实运行的（无窗口），操作会真的作用在网页上。',
      'Open a URL in the browser and return a page snapshot. The browser is real (headless); actions affect the live page.'
    ),
    inputSchema: z.object({ url: z.string().describe(tr('要打开的网址，如 https://example.com', 'URL to open, e.g. https://example.com')) }),
    execute: async ({ url }) => {
      const session = await ensureSession()
      await session.navigate(url)
      const page = session.getPage()
      return afterAction(page, `已打开 ${page.url()}`)
    }
  })

  const snapshotTool = tool({
    description: tr(
      '获取当前页面的可访问性快照（YAML）：每个元素带 role、可访问名称与 [ref=eN] 引用，可点击元素还带 [cursor=pointer]。点击 / 输入前先看它拿到 ref。页面一旦变化（导航、重渲染），旧的 ref 会失效，需要重新获取。',
      'Get an accessibility snapshot of the current page (YAML): every element has a role, accessible name and [ref=eN]; clickable elements also show [cursor=pointer]. Call it before clicking/typing to get refs. After the page changes (navigation, re-render), old refs become invalid — snapshot again.'
    ),
    inputSchema: z.object({}),
    execute: async () => {
      const session = await ensureSession()
      return snapshot(session.getPage())
    }
  })

  const click = tool({
    description: tr(
      '点击页面元素。优先用 browser_snapshot 里的 ref（如 e5）；也可传 selector（CSS、role=button[name="登录"]、text=提交、data-testid=go）。',
      'Click a page element. Prefer the ref from browser_snapshot (e.g. e5); selector is also accepted (CSS, role=button[name="Sign in"], text=Submit, data-testid=go).'
    ),
    inputSchema: z.object({
      ref: z.string().optional().describe(tr('来自 browser_snapshot 的元素引用，如 "e5"', 'Element ref from browser_snapshot, e.g. "e5"')),
      selector: z.string().optional().describe(tr('Playwright 选择器，ref 不可用时的兜底', 'Playwright selector; fallback when ref is unavailable')),
      timeoutMs: z.number().optional().describe(tr('超时毫秒数，默认 15000', 'Timeout in milliseconds; default 15000'))
    }),
    execute: async (raw) => {
      const args = raw as Target & { timeoutMs?: number }
      const session = await ensureSession()
      const page = session.getPage()
      const loc = locate(page, args).first()
      await loc.click({ timeout: args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT })
      return afterAction(page, `已点击 ${args.ref ?? args.selector}`)
    }
  })

  const type = tool({
    description: tr(
      '在输入框中填入文本（会先清空原内容）。用 ref 或 selector 定位输入框；submit=true 时填完按回车（适合搜索框 / 登录表单）。',
      'Fill text into an input (clears existing content first). Use ref or selector to locate it; with submit=true press Enter after filling (good for search boxes / login forms).'
    ),
    inputSchema: z.object({
      ref: z.string().optional().describe(tr('来自 browser_snapshot 的输入框引用', 'Input ref from browser_snapshot')),
      selector: z.string().optional().describe(tr('Playwright 选择器，ref 不可用时的兜底', 'Playwright selector; fallback when ref is unavailable')),
      text: z.string().describe(tr('要填入的文本', 'Text to fill in')),
      submit: z.boolean().optional().describe(tr('填完后按回车，默认 false', 'Press Enter after filling; default false')),
      timeoutMs: z.number().optional().describe(tr('超时毫秒数，默认 15000', 'Timeout in milliseconds; default 15000'))
    }),
    execute: async (raw) => {
      const args = raw as Target & { text: string; submit?: boolean; timeoutMs?: number }
      const session = await ensureSession()
      const page = session.getPage()
      const loc = locate(page, args).first()
      const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT
      await loc.fill(args.text, { timeout })
      if (args.submit) await loc.press('Enter', { timeout })
      return afterAction(page, `已输入「${args.text}」到 ${args.ref ?? args.selector}${args.submit ? ' 并回车' : ''}`)
    }
  })

  const press = tool({
    description: tr('按下一个键（如 Enter、Escape、Tab、ArrowDown、Control+A）。作用于页面当前焦点。', 'Press a key (e.g. Enter, Escape, Tab, ArrowDown, Control+A). Acts on the page’s current focus.'),
    inputSchema: z.object({ key: z.string().describe(tr('键名，如 Enter / Escape / Tab / Control+A', 'Key name, e.g. Enter / Escape / Tab / Control+A')) }),
    execute: async ({ key }) => {
      const session = await ensureSession()
      const page = session.getPage()
      await page.keyboard.press(key)
      return afterAction(page, `已按下 ${key}`)
    }
  })

  const waitFor = tool({
    description: tr(
      '等待条件满足：给 text 等文本出现，给 selector 等元素可见，都不给则等网络空闲（页面加载完成）。用于等异步内容渲染出来。',
      'Wait for a condition: text waits for it to appear, selector waits for the element to be visible, neither waits for network idle (page loaded). Use it for asynchronously rendered content.'
    ),
    inputSchema: z.object({
      text: z.string().optional().describe(tr('等待包含该文本的元素出现', 'Wait for an element containing this text')),
      selector: z.string().optional().describe(tr('等待该选择器匹配的元素可见', 'Wait for the element matching this selector to be visible')),
      timeoutMs: z.number().optional().describe(tr('超时毫秒数，默认 15000', 'Timeout in milliseconds; default 15000'))
    }),
    execute: async (raw) => {
      const args = raw as { text?: string; selector?: string; timeoutMs?: number }
      const session = await ensureSession()
      const page = session.getPage()
      const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT
      if (args.selector) {
        await page.locator(args.selector).first().waitFor({ state: 'visible', timeout })
        return `元素已可见：${args.selector}`
      }
      if (args.text) {
        await page.getByText(args.text).first().waitFor({ state: 'visible', timeout })
        return `文本已出现：${args.text}`
      }
      await page.waitForLoadState('networkidle', { timeout })
      return '网络已空闲（页面加载完成）'
    }
  })

  const evaluate = tool({
    description: tr(
      '在页面里执行一段 JavaScript 并返回结果（自动 JSON 序列化）。适合提取数据、读取元素文本、做断言。表达式形如 "document.title" 或 "() => [...document.querySelectorAll(\'a\')].map(a => a.href)"。',
      'Run JavaScript in the page and return the result (JSON-serialized). Good for extracting data, reading element text, and assertions. Examples: "document.title" or "() => [...document.querySelectorAll(\'a\')].map(a => a.href)".'
    ),
    inputSchema: z.object({ expression: z.string().describe(tr('要执行的 JS 表达式或函数体', 'JavaScript expression or function body to execute')) }),
    execute: async ({ expression }) => {
      const session = await ensureSession()
      const page = session.getPage()
      let value: unknown
      try {
        value = await page.evaluate(expression)
      } catch (err) {
        throw new Error(`页面执行失败：${errText(err)}`)
      }
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      return truncate(text ?? String(value), MAX_EVAL_CHARS)
    }
  })

  const screenshot = tool({
    description: tr(
      '给当前页面截图并保存成 PNG 文件（默认存到工作区的 .fizz/screenshots/ 下），返回文件路径。用于留证或让用户查看当时的页面。注意：返回的是路径，不是图片内容。',
      'Screenshot the current page to a PNG (defaults to .fizz/screenshots/ in the workspace) and return the file path. Use it as evidence or to let the user see the page. Note: returns a path, not image contents.'
    ),
    inputSchema: z.object({
      path: z.string().optional().describe(tr('保存路径（相对工作区），缺省自动命名', 'Save path (relative to the workspace); auto-named by default')),
      fullPage: z.boolean().optional().describe(tr('截整页（含滚动区域），默认 false 只截可视区', 'Capture the full page including scrolled areas; default false captures only the viewport'))
    }),
    execute: async (raw) => {
      const { path, fullPage = false } = raw as { path?: string; fullPage?: boolean }
      const session = await ensureSession()
      const page = session.getPage()
      const buf = await page.screenshot({ fullPage, type: 'png' })
      const rel = path?.trim() || `.fizz/screenshots/shot-${Date.now()}.png`
      // 无工作区会话（path 空）没有落盘根目录：拿相对路径当绝对路径会写进**进程 cwd**，
      // 在仓库根上凭空长出一个 `.fizz/screenshots/`。明确拒绝，让模型改用 browser_snapshot。
      if (!workspacePath) {
        return '这个会话没有绑定工作区，没有可以存图的目录；请用 browser_snapshot 描述页面内容'
      }
      const abs = resolveInside(workspacePath, rel)
      await fs.mkdir(dirname(abs), { recursive: true })
      await fs.writeFile(abs, buf)
      return `截图已保存：${rel}（${(buf.length / 1024).toFixed(1)} KB）`
    }
  })

  const closeT = tool({
    description: tr('关闭 Agent 的浏览器会话，释放浏览器进程。任务完成、不再需要浏览器时调用。', 'Close the agent’s browser session and release the browser process. Call when the task is done and the browser is no longer needed.'),
    inputSchema: z.object({}),
    execute: async () => {
      if (!browserSessions.has(sessionId)) return '浏览器本来就没打开'
      await browserSessions.close(sessionId, 'AI 已关闭')
      return '浏览器已关闭'
    }
  })

  return {
    browser_navigate: navigate,
    browser_snapshot: snapshotTool,
    browser_click: click,
    browser_type: type,
    browser_press: press,
    browser_wait_for: waitFor,
    browser_evaluate: evaluate,
    browser_screenshot: screenshot,
    browser_close: closeT
  }
}

/**
 * 系统提示词里的浏览器段落：只在挂了浏览器工具时追加。
 *
 * ⚠️ 与工具清单同样的取舍：**不逐个复述工具**（每个 browser_* 的 description 已经
 * 随 schema 发出去），只写 schema 里装不下的跨工具约定 —— 先 snapshot 拿 ref 的
 * 工作流、以及「操作会真的作用在网页上」这个安全前提。
 */
export const BROWSER_PROMPT_SECTION = tr(
  [
    '浏览器自动化（Playwright，浏览器无窗口运行、画面可在界面右侧查看）：',
    '- 操作页面前**先 browser_snapshot 拿 ref**，再用 ref 点击 / 输入；页面一变 ref 就失效，要重新 snapshot；',
    '- 浏览器是真实运行的，点击 / 输入会真的作用在网页上（可能提交表单、下单、删数据）—— 不可逆的操作前先向用户说明；',
    '- 需要看页面长什么样时用 browser_snapshot（文字快照），它比截图更适合你理解结构。'
  ].join('\n'),
  [
    'Browser automation (Playwright; runs headless and the view is shown on the right):',
    '- Before interacting with a page, **call browser_snapshot to get refs**, then click/type with those refs. Refs become invalid after the page changes, so snapshot again;',
    '- The browser is real: clicks and typing affect the live page (they may submit forms, place orders, or delete data) — explain before irreversible actions;',
    '- To see what the page looks like, use browser_snapshot (text snapshot); it is better than a screenshot for understanding structure.'
  ].join('\n')
)
