/**
 * 落盘文件名的取名规则。
 *
 * 这条规则值得单测：同一个「下载」入口要吃两类图 —— 附件（自带 `name`，常带扩展名）和
 * Markdown 正文里的外链图（只有一个 URL，末尾可能连扩展名都没有）。取错了用户拿到的是
 * `image.png` 或者一个打不开的扩展名，而他只看到「下载了但文件名不对」。
 */
import { describe, expect, it } from 'vitest'
import { imageExtOf, imageFileNameOf } from './image-download'

describe('imageExtOf', () => {
  it('按 MIME 猜扩展名，认不出的按 png', () => {
    expect(imageExtOf('image/jpeg')).toBe('jpg')
    expect(imageExtOf('image/gif')).toBe('gif')
    expect(imageExtOf('image/webp')).toBe('webp')
    expect(imageExtOf('image/svg+xml')).toBe('svg')
    expect(imageExtOf('')).toBe('png')
    expect(imageExtOf('application/octet-stream')).toBe('png')
  })
})

describe('imageFileNameOf', () => {
  it('附件名自带扩展名 → 原样用（不猜、不改写）', () => {
    expect(imageFileNameOf('blob:http://x/abc', 'image/jpeg', '截图 2026-10-27.png')).toBe(
      '截图 2026-10-27.png'
    )
  })

  it('URL 末段带扩展名 → 用它', () => {
    expect(imageFileNameOf('/api/uploads/abc.PNG?x=1', 'image/png', 'image')).toBe('abc.PNG')
    expect(imageFileNameOf('https://cdn.example.com/a/b/c.webp', 'image/webp')).toBe('c.webp')
  })

  it('都没有扩展名 → 名字 + MIME 补一个', () => {
    expect(imageFileNameOf('/api/uploads/abc', 'image/jpeg', '附件')).toBe('附件.jpg')
    expect(imageFileNameOf('data:image/png;base64,AAAA', 'image/png', 'pasted')).toBe('pasted.png')
  })

  it('连名字都没有 → 退回 image.<ext>', () => {
    expect(imageFileNameOf('', 'image/gif')).toBe('image.gif')
  })

  it('名字里带点但不是扩展名（alt 里的句号）→ 不当扩展名用', () => {
    expect(imageFileNameOf('/api/uploads/x', 'image/png', 'a.b 的截图')).toBe('a.b 的截图.png')
  })
})
