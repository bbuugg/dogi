/**
 * 这些用例在防同一件事的回归：**Windows 管道里的 GBK 输出被当 UTF-8 硬解成乱码**。
 *
 * 背景见 `output-decoder.ts` 头注释：Git Bash 吐 UTF-8，命令里显式调的 powershell 5.1
 * 吐 GBK，同一条流里两种编码都可能出现。
 */
import { describe, expect, it } from 'vitest'
import { createOutputDecoder } from './output-decoder'

/** GBK 编码的「中文」「错误」——中文 Windows 上 powershell 的典型输出字节 */
const GBK_ZHONG = [0xd6, 0xd0]
const GBK_WEN = [0xce, 0xc4]
const GBK_CUO = [0xb4, 0xed]
const GBK_WU = [0xce, 0xf3]

describe('createOutputDecoder', () => {
  it('passes plain ASCII through unchanged', () => {
    const decode = createOutputDecoder()
    expect(decode.decode(Buffer.from('hello\n'))).toBe('hello\n')
    expect(decode.flush()).toBe('')
  })

  it('decodes UTF-8 split across chunks (half a wide char)', () => {
    const decode = createOutputDecoder()
    const bytes = Buffer.from('中文\n', 'utf8')

    expect(decode.decode(bytes.subarray(0, 4))).toBe('')
    expect(decode.decode(bytes.subarray(4))).toBe('中文\n')
  })

  it('decodes GBK output as GBK instead of mojibake', () => {
    const decode = createOutputDecoder()
    const line = Buffer.from([...GBK_ZHONG, ...GBK_WEN, 0x0a])

    expect(decode.decode(line)).toBe('中文\n')
  })

  it('decodes GBK split across chunks (half a wide char)', () => {
    const decode = createOutputDecoder()

    // 第一个字节单独到达：此时还看不出编码，必须一个字符都不吐
    expect(decode.decode(Buffer.from([GBK_CUO[0]]))).toBe('')
    expect(decode.decode(Buffer.from([GBK_CUO[1], ...GBK_WU, 0x0a]))).toBe('错误\n')
  })

  it('keeps UTF-8 lines and GBK lines side by side', () => {
    const decode = createOutputDecoder()
    const chunk = Buffer.concat([
      Buffer.from('ok\n', 'utf8'),
      Buffer.from([...GBK_CUO, ...GBK_WU, 0x0a])
    ])

    expect(decode.decode(chunk)).toBe('ok\n错误\n')
  })

  it('keeps the trailing bytes until flush when a line has no newline', () => {
    const decode = createOutputDecoder()

    expect(decode.decode(Buffer.from('progress 42%'))).toBe('')
    expect(decode.flush()).toBe('progress 42%')
  })

  it('decodes a trailing GBK line on flush', () => {
    const decode = createOutputDecoder()

    expect(decode.decode(Buffer.from([...GBK_CUO, ...GBK_WU]))).toBe('')
    expect(decode.flush()).toBe('错误')
  })

  it('treats \\r as a line boundary too (progress bars)', () => {
    const decode = createOutputDecoder()

    expect(decode.decode(Buffer.from('10%\r20%'))).toBe('10%\r')
    expect(decode.flush()).toBe('20%')
  })

  it('never splits a wide char at the 64KB forced cut (min.js / long single line)', () => {
    const decode = createOutputDecoder()
    // 64KB 上限正好落在「中」的第一个字节上 —— 硬切的话这段会被判成 GBK，整段变乱码
    const head = Buffer.concat([Buffer.alloc(64 * 1024 - 1, 0x61), Buffer.from([0xe4])])

    expect(decode.decode(head)).toBe('a'.repeat(64 * 1024 - 1))
    expect(decode.decode(Buffer.from([0xb8, 0xad, 0x0a]))).toBe('中\n')
  })

  it('keeps CRLF and ESC bytes untouched (decoding must not rewrite content)', () => {
    const decode = createOutputDecoder()

    // `grep` 到 CRLF 文件：`\r` 不丢；ANSI 剥不剥由 ansi.ts 决定，这一层只解码
    expect(decode.decode(Buffer.from('a\r\nb\u001b[0m\n'))).toBe('a\r\nb\u001b[0m\n')
  })
})
