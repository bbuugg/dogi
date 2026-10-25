/**
 * 文件管理器的路径工具：Windows / POSIX 两种写法都要对得上。
 *
 * 为什么单独钉这些：拖拽移动的「能不能落在这个目录上」全靠 `isInsideDir`，写错一个
 * 分隔符的后果是**静默**的 —— 要么文件夹不高亮（拖不进去），要么把目录挪进它自己的
 * 子目录里（服务端报错、用户一头雾水）。两个平台的路径又只差一个字符，肉眼 review
 * 不出来，所以按平台各测一遍。
 */
import { describe, expect, it } from 'vitest'
import { breadcrumbOf, dirOf, isInsideDir, joinFsPath, nameOf } from './fm-paths'

describe('dirOf：取所在目录', () => {
  it('Windows', () => {
    expect(dirOf('C:\\a\\b')).toBe('C:\\a')
    // 盘符根必须带上那根分隔符，否则会变成相对盘符 `C:`
    expect(dirOf('C:\\a')).toBe('C:\\')
    expect(dirOf('C:\\')).toBe('C:\\')
  })

  it('POSIX', () => {
    expect(dirOf('/a/b')).toBe('/a')
    expect(dirOf('/a')).toBe('/')
    expect(dirOf('/')).toBe('/')
  })
})

describe('nameOf：取最后一段', () => {
  it('两种分隔符都认', () => {
    expect(nameOf('C:\\a\\b.txt')).toBe('b.txt')
    expect(nameOf('/a/b.txt')).toBe('b.txt')
    expect(nameOf('b.txt')).toBe('b.txt')
  })
})

describe('isInsideDir：拖拽落点判定', () => {
  it('相等算「在里面」（不能拖进自己）', () => {
    expect(isInsideDir('C:\\a', 'C:\\a')).toBe(true)
    expect(isInsideDir('C:\\a\\', 'C:\\a')).toBe(true)
    expect(isInsideDir('/', '/')).toBe(true)
  })

  it('子目录算在里面', () => {
    expect(isInsideDir('C:\\a', 'C:\\a\\b')).toBe(true)
    expect(isInsideDir('/a', '/a/b')).toBe(true)
    // 反斜杠写法也要认（服务端回显可能是另一种）
    expect(isInsideDir('/a', '/a\\b')).toBe(true)
  })

  it('同名前缀不算（`/a` 与 `/ab` 是两个地方）', () => {
    expect(isInsideDir('/a', '/ab')).toBe(false)
    expect(isInsideDir('C:\\a', 'C:\\ab')).toBe(false)
  })

  it('父目录不算在里面', () => {
    expect(isInsideDir('/a/b', '/a')).toBe(false)
  })

  it('路径里的正则元字符不会被当成通配', () => {
    // 不加转义的话 `.` 会匹配任意字符，`/a.b/x` 会被误判成在 `/a.b` 里
    expect(isInsideDir('/a.b', '/axb')).toBe(false)
    expect(isInsideDir('/a.b', '/a.b/c')).toBe(true)
  })
})

describe('joinFsPath：拼子路径保持分隔符风格', () => {
  it('Windows 目录用反斜杠', () => {
    expect(joinFsPath('C:\\a', 'b')).toBe('C:\\a\\b')
    expect(joinFsPath('C:\\', 'b')).toBe('C:\\b')
  })

  it('POSIX 目录用斜杠', () => {
    expect(joinFsPath('/a', 'b')).toBe('/a/b')
    expect(joinFsPath('/', 'b')).toBe('/b')
  })
})

describe('breadcrumbOf：面包屑', () => {
  it('Windows 首段是盘符，且带分隔符', () => {
    expect(breadcrumbOf('C:\\a\\b')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'a', path: 'C:\\a' },
      { label: 'b', path: 'C:\\a\\b' }
    ])
  })

  it('POSIX 从根开始', () => {
    expect(breadcrumbOf('/a/b')).toEqual([
      { label: 'a', path: '/a' },
      { label: 'b', path: '/a/b' }
    ])
  })

  it('空路径没有面包屑', () => {
    expect(breadcrumbOf('')).toEqual([])
  })
})
