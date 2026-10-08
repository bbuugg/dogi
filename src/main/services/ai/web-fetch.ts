/**
 * 内置 `web_fetch` 工具：抓取网页并整理成结构化 Markdown 返回给模型。
 *
 * 移植自 fishwork 的 `packages/tools/src/web-fetch.ts`，按本项目的三条纪律改造：
 *
 * 1. **只做 fetch 引擎，不带 `engine: 'browser'`**。fishwork 那条 browser 分支自己
 *    `playwright.chromium.launch()`；本项目已经有整套浏览器基础设施
 *    （`services/browser/`，含系统浏览器解析、持久 profile、内嵌面板与 `browser_*` 工具），
 *    再引第二套启动逻辑等于把 4.11 那些坑（channel / executablePath / screencast）
 *    复制一遍。需要 JS 渲染时模型直接用 `browser_navigate` + `browser_snapshot`。
 * 2. **长输出走本项目的产物机制**（`output-artifact.ts` + `read_tool_output`），
 *    而不是 fishwork 的 `output-log` / `read_log`：内联给「开头 + 滚动结尾 + 产物 id」，
 *    模型按 id 续读中段。理由与边界见 4.24。
 * 3. **工具闸在 execute 里**，不在注册层（4.23）：本工具只读、不写文件、不改系统，
 *    所以**任何权限模式都直接执行**，不弹确认卡。
 *
 * 只允许 http(s)：挡掉 `file:` / `data:` / `javascript:`（后者能直接执行代码）。
 */
import { z } from 'zod'
import { OutputArtifactWriter } from './output-artifact'
import type { AiToolDef, ToolRunContext } from './tool-registry'

/** 返回 Markdown 的正文默认上限（字符） */
const DEFAULT_MAX_CHARS = 20_000
/** 单次上限，防止模型一次把几十万字符的页面塞进上下文 */
const MAX_CHARS_CEILING = 100_000
/** 最多列出的页面内链接条数 */
const MAX_LINKS = 50
/** 页面加载默认 / 最大超时（毫秒） */
const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 60_000
/** 内联上限：超过就落盘成产物（与终端 / execute_command 同一档，4.24） */
const INLINE_MAX = 12_000
/** fetch 路径下用于 Markdown 转换的 HTML 最大字符数（防超大页撑爆内存） */
const MAX_HTML_CHARS = 3_000_000

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 解除常见 HTML 实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** 从原始 HTML 抽标题（拿不到返回空串） */
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return ''
  return decodeEntities(m[1].replace(/\s+/g, ' ').trim())
}

/** 从原始 HTML 抽 http(s) 链接（绝对地址、去重、带可见文本） */
function extractLinks(html: string, base: string): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = []
  const seen = new Set<string>()
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    if (!text) continue
    // 先把相对地址解析成绝对地址（base 为最终 URL），再按协议过滤、去重
    let abs: string
    try {
      abs = new URL(m[1].trim(), base).toString()
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(abs) || seen.has(abs)) continue
    seen.add(abs)
    out.push({ text: text.slice(0, 120), href: abs })
  }
  return out
}

/** 去掉对正文无价值的节点，避免 turndown 把它们转成噪声文本 */
function cleanHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '')
}

/** turndown 的构造器类型（它是 CJS 的 `export =`，ESM 侧 default 与模块本身同形） */
type TurndownCtor = typeof import('turndown')

/** HTML → Markdown（turndown 走动态 import：万一没装，给一句可读错误而不是让整轮崩） */
async function htmlToMarkdown(html: string): Promise<string> {
  let mod: TurndownCtor
  try {
    // 动态 import 拿到的是命名空间（多了个 default 键），CJS 的 `export =` 直接当构造器用
    mod = (await import('turndown')) as unknown as TurndownCtor
  } catch {
    throw new Error('turndown 未安装（HTML→Markdown 转换器），请在依赖里补上 turndown 后重试。')
  }
  // CJS 包经 ESM 动态 import 时 default 才是模块本身
  const TurndownService = ((mod as { default?: TurndownCtor }).default ?? mod) as TurndownCtor
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  td.remove(['script', 'style', 'noscript', 'svg', 'iframe', 'head', 'nav', 'footer', 'header', 'aside', 'form'])
  return td.turndown(html).trim()
}

interface FetchedPage {
  title: string
  finalUrl: string
  markdown: string
  links: Array<{ text: string; href: string }>
}

/** Node 原生 fetch 取静态 HTML 后抽取 */
async function fetchByHttp(target: URL, timeout: number, signal?: AbortSignal): Promise<FetchedPage> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const finalUrl = res.url || target.toString()
    let html = await res.text()
    if (html.length > MAX_HTML_CHARS) html = html.slice(0, MAX_HTML_CHARS)
    const title = extractTitle(html)
    const links = extractLinks(html, finalUrl)
    const markdown = await htmlToMarkdown(cleanHtml(html))
    return { title, finalUrl, markdown, links }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 把抓到的页面整理成模型友好的字符串。
 *
 * 正文按 `maxChars` 裁剪后走 `OutputArtifactWriter`：超内联上限就整篇落盘、返回产物 id
 * 与续读参数（4.24）—— 抓来的长文档最该做的事是「回头精读某一段」，
 * 而不是把中段直接扔掉（重抓一次的代价太大）。
 */
async function formatPage(
  p: FetchedPage,
  requestedUrl: string,
  clampedMax: number,
  ctx: ToolRunContext,
  call: { toolCallId: string }
): Promise<string> {
  const md = p.markdown.length > clampedMax ? p.markdown.slice(0, clampedMax) : p.markdown
  const linkSection = p.links.length
    ? `\n\n## 页面内链接（前 ${Math.min(p.links.length, MAX_LINKS)} 条）\n` +
      p.links
        .slice(0, MAX_LINKS)
        .map((l) => `- [${l.text}](${l.href})`)
        .join('\n')
    : ''
  const header = `# ${p.title || '(无标题)'}\n源地址：${p.finalUrl}（抓取自 ${requestedUrl}）\n`
  const full = `${header}\n${md}${linkSection}${
    p.markdown.length > clampedMax
      ? `\n\n⚠️ 正文已按 maxChars=${clampedMax} 裁到开头这段（共 ${p.markdown.length} 字符）。` +
        '要看后面的内容先用 read_tool_output 读产物（参数在下面给出），或把 maxChars 调大后重抓。'
      : ''
  }`
  const writer = new OutputArtifactWriter({
    conversationId: ctx.conversationId,
    toolCallId: call.toolCallId,
    inlineMax: INLINE_MAX,
    headChars: 4000
  })
  writer.append(full)
  const out = await writer.finish()
  return out.text
}

export function buildWebFetchDef(): AiToolDef {
  return {
    name: 'web_fetch',
    scope: 'both',
    description:
      '抓取网页并整理成结构化 Markdown 返回。适合：联网查资料、读文档 / 博客 / 文章、从页面里提取链接继续深挖。' +
      '只取静态 HTML（不跑 JavaScript）；页面需要登录或 JS 渲染时改用 browser_navigate + browser_snapshot。' +
      `只允许 http(s)。页面过长时会压成「开头 + 结尾 + 产物 id」，用 read_tool_output 按 offset 续读中段。只读，不写任何文件。`,
    inputSchema: z.object({
      url: z.string().describe('要抓取的网页 URL，必须是 http(s)，如 https://example.com'),
      timeoutMs: z
        .number()
        .optional()
        .describe(`页面加载超时（毫秒），默认 ${DEFAULT_TIMEOUT}，最大 ${MAX_TIMEOUT}`),
      maxChars: z
        .number()
        .optional()
        .describe(
          `返回 Markdown 的最大字符数，默认 ${DEFAULT_MAX_CHARS}，范围 1000–${MAX_CHARS_CEILING}`
        )
    }),
    execute: async (rawInput, call, ctx) => {
      const { url, timeoutMs, maxChars } = rawInput as {
        url: string
        timeoutMs?: number
        maxChars?: number
      }
      const clampedMax = Math.max(1000, Math.min(MAX_CHARS_CEILING, Math.trunc(maxChars ?? DEFAULT_MAX_CHARS)))
      const timeout = Math.max(1000, Math.min(MAX_TIMEOUT, Math.trunc(timeoutMs ?? DEFAULT_TIMEOUT)))

      let target: URL
      try {
        target = new URL(url)
      } catch {
        return `web_fetch 收到非法 URL：${url}。请传入形如 https://example.com 的完整地址。`
      }
      // 协议白名单：挡掉 file: / data: / javascript:
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return `web_fetch 拒绝抓取非 http(s) 地址：${url}（协议：${target.protocol}）`
      }

      if (ctx.signal.aborted) return 'web_fetch 已被中止（未发起请求）。'

      try {
        const page = await fetchByHttp(target, timeout, ctx.signal)
        if (ctx.signal.aborted) return 'web_fetch 已被中止。'
        return await formatPage(page, target.toString(), clampedMax, ctx, call)
      } catch (err) {
        // 抓取失败是**可预期**的结果：给模型一句能据此改道的话，别抛错打断整轮
        return `web_fetch 抓取 ${url} 失败：${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}