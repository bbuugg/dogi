/**
 * 内置 screenshot 工具：用 Playwright 无头浏览器打开网页截图，存到服务端数据目录的
 * `screenshots/`，并返回一个**同源相对 URL**（`/api/screenshots/<uuid>.<ext>`）。
 *
 * 模型可把它作为 Markdown 图片语法嵌入回复（如 `![截图](/api/screenshots/xxx.png)`），
 * 前端渲染时按页面源解析即可，不需要知道服务器的外网地址。
 *
 * 设计要点：
 * - 只读 / 无副作用：只往数据目录写一张图，不碰工作区文件，任何权限模式都可用
 *   （与 web_fetch 一个待遇 —— 相当于「看一眼网页长什么样」）；
 * - 依赖 playwright + chromium（与 web_fetch 的 browser 引擎同源），缺失时返回可读错误，
 *   不让整轮对话崩掉；
 * - playwright 走动态 import，没装也能正常启动，只是用到时才报错；
 * - 文件名用随机 UUID，对外暴露的 `/api/screenshots/...` 按「高熵不可猜测」处理
 *   （服务端生成的高熵 UUID），这样 markdown 里的 `<img>` 在启用鉴权时
 *   也能直接加载（浏览器不会给图片请求带 Authorization 头）。
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { resolveDataDir } from '@fizz/workspace'
import { ensureChromiumReady } from './playwright-browsers'
import { abortableSleep, launchHeadlessChromium, pageErrorMessage } from './headless'

/** 截图落盘子目录（相对数据目录） */
const SCREENSHOT_DIR = 'screenshots'
const DEFAULT_TIMEOUT = 30_000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

type ShotFormat = 'png' | 'jpeg' | 'webp'

/** 把数值夹到 [min,max] 并取整（视口尺寸用） */
function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback
  return Math.max(min, Math.min(max, Math.trunc(v)))
}

/** 构建 screenshot 工具（返回单键 ToolSet，便于在 agent 端与其它工具合并） */
export function buildScreenshotTool(): ToolSet {
  return {
    screenshot: tool({
      description:
        '用无头浏览器打开一个网页并截图，返回图片地址（Markdown 图片语法）。' +
        '适合：让对话直接「看到」某个网页 / 报表 / 图表长什么样，或把页面状态记录进回复。' +
        '返回的是一个相对地址（形如 /api/screenshots/xxx.png），请务必在你的回复里用 Markdown 图片语法引用它，' +
        '例如 `![网页截图](/api/screenshots/xxx.png)`，这样用户才能直接看到图。' +
        '只读、不写任何工作区文件。依赖 playwright + chromium（`npm i playwright && npx playwright install chromium`）。',
      inputSchema: z.object({
        url: z.string().describe('要截图的网页 URL，必须是 http(s)，如 https://example.com'),
        width: z.number().optional().describe('浏览器视口宽度（像素），默认 1280，范围 320–4000'),
        height: z.number().optional().describe('浏览器视口高度（像素），默认 800，范围 240–4000'),
        fullPage: z
          .boolean()
          .optional()
          .describe('是否截取整页（自动滚动到底部，保留完整长图），默认 false（只截首屏视口）'),
        format: z
          .enum(['png', 'jpeg', 'webp'])
          .optional()
          .describe('图片格式，默认 png（无损、体积较大）；jpeg 更小但有损；webp 兼顾'),
        timeoutMs: z.number().optional().describe('页面加载超时（毫秒），默认 30000，最大 60000')
      }),
      execute: async ({ url, width, height, fullPage, format, timeoutMs }, options) => {
        // URL 合法性 + 协议白名单：只允许 http(s)，挡掉 file:/data:/javascript: 等
        let target: URL
        try {
          target = new URL(url)
          if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return `screenshot 拒绝非 http(s) 地址：${url}（协议：${target.protocol}）`
          }
        } catch {
          return `screenshot 收到非法 URL：${url}。请传入完整地址如 https://example.com`
        }
        if (options.abortSignal?.aborted) return 'screenshot 已被中止（未发起请求）。'

        const fmt: ShotFormat = format ?? 'png'
        const timeout = Math.max(1000, Math.min(60_000, Math.trunc(timeoutMs ?? DEFAULT_TIMEOUT)))
        const id = randomUUID()
        const fileName = `${id}.${fmt}`
        const dir = join(resolveDataDir(), SCREENSHOT_DIR)
        const absPath = join(dir, fileName)

        try {
          // 首次使用会在线下载 chromium headless shell（约 150MB）。
          // 同样要接中止：不接的话国内慢网下一次下载能拖几分钟，用户点「停止」没反应。
          await ensureChromiumReady(options.abortSignal)
          // launch 超时 + playwright 未安装的可读报错都收在 headless.ts（与 web_fetch 共用）
          const browser = await launchHeadlessChromium(timeout)
          try {
            const context = await browser.newContext({
              userAgent: UA,
              viewport: {
                width: clampInt(width, 320, 4000, 1280),
                height: clampInt(height, 240, 4000, 800)
              }
            })
            const page = await context.newPage()
            // 用户中止时直接关掉页面，让挂起的 goto / screenshot 抛错退出
            options.abortSignal?.addEventListener(
              'abort',
              () => {
                page.close().catch(() => {})
              },
              { once: true }
            )
            // 先 domcontentloaded 拿到首屏，再等一会儿让 SPA / 懒加载把内容画出来
            await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout })
            await abortableSleep(800, options.abortSignal)
            if (options.abortSignal?.aborted) {
              return 'screenshot 已被用户中止（点了「停止」）。'
            }
            await fs.mkdir(dir, { recursive: true })
            await page.screenshot({
              path: absPath,
              fullPage: fullPage ?? false,
              type: fmt
            })
          } finally {
            await browser.close().catch(() => {})
          }

          const servePath = `/api/screenshots/${fileName}`
          return [
            `截图已生成并保存到服务端。请在你的回复中以 Markdown 图片语法引用它，让用户直接看到图：`,
            `![网页截图](${servePath})`,
            `（图片地址：${servePath}；格式：${fmt}；整页：${fullPage ? '是' : '否'}）`
          ].join('\n')
        } catch (err) {
          // pageErrorMessage：playwright 的报错自带终端样式（Call log 是灰字），必须剥掉
          return `screenshot 截图 ${url} 失败：${pageErrorMessage(err)}`
        }
      }
    })
  }
}
