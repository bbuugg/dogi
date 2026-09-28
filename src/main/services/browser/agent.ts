import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { Page } from 'playwright'
import type { BrowserChannel } from '@shared/types'
import { resolveInside } from '../ai/agent-core/workspace'
import { createBrowserSessionHandlers } from './handlers'
import { browserSessions, type BrowserSession } from './session'

/**
 * 给工作区 Agent 用的浏览器工具集。
 *
 * 用**自己的会话 id**（`agent-browser:<conversationId>`，见 @shared/browser）：
 * 一个 Agent 会话一份浏览器，互不串台；会话池与渲染端面板共用，
 * 事件按 sessionId 各回各家。
 *
 * 定位方式用 **ref**（`aria-ref=eN`）而不是让模型拼 CSS 选择器：
 * `locator.ariaSnapshot({ mode: 'ai' })` 会为每个可交互元素生成 `[ref=eN]`
 * 并顺带标出 `[cursor=pointer]`，模型照着 ref 点就行 —— 这是 Playwright 自家 MCP
 * 的做法，也是**公开 API**。
 * ref 只在当前页面状态下有效，页面一变（导航 / 重渲染）就得重新 snapshot。
 */

/** 回给模型的快照字符上限 */
const MAX_SNAPSHOT_CHARS = 6000
/** 单次动作的默认超时 */
const DEFAULT_ACTION_TIMEOUT = 15_000
/** browser_evaluate 返回值的字符上限 */
const MAX_EVAL_CHARS = 6000

export interface BrowserAgentOptions {
  /** 会话 id（用 @shared/browser 的 agentBrowserSessionId 推导） */
  sessionId: string
  /**
   * 浏览器来源偏好。**由调用方注入而不是这里读 storage** ——
   * 读 storage 会把 electron 拖进这个模块，它就没法脱离 Electron 单跑了
   * （`scripts/verify-agent-browser-tools.mjs` 直接跑的就是这份源码）。
   */
  channel: BrowserChannel
  /** 截图落盘的工作区根目录；缺省落到系统临时目录 */
  workspaceRoot?: string
}

/** 模型给的定位参数：ref 优先，selector 作兜底（CSS / role= / text= / data-testid=） */
interface Target {
  ref?: string
  selector?: string
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字符）`
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0]
}

/** 解析定位参数为 Locator；两者都没给直接报错（别猜「大概是想点那个按钮」） */
function locate(page: Page, target: Target) {
  if (target.ref) return page.locator(`aria-ref=${target.ref}`)
  if (target.selector) return page.locator(target.selector)
  throw new Error('必须提供 ref 或 selector。ref 来自 browser_snapshot 的 [ref=eN]')
}

/** 页面的 AI 可访问性快照：模型据此决定下一步点哪里 */
async function snapshot(page: Page): Promise<string> {
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
async function afterAction(page: Page, what: string): Promise<string> {
  return `${what}\n\n${await snapshot(page)}`
}

export function buildBrowserAgentTools(opts: BrowserAgentOptions): ToolSet {
  /**
   * 取会话，没有就懒启动。
   * 已经死掉的会话（浏览器进程退出 / 页面被关）在池里是 `closed` 终态、重启不了，
   * 必须先摘掉再建一个新的。
   */
  async function ensureSession(): Promise<BrowserSession> {
    let session = browserSessions.get(opts.sessionId)
    if (session && !session.isAlive()) {
      await browserSessions.close(opts.sessionId, '会话已失效，重建')
      session = undefined
    }
    if (!session) session = browserSessions.create(opts.sessionId, createBrowserSessionHandlers())
    if (!session.isAlive()) {
      // 不传视口预设 = 用默认的 PC 屏（见 @shared/browser）：
      // 模型在 PC 布局下取到的快照，与用户自己打开这个网址看到的一致
      await session.start(opts.channel)
    }
    return session
  }

  return {
    browser_navigate: tool({
      description:
        '在浏览器中打开一个网址并返回页面快照。浏览器是真实运行的（无窗口），操作会真的作用在网页上。',
      inputSchema: z.object({
        url: z.string().describe('要打开的网址，如 https://example.com')
      }),
      execute: async ({ url }) => {
        const session = await ensureSession()
        await session.navigate(url)
        const page = session.getPage()
        return afterAction(page, `已打开 ${page.url()}`)
      }
    }),

    browser_snapshot: tool({
      description:
        '获取当前页面的可访问性快照（YAML）：每个元素带 role、可访问名称与 [ref=eN] 引用，可点击元素还带 [cursor=pointer]。点击 / 输入前先看它拿到 ref。页面一旦变化（导航、重渲染），旧的 ref 会失效，需要重新获取。',
      inputSchema: z.object({}),
      execute: async () => {
        const session = await ensureSession()
        return snapshot(session.getPage())
      }
    }),

    browser_click: tool({
      description:
        '点击页面元素。优先用 browser_snapshot 里的 ref（如 e5）；也可传 selector（CSS、role=button[name="登录"]、text=提交、data-testid=go）。',
      inputSchema: z.object({
        ref: z.string().optional().describe('来自 browser_snapshot 的元素引用，如 "e5"'),
        selector: z
          .string()
          .optional()
          .describe('Playwright 选择器，ref 不可用时的兜底，如 "#submit"、\'role=button[name="登录"]\'、text=提交'),
        timeoutMs: z.number().optional().describe('超时毫秒数，默认 15000')
      }),
      execute: async (args) => {
        const session = await ensureSession()
        const page = session.getPage()
        const loc = locate(page, args).first()
        await loc.click({ timeout: args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT })
        return afterAction(page, `已点击 ${args.ref ?? args.selector}`)
      }
    }),

    browser_type: tool({
      description:
        '在输入框中填入文本（会先清空原内容）。用 ref 或 selector 定位输入框；submit=true 时填完按回车（适合搜索框 / 登录表单）。',
      inputSchema: z.object({
        ref: z.string().optional().describe('来自 browser_snapshot 的输入框引用'),
        selector: z.string().optional().describe('Playwright 选择器，ref 不可用时的兜底'),
        text: z.string().describe('要填入的文本'),
        submit: z.boolean().optional().describe('填完后按回车，默认 false'),
        timeoutMs: z.number().optional().describe('超时毫秒数，默认 15000')
      }),
      execute: async (args) => {
        const session = await ensureSession()
        const page = session.getPage()
        const loc = locate(page, args).first()
        const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT
        await loc.fill(args.text, { timeout })
        if (args.submit) await loc.press('Enter', { timeout })
        return afterAction(page, `已输入「${args.text}」到 ${args.ref ?? args.selector}${args.submit ? ' 并回车' : ''}`)
      }
    }),

    browser_press: tool({
      description: '按下一个键（如 Enter、Escape、Tab、ArrowDown、Control+A）。作用于页面当前焦点。',
      inputSchema: z.object({
        key: z.string().describe('键名，如 Enter / Escape / Tab / Control+A')
      }),
      execute: async ({ key }) => {
        const session = await ensureSession()
        const page = session.getPage()
        await page.keyboard.press(key)
        return afterAction(page, `已按下 ${key}`)
      }
    }),

    browser_wait_for: tool({
      description:
        '等待条件满足：给 text 等文本出现，给 selector 等元素可见，都不给则等网络空闲（页面加载完成）。用于等异步内容渲染出来。',
      inputSchema: z.object({
        text: z.string().optional().describe('等待包含该文本的元素出现'),
        selector: z.string().optional().describe('等待该选择器匹配的元素可见'),
        timeoutMs: z.number().optional().describe('超时毫秒数，默认 15000')
      }),
      execute: async (args) => {
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
    }),

    browser_evaluate: tool({
      description:
        '在页面里执行一段 JavaScript 并返回结果（自动 JSON 序列化）。适合提取数据、读取元素文本、做断言。表达式形如 "document.title" 或 "() => [...document.querySelectorAll(\'a\')].map(a => a.href)"。',
      inputSchema: z.object({
        expression: z.string().describe('要执行的 JS 表达式或函数体')
      }),
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
    }),

    browser_screenshot: tool({
      description:
        '给当前页面截图并保存成 PNG 文件（默认存到工作区的 .dogi/screenshots/ 下），返回文件路径。用于留证或让用户查看当时的页面。注意：返回的是路径，不是图片内容。',
      inputSchema: z.object({
        path: z.string().optional().describe('保存路径（相对工作区），缺省自动命名'),
        fullPage: z.boolean().optional().describe('截整页（含滚动区域），默认 false 只截可视区')
      }),
      execute: async ({ path, fullPage = false }) => {
        const session = await ensureSession()
        const page = session.getPage()
        const buf = await page.screenshot({ fullPage, type: 'png' })
        const rel = path?.trim() || `.dogi/screenshots/shot-${Date.now()}.png`
        const abs = opts.workspaceRoot
          ? resolveInside(opts.workspaceRoot, rel)
          : rel
        await fs.mkdir(dirname(abs), { recursive: true })
        await fs.writeFile(abs, buf)
        return `截图已保存：${rel}（${(buf.length / 1024).toFixed(1)} KB）`
      }
    }),

    browser_close: tool({
      description: '关闭 Agent 的浏览器会话，释放浏览器进程。任务完成、不再需要浏览器时调用。',
      inputSchema: z.object({}),
      execute: async () => {
        if (!browserSessions.has(opts.sessionId)) return '浏览器本来就没打开'
        await browserSessions.close(opts.sessionId, 'AI 已关闭')
        return '浏览器已关闭'
      }
    })
  }
}

/** 系统提示词里的浏览器段落：只在挂了浏览器工具时追加 */
export const BROWSER_PROMPT_SECTION = [
  '浏览器自动化（Playwright，浏览器无窗口运行、画面可在界面右侧查看）：',
  '- browser_navigate：打开网址；browser_snapshot：拿页面的可访问性快照（元素带 [ref=eN]）；',
  '- browser_click / browser_type / browser_press：按 ref 点击 / 输入 / 按键；',
  '- browser_wait_for：等元素、文本出现或网络空闲；browser_evaluate：在页面里跑 JS 取数据；',
  '- browser_screenshot：截图存到工作区；browser_close：用完关闭浏览器。',
  '浏览器使用约定：',
  '- 操作页面前**先 browser_snapshot 拿 ref**，再用 ref 点击 / 输入；页面一变 ref 就失效，要重新 snapshot；',
  '- 浏览器是真实运行的，点击 / 输入会真的作用在网页上（可能提交表单、下单、删数据）—— 不可逆的操作前先向用户说明；',
  '- 需要看页面长什么样时用 browser_snapshot（文字快照），它比截图更适合你理解结构。'
].join('\n')
