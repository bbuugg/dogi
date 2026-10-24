import { describe, expect, it } from 'vitest'
import { matchPublicDomain, parsePublicHost } from './public-host'

const DOMAIN = 'app.example.com'

describe('parsePublicHost —— 公网入口的 Host 判定', () => {
  it('正常子域取出 slug', () => {
    expect(parsePublicHost('abc123.app.example.com', DOMAIN)).toBe('abc123')
  })

  it('带端口也认（Host 头常带端口）', () => {
    expect(parsePublicHost('abc123.app.example.com:8080', DOMAIN)).toBe('abc123')
  })

  it('大小写不敏感', () => {
    expect(parsePublicHost('AbC123.App.Example.COM', DOMAIN)).toBe('abc123')
  })

  it('裸域名 404（回落就等于把工作台挂到公网）', () => {
    expect(parsePublicHost('app.example.com', DOMAIN)).toBeNull()
  })

  it('多级子域 404（只认一层）', () => {
    expect(parsePublicHost('a.b.app.example.com', DOMAIN)).toBeNull()
  })

  it('完全不相干的 Host 404', () => {
    expect(parsePublicHost('localhost:3000', DOMAIN)).toBeNull()
  })

  it('后缀像但不是子域（`xapp.example.com`）也 404', () => {
    expect(parsePublicHost('xapp.example.com', DOMAIN)).toBeNull()
  })
})

describe('matchPublicDomain —— 多个配置域名的匹配', () => {
  const DOMAINS = ['app.example.com', 'preview.foo.com']

  it('命中任意一个域名都返回 slug 与它命中的域名', () => {
    expect(matchPublicDomain('abc123.preview.foo.com', DOMAINS)).toEqual({
      slug: 'abc123',
      domain: 'preview.foo.com'
    })
  })

  it('命中第一个域名', () => {
    expect(matchPublicDomain('abc.app.example.com:8080', DOMAINS)).toEqual({
      slug: 'abc',
      domain: 'app.example.com'
    })
  })

  it('一个都不命中 → null', () => {
    expect(matchPublicDomain('abc.other.com', DOMAINS)).toBeNull()
  })

  it('域名清单为空 → null（公网关闭时全落 404）', () => {
    expect(matchPublicDomain('abc.app.example.com', [])).toBeNull()
  })

  it('裸域名 / 多级子域同样不认', () => {
    expect(matchPublicDomain('foo.com', DOMAINS)).toBeNull()
    expect(matchPublicDomain('a.b.preview.foo.com', DOMAINS)).toBeNull()
  })
})
