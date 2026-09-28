import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import type { BrowserRunResult } from '@shared/types'

/**
 * 自动化脚本执行。
 *
 * 为什么不用子进程：打包后脚本要 `import { chromium } from 'playwright'`，
 * 而 asar 里的模块既不能被外部 node 解析、机器上也不一定有 node。
 * 改成把 Playwright 对象**注入**进脚本作用域（录制产出的代码本来就只用 `page`），
 * 脚本就不需要任何 import —— 见 AGENTS.md 的浏览器自动化一节。
 */

/** 注入给脚本的作用域 */
export interface ScriptScope {
  page: Page
  context: BrowserContext
  browser: Browser
  expect: ReturnType<typeof createExpect>
  log: (message: string) => void
}

/** 脚本执行结果。形状与渲染端共用（@shared/types 的 BrowserRunResult），IPC 回包直接就是它 */
export type RunResult = BrowserRunResult

/** 默认单步超时：比 Playwright 默认的 30s 短，停止按钮才来得及响应 */
const STEP_TIMEOUT = 15_000

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

/**
 * 判断代码是不是「一行一个独立语句」的形态（官方 recorder 的产出就是这样）。
 *
 * 只有满足全部条件才走逐行模式，否则整体执行 —— 误判的代价是手写的
 * 多行语句（for 块、对象字面量）被拆坏，所以判定要保守。
 */
export function isLinePerStatement(code: string): boolean {
  const lines = code
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
  if (lines.length === 0) return false

  let depth = 0
  for (const line of lines) {
    // 括号必须在本行内自平衡：跨行的语句（对象字面量、多行调用）不满足
    let local = 0
    let inSingle = false
    let inDouble = false
    let inTemplate = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      const prev = line[i - 1]
      if (prev === '\\') continue
      if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle
      else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble
      else if (!inSingle && !inDouble && ch === '`') inTemplate = !inTemplate
      else if (!inSingle && !inDouble && !inTemplate) {
        if (ch === '(' || ch === '{' || ch === '[') local++
        else if (ch === ')' || ch === '}' || ch === ']') local--
      }
    }
    if (local !== 0) return false
    depth += local
    if (!line.endsWith(';') && !line.endsWith('}')) return false
  }
  return depth === 0
}

/** 极简 expect：覆盖录制断言最常用的几个，避免脚本里 `expect is not defined` */
export function createExpect(defaultTimeout = STEP_TIMEOUT) {
  const fail = (message: string): never => {
    throw new Error(message)
  }
  const match = (actual: string, expected: string | RegExp): boolean =>
    expected instanceof RegExp ? expected.test(actual) : actual.includes(expected)

  return (target: Locator | Page | string) => {
    const isLocator = typeof target === 'object' && 'waitFor' in target
    return {
      async toBeVisible(): Promise<void> {
        if (!isLocator) return fail('toBeVisible 需要传入 locator')
        await (target as Locator).waitFor({ state: 'visible', timeout: defaultTimeout })
      },
      async toBeHidden(): Promise<void> {
        if (!isLocator) return fail('toBeHidden 需要传入 locator')
        await (target as Locator).waitFor({ state: 'hidden', timeout: defaultTimeout })
      },
      async toHaveText(expected: string | RegExp): Promise<void> {
        if (!isLocator) return fail('toHaveText 需要传入 locator')
        const text = (await (target as Locator).textContent({ timeout: defaultTimeout })) ?? ''
        if (!match(text, expected)) fail(`期望文本 ${String(expected)}，实际 ${JSON.stringify(text)}`)
      },
      async toContainText(expected: string | RegExp): Promise<void> {
        if (!isLocator) return fail('toContainText 需要传入 locator')
        const text = (await (target as Locator).textContent({ timeout: defaultTimeout })) ?? ''
        if (!match(text, expected)) fail(`期望包含 ${String(expected)}，实际 ${JSON.stringify(text)}`)
      },
      async toHaveValue(expected: string | RegExp): Promise<void> {
        if (!isLocator) return fail('toHaveValue 需要传入 locator')
        const value = await (target as Locator).inputValue({ timeout: defaultTimeout })
        if (!match(value, expected)) fail(`期望值 ${String(expected)}，实际 ${JSON.stringify(value)}`)
      },
      async toHaveURL(expected: string | RegExp): Promise<void> {
        const url = typeof target === 'string' ? target : (target as Page).url()
        if (!match(url, expected)) fail(`期望地址 ${String(expected)}，实际 ${url}`)
      }
    }
  }
}

/**
 * 执行脚本。
 *
 * `shouldAbort` 在每一步之前检查 —— 停止按钮只保证「不再执行下一步」，
 * 正在 await 的那一步要等它自己超时（Playwright 的等待无法从外部取消，
 * 强行关 context 会把用户的浏览器会话一起毁掉）。
 */
export async function runScript(
  code: string,
  scope: Omit<ScriptScope, 'expect'>,
  hooks: {
    onStep?: (index: number, total: number, line: string) => void
    shouldAbort?: () => boolean
  } = {}
): Promise<RunResult> {
  const expect = createExpect()
  const { page, context, browser, log } = scope
  const { onStep, shouldAbort } = hooks

  // 运行时收紧超时，让停止按钮能较快生效
  page.setDefaultTimeout(STEP_TIMEOUT)
  page.setDefaultNavigationTimeout(STEP_TIMEOUT)

  if (isLinePerStatement(code)) {
    const lines = code
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'))
    for (const [i, line] of lines.entries()) {
      if (shouldAbort?.()) {
        return { ok: false, steps: i, aborted: true, error: '已停止' }
      }
      onStep?.(i + 1, lines.length, line)
      try {
        const step = new AsyncFunction('page', 'context', 'browser', 'expect', 'log', line)
        await step(page, context, browser, expect, log)
      } catch (err) {
        return { ok: false, steps: i + 1, failedStep: i + 1, error: errorText(err) }
      }
    }
    return { ok: true, steps: lines.length }
  }

  // 整体模式：手写的多行脚本，只能整体执行
  onStep?.(1, 1, '（多行脚本整体执行）')
  try {
    const whole = new AsyncFunction('page', 'context', 'browser', 'expect', 'log', code)
    await whole(page, context, browser, expect, log)
    return { ok: true, steps: 1 }
  } catch (err) {
    return { ok: false, steps: 1, failedStep: 1, error: errorText(err) }
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    // Playwright 的错误第一行是「Error: locator.click: Timeout 15000ms exceeded」，
    // 后面跟一大段调用日志 —— 全塞进面板没人看，只留前几行
    return err.message.split('\n').slice(0, 3).join('\n').trim()
  }
  return String(err)
}
