/**
 * 内置 web_fetch 工具：打开任意网页（含搜索结果页），抓取正文并整理成 AI 容易理解的
 * 结构化 Markdown。
 *
 * 两种抓取引擎（engine 参数切换）：
 * - `fetch`（默认）：用 Node 原生 fetch 直接取静态 HTML，更轻量、更快，但拿不到 JS 渲染后的内容；
 * - `browser`：用 Playwright 无头浏览器跑 JS 渲染（适合 SPA / 动态内容）。
 *
 * 设计要点：
 * - 只读 / 无副作用：不写文件、不改系统，任何权限模式下都可用，相当于「读一个网页」。
 *   （唯一例外：正文超长时会把**全文**落一份到工作区 `.fizz/tool-output/`，
 *   那是 Fizz 自己的缓存目录 —— 文件树与 git 都忽略它，且只有这样 read_file
 *   才能把中段读回来。见 output-log.ts 的形状说明。）
 * - 正文 HTML 用 turndown 转成 Markdown，链接单独列出便于 Agent 继续深挖；
 * - 输出有上限（默认 20000 字符），超长截断并标注，避免把整页塞爆上下文。
 * - playwright / turndown 都走动态 import：没装时返回清晰的可读错误，而不是让整轮崩掉。
 *
 * ## 超时与中止（用户点「停止」）语义
 *
 * 单次抓取永远有结论：`timeoutMs` 默认 30000、钳在 [1000, 60000]，两种引擎都吃它
 * （fetch 用 AbortController 定时 abort，browser 传给 `page.goto`）。
 * 用户点「停止」时 abortSignal 一路传到最底层：fetch 直接 abort 请求、browser 关页面、
 * **连首次使用时的 chromium 下载也会被 kill**（见 playwright-browsers.ts）——
 * 早先下载那段不接中止，国内访问 playwright CDN 慢时能挂 10 分钟，点停止毫无反应。
 * 超时与主动中止返回**不同的文案**：模型据此知道是该换镜像 / 调大 timeoutMs，还是别重试。
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { summarizeLongOutput } from './output-log'
import { ensureChromiumReady } from './playwright-browsers'
import { abortableSleep, launchHeadlessChromium } from './headless'

/**
 * 返回 Markdown 的正文默认上限（字符）。
 *
 * 取 8000 而不是更大的值：正文超过一个工具结果的预算时，`formatPage` 会把**全文**
 * 落盘并把开头结尾返回给模型（见 output-log.ts）—— 也就是说默认值给大了并不会让
 * 模型看到更多有用内容，只会让它在摘要之外还多背一段正文。真需要细读某一段时，
 * 模型可以按落盘文件的行号位置 read_file，或显式调大 maxChars 重抓。
 */
const DEFAULT_MAX_CHARS = 8_000
/** 最多列出的页面内链接条数 */
const MAX_LINKS = 50
/** 页面加载默认超时（毫秒） */
const DEFAULT_TIMEOUT = 30_000
/** fetch 路径下，用于 Markdown 转换的 HTML 最大字符数（防超大页撑爆内存 / 卡死） */
const MAX_HTML_CHARS = 3_000_000

/** 抓取结果（两种引擎共用，统一格式化） */
interface FetchedPage {
  title: string
  finalUrl: string
  markdown: string
  links: Array<{ text: string; href: string }>
}

/**
 * 浏览器内执行的裁剪逻辑（以字符串形式传给 page.evaluate，避免在 Node 侧引用 document 等 DOM 全局）。
 * 返回：标题、最终 URL（重定向后）、清洗后的正文 HTML、正文内链接。
 */
const BROWSER_EXTRACT = `
(() => {
  const noise = document.querySelectorAll(
    'script,style,noscript,svg,iframe,nav,footer,header,aside,form,.advert,.ads,.ad,.cookie,.banner,[role="banner"],[role="navigation"],[role="dialog"]'
  );
  noise.forEach((el) => el.remove());
  const root =
    document.querySelector('main') ||
    document.querySelector('article') ||
    document.body;
  const links = [];
  const seen = new Set();
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.href;
    const text = (a.textContent || '').trim();
    if (!/^https?:\\/\\//i.test(href)) return;
    if (seen.has(href) || !text) return;
    seen.add(href);
    links.push({ text: text.slice(0, 120), href });
  });
  return {
    title: document.title,
    url: location.href,
    html: root.innerHTML,
    links
  };
})()
`

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
    const raw = m[1].trim()
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    if (!text) continue
    // 先把相对地址解析成绝对地址（base 为最终 URL），再按协议过滤、去重
    let abs: string
    try {
      abs = new URL(raw, base).toString()
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(abs) || seen.has(abs)) continue
    seen.add(abs)
    out.push({ text: text.slice(0, 120), href: abs })
  }
  return out
}

/** fetch 路径：用正则去掉对正文无价值的节点，避免 turndown 把它们转成噪声文本 */
function cleanHtmlForFetch(html: string): string {
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

/** 把 HTML 转成 Markdown（动态引入 turndown，缺失时抛错由调用方转成可读提示） */
async function htmlToMarkdown(html: string): Promise<string> {
  let turndownMod: unknown
  try {
    turndownMod = await import('turndown')
  } catch {
    throw new Error(
      'turndown 未安装（HTML→Markdown 转换器）。请在服务器环境执行 `npm i turndown` 后重试。'
    )
  }
  const TurndownService = (turndownMod as { default?: unknown }).default ?? turndownMod
  const td = new (TurndownService as new (opts?: Record<string, unknown>) => {
    remove: (sel: string | string[]) => void
    turndown: (html: string) => string
  })({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  td.remove(['script', 'style', 'noscript', 'svg', 'iframe', 'head', 'nav', 'footer', 'header', 'aside', 'form'])
  return td.turndown(html).trim()
}

/**
 * 把统一的 FetchedPage 整理成模型友好的字符串。
 *
 * 正文超过 `maxChars`（模型自己给的上限）或一个工具结果的预算时，整篇落盘到工作区的
 * `.fizz/tool-output/` 并回相对路径 + 行号 —— 抓来的长文档最该做的事就是「回头精读
 * 某一段」，而不是把中段直接扔掉（读回来要重抓一次，代价太大）。
 */
async function formatPage(
  p: FetchedPage,
  requestedUrl: string,
  clampedMax: number,
  root: string
): Promise<string> {
  const clipped = p.markdown.length > clampedMax
  const md = clipped ? p.markdown.slice(0, clampedMax) : p.markdown
  const linkSection = p.links.length
    ? `\n\n## 页面内链接（前 ${Math.min(p.links.length, MAX_LINKS)} 条）\n` +
      p.links
        .slice(0, MAX_LINKS)
        .map((l) => `- [${l.text}](${l.href})`)
        .join('\n')
    : ''
  const header = `# ${p.title || '(无标题)'}\n源地址：${p.finalUrl}（抓取自 ${requestedUrl}）\n`
  const full = `${header}\n${md}${linkSection}`
  return summarizeLongOutput(full, {
    root,
    tool: 'web_fetch',
    detail: p.finalUrl,
    extra: clipped
      ? `正文按你给的 maxChars=${clampedMax} 裁到了开头这段；想要更靠后的内容就用 read_file 的 offset/limit 翻落盘文件，或把 maxChars 调大（上限 100000）重抓。`
      : undefined
  })
}

/** engine=browser：Playwright 无头浏览器跑 JS 后抓取 */
async function fetchByBrowser(
  target: URL,
  timeout: number,
  abortSignal?: AbortSignal
): Promise<FetchedPage> {
  // 首次使用会在线下载 chromium headless shell（约 150MB）。
  // ⚠️ 下载**必须接 abortSignal**：国内访问 playwright CDN 常只有几 KB/s，一次拖几分钟，
  // 不接的话用户点「停止」完全没反应（整轮卡到 10 分钟下载超时）。见 playwright-browsers.ts。
  await ensureChromiumReady(abortSignal)
  // launch 超时 + playwright 未安装的可读报错都收在 headless.ts
  const browser = await launchHeadlessChromium(timeout)
  try {
    const context = await browser.newContext({ userAgent: UA })
    const page = await context.newPage()
    // 用户中止时直接关掉页面，让挂起的 goto / evaluate 抛错退出
    abortSignal?.addEventListener(
      'abort',
      () => {
        page.close().catch(() => {})
      },
      { once: true }
    )
    await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout })
    // 给 SPA / 懒加载一点渲染时间（可中止：用户点停止时不必干等这 800ms）
    await abortableSleep(800, abortSignal)
    if (abortSignal?.aborted) {
      throw new Error('web_fetch 抓取已被用户中止（点了「停止」）。')
    }
    const data = (await page.evaluate(BROWSER_EXTRACT)) as {
      title: string
      url: string
      html: string
      links: Array<{ text: string; href: string }>
    }
    const markdown = await htmlToMarkdown(data.html)
    return { title: data.title, finalUrl: data.url, markdown, links: data.links }
  } finally {
    await browser?.close().catch(() => {})
  }
}

/** engine=fetch（默认）：Node 原生 fetch 取静态 HTML 后抓取 */
async function fetchByHttp(
  target: URL,
  timeout: number,
  abortSignal?: AbortSignal
): Promise<FetchedPage> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (abortSignal) {
    if (abortSignal.aborted) ctrl.abort()
    else abortSignal.addEventListener('abort', onAbort, { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeout)
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
    const markdown = await htmlToMarkdown(cleanHtmlForFetch(html))
    return { title, finalUrl, markdown, links }
  } catch (err) {
    // fetch 被 abort 时只抛一句「This operation was aborted」，分不清是谁 abort 的。
    // 超时要能认出来：调用方据此告诉模型「换镜像 / 调大 timeoutMs，别原样重试」，
    // 而用户点停止则是另一句（直接收场）。
    if (timedOut) {
      throw new Error(`web_fetch fetch 超时（timeout ${timeout}ms 内未拿到响应）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
  }
}

/**
 * 构建 web_fetch 工具（返回单键 ToolSet，便于在 agent 端与其它工具合并）。
 *
 * `root` = 工作区根，只用于「正文过长时把全文落进 `.fizz/tool-output/`」——
 * 落在工作区内 read_file 才读得回来（数据目录在 resolveInside 边界外，见 output-log.ts）。
 */
export function buildWebFetchTool(root: string): ToolSet {
  return {
    web_fetch: tool({
      description:
        '抓取网页并整理成结构化 Markdown 返回给模型。默认用 Node 原生 fetch 取静态 HTML（更快更轻量）；设置 engine="browser" 则改用 Playwright 无头浏览器跑 JS 渲染（适合 SPA / 动态内容、搜索结果页）。适合：联网查资料、读文档 / 博客 / 文章、从网页提取链接继续深挖。页面过长时会只回开头结尾，并把全文落盘到工作区文件（结果里给出相对路径与行号）；其余部分用 read_file 的 offset/limit 接着读，也可以用 search_files 检索。只读、不写任何文件。browser 引擎依赖 playwright + chromium（`npm i playwright && npx playwright install chromium`）。',
      inputSchema: z.object({
        url: z.string().describe('要抓取的网页 URL，必须是 http(s)，如 https://example.com'),
        engine: z
          .enum(['browser', 'fetch'])
          .optional()
          .describe('抓取引擎：browser=用 Playwright 无头浏览器跑 JS 渲染；fetch=用 Node 原生 fetch 取静态 HTML（默认）。拿不到 JS 渲染内容时改用 browser。'),
        timeoutMs: z
          .number()
          .optional()
          .describe('页面加载超时（毫秒），默认 30000，最大 60000'),
        maxChars: z
          .number()
          .optional()
          .describe(
            `返回 Markdown 的最大字符数，默认 ${DEFAULT_MAX_CHARS}，范围 1000–100000。` +
              '默认值已够判断页面内容；一般不要调大 —— 需要看某一段时用落盘文件的 offset/limit 更省。'
          )
      }),
      execute: async ({ url, engine, timeoutMs, maxChars }, options) => {
        const clampedMax = Math.max(
          1000,
          Math.min(100_000, Math.trunc(maxChars ?? DEFAULT_MAX_CHARS))
        )
        const timeout = Math.max(1000, Math.min(60_000, Math.trunc(timeoutMs ?? DEFAULT_TIMEOUT)))

        // URL 合法性 + 协议白名单：只允许 http(s)，挡掉 file:/data:/javascript: 等
        let target: URL
        try {
          target = new URL(url)
          if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return `web_fetch 拒绝抓取非 http(s) 地址：${url}（协议：${target.protocol}）`
          }
        } catch {
          return `web_fetch 收到非法 URL：${url}。请传入形如 https://example.com 的完整地址。`
        }

        if (options.abortSignal?.aborted) return 'web_fetch 已被中止（未发起请求）。'

        try {
          const page =
            engine === 'browser'
              ? await fetchByBrowser(target, timeout, options.abortSignal)
              : await fetchByHttp(target, timeout, options.abortSignal)
          return await formatPage(page, target.toString(), clampedMax, root)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // 用户主动点了「停止」：别当成抓取失败，模型据此直接收场、不要重试
          if (options.abortSignal?.aborted) {
            return 'web_fetch 已被用户中止（点了「停止」），本轮不再重试。'
          }
          // 超时单独说清：国内访问境外站点（google / github 等）时 connect 阶段就可能
          // 挂到超时，这时重试通常没用，模型该换可达的镜像源或改用 fetch 引擎。
          // 两种引擎的超时都收敛成同一句带「timeout」的文案（见 fetchByHttp / fetchByBrowser）。
          if (/timeout|超时|timed out/i.test(msg)) {
            return (
              `web_fetch 抓取 ${url} 超时（${timeout}ms 内没拿到响应）。` +
              `常见原因是该站点在本机网络不可达（如境外站点被墙）或响应极慢；` +
              `不要原样重试，可改抓可达的镜像 / 文档站，或把 timeoutMs 调大（上限 60000）再试一次。`
            )
          }
          return `web_fetch 抓取 ${url} 失败：${msg}`
        }
      }
    })
  }
}
