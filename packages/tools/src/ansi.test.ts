/**
 * `ansi.ts` 的回归测试：命令输出里的终端控制字节不能漏进**工具结果**与**后台任务日志**。
 *
 * 防的是两条真出现过的回归：
 *
 * 1. dev server 的启动横幅（`\u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m: …`）原样进了
 *    后台任务日志，界面是纯文本渲染，用户看到的是 `[32m➜[39m`。命令明明是管道跑的，
 *    颜色却还在 —— `npm run` 会给脚本注入 `FORCE_COLOR`，不能指望 isTTY 判定。
 * 2. 实时输出是**按 chunk 转发**的，转义序列被块边界劈开时（`\u001b[3` + `2m`），
 *    逐块跑正则只能剥掉后半截，前半截会一直显示在那张卡片上。
 */
import { describe, expect, it } from 'vitest'
import { cleanLogLine, createAnsiStripper, stripAnsi } from './ansi'

/** vite 启动横幅的原始字节（npm run 下真的长这样） */
const VITE_BANNER =
  '\u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m'

describe('stripAnsi', () => {
  it('剥掉 vite 启动横幅的颜色与加粗', () => {
    expect(stripAnsi(VITE_BANNER)).toBe('➜  Local:   http://localhost:5173/')
  })

  it('剥掉清行 / 光标移动这类非颜色 CSI', () => {
    expect(stripAnsi('\u001b[2K\u001b[1G正在编译…')).toBe('正在编译…')
    expect(stripAnsi('\u001b[?25l请稍候\u001b[?25h')).toBe('请稍候')
  })

  it('剥掉 256 色与 OSC 超链接，链接文字保留', () => {
    expect(stripAnsi('\u001b[38;5;208m警告\u001b[0m')).toBe('警告')
    expect(stripAnsi('\u001b]8;;https://example.com\u0007文档\u001b]8;;\u0007')).toBe('文档')
  })

  it('没有 ESC 的方括号是正文，不能动', () => {
    // 模型 / 用户真的会打出这种串，删掉就成了篡改输出
    expect(stripAnsi('[32m不是颜色，是正文[0m')).toBe('[32m不是颜色，是正文[0m')
  })

  it('普通文本原样返回（含中文与换行）', () => {
    const text = '编译完成\n没有 warning\n'
    expect(stripAnsi(text)).toBe(text)
  })
})

describe('createAnsiStripper', () => {
  it('跨 chunk 的转义序列不会漏出半截', () => {
    const feed = createAnsiStripper()
    const out = ['\u001b[3', '2m➜ \u001b[39', 'm ok'].map(feed).join('')
    expect(out).toBe('➜  ok')
  })

  it('整段一次喂入与逐字符喂入结果一致', () => {
    const whole = stripAnsi(VITE_BANNER)
    const feed = createAnsiStripper()
    expect([...VITE_BANNER].map(feed).join('')).toBe(whole)
  })

  it('没有 ESC 的 chunk 直接透传', () => {
    const feed = createAnsiStripper()
    expect(feed('hello ')).toBe('hello ')
    expect(feed('world')).toBe('world')
  })

  it('永不收尾的 OSC 不会把输出堵死', () => {
    const feed = createAnsiStripper()
    const out = feed(`\u001b]8;;${'x'.repeat(600)}`)
    // 超过扣留上限就放弃等待，把能剥的剥掉放出去（不能无限期吞掉后面的正文）
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('cleanLogLine', () => {
  it('只有转义的行剥完是空的（日志里不该出现这种空白行）', () => {
    expect(cleanLogLine('\u001b[2K\u001b[1G')).toBe('')
    expect(cleanLogLine('   \u001b[0m  ')).toBe('')
  })

  it('正文行剥完照常保留', () => {
    expect(cleanLogLine(`  ${VITE_BANNER}  `)).toBe('➜  Local:   http://localhost:5173/')
  })
})
