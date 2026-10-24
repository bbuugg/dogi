import { describe, expect, it } from 'vitest'
import { buildShikiTheme, type SyntaxColors } from './code-theme'

const COLORS: SyntaxColors = {
  keyword: '#112233',
  string: '#223344',
  number: '#334455',
  comment: '#445566',
  function: '#556677',
  type: '#667788',
  variable: '#778899',
  punctuation: '#8899aa'
}

describe('buildShikiTheme', () => {
  const theme = buildShikiTheme('dark', COLORS, '#0a0a0a', '#eeeeee')

  it('声明明暗类型与前景/背景', () => {
    expect(theme.type).toBe('dark')
    expect(theme.colors?.['editor.foreground']).toBe('#eeeeee')
    expect(theme.colors?.['editor.background']).toBe('#0a0a0a')
  })

  it('关键字 scope 用传入色', () => {
    const rule = theme.settings?.find((item) => item.scope?.includes('keyword'))
    expect(rule?.settings?.foreground).toBe('#112233')
  })

  it('注释色不等于底色（高对比 / 终端主题可读性底线）', () => {
    const rule = theme.settings?.find((item) => item.scope?.includes('comment'))
    expect(rule?.settings?.foreground).not.toBe('#0a0a0a')
  })

  // `@streamdown/code` 的高亮器 / token 缓存都以主题名为 key：名字不变的话，换主题后
  // 第二次高亮直接返回旧 token，聊天里的代码块永远停在首次配色。
  it('主题名跟着颜色走', () => {
    const changed = buildShikiTheme('dark', { ...COLORS, keyword: '#ff0000' }, '#0a0a0a', '#eeeeee')
    expect(changed.name).not.toBe(theme.name)
  })

  it('同一套颜色得到同一个名字（缓存不会按调用次数增长）', () => {
    const same = buildShikiTheme('dark', { ...COLORS }, '#0a0a0a', '#eeeeee')
    expect(same.name).toBe(theme.name)
  })
})
