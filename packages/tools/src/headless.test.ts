/**
 * `pageErrorMessage` 的回归测试：playwright 的报错文本不能带着终端样式进工具结果。
 *
 * 防的回归：截图 / 抓取失败时，工具结果里出现 `[2m  - navigating to …[22m` ——
 * playwright 把 `Call log:` 那些行渲染成了灰字（`\u001b[2m…\u001b[22m`），ESC 是不可见字符，
 * 界面上只剩方括号；模型还可能把 `[22m` 当正文照抄。
 */
import { describe, expect, it } from 'vitest'
import { pageErrorMessage } from './headless'

/** 用户真遇到的那条：本地端口没人监听 */
const GOTO_REFUSED = [
  'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5174/',
  '\u001b[2mCall log:\u001b[22m',
  '\u001b[2m  - navigating to "http://localhost:5174/", waiting until "domcontentloaded"\u001b[22m'
].join('\n')

describe('pageErrorMessage', () => {
  it('剥掉 Call log 里的灰字样式，正文与换行保留', () => {
    const msg = pageErrorMessage(new Error(GOTO_REFUSED))
    expect(msg).not.toContain('\u001b')
    expect(msg).toContain('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5174/')
    expect(msg).toContain('Call log:')
    expect(msg).toContain('- navigating to "http://localhost:5174/"')
    expect(msg.split('\n')).toHaveLength(3)
  })

  it('没有转义序列的报错原样返回（只去首尾空白）', () => {
    expect(pageErrorMessage(new Error('  page.goto: Timeout 30000ms exceeded\n'))).toBe(
      'page.goto: Timeout 30000ms exceeded'
    )
  })

  it('非 Error 的抛出值也能处理', () => {
    expect(pageErrorMessage('\u001b[31mboom\u001b[39m')).toBe('boom')
  })
})
