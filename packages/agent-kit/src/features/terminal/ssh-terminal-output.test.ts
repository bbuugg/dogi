import { describe, expect, it } from 'vitest'
import { createSshTerminalDecoder } from './ssh-terminal-output'

describe('createSshTerminalDecoder', () => {
  it('decodes GBK text split across SSH output chunks', () => {
    const decode = createSshTerminalDecoder('gbk')

    expect(decode(new Uint8Array([0xd6]))).toBe('')
    expect(decode(new Uint8Array([0xd0]))).toBe('中')
  })
})
