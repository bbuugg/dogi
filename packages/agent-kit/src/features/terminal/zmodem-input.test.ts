import { describe, expect, it, vi } from 'vitest'
import { consumeZmodemChunk, createPostAbortDrain, ZMODEM_ABORT_SEQUENCE } from './zmodem-input'

describe('consumeZmodemChunk', () => {
  it('reports parser failures without forwarding the protocol chunk as terminal output', () => {
    const bytes = new Uint8Array([0x1b, 0x5b, 0x7f])
    const consume = vi.fn(() => {
      throw new Error('invalid ZMODEM frame')
    })
    const onError = vi.fn()

    consumeZmodemChunk(bytes, consume, onError)

    expect(consume).toHaveBeenCalledWith(bytes)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'invalid ZMODEM frame' }))
  })

  it('passes a small chunk through in a single call (unchanged behavior)', () => {
    const bytes = new Uint8Array(1024).fill(7)
    const consume = vi.fn()
    consumeZmodemChunk(bytes, consume, vi.fn())
    expect(consume).toHaveBeenCalledTimes(1)
    expect(consume).toHaveBeenCalledWith(bytes)
  })

  it('slices a large chunk below the zmodem.js push.apply overflow threshold (lossless)', () => {
    // 单块 ≥ ~128KB 会让 zmodem.js 内部的 push.apply 抛 RangeError；必须分片喂。
    const bytes = new Uint8Array(300 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    const delivered: number[] = []
    const consume = vi.fn((chunk: Uint8Array) => {
      expect(chunk.length).toBeLessThanOrEqual(32 * 1024)
      delivered.push(...chunk)
    })
    const onError = vi.fn()

    consumeZmodemChunk(bytes, consume, onError)

    expect(onError).not.toHaveBeenCalled()
    expect(consume.mock.calls.length).toBeGreaterThan(1)
    // 分片必须无损：拼回来与原块逐字节相同
    expect(delivered.length).toBe(bytes.length)
    expect(delivered.every((v, i) => v === bytes[i])).toBe(true)
  })

  it('routes a slice failure to onError', () => {
    const bytes = new Uint8Array(100 * 1024)
    const consume = vi.fn(() => {
      throw new Error('boom mid-stream')
    })
    const onError = vi.fn()

    consumeZmodemChunk(bytes, consume, onError)

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom mid-stream' }))
  })
})

describe('ZMODEM_ABORT_SEQUENCE', () => {
  it('is 5×CAN + 5×BS (same bytes as zmodem.js Session.abort())', () => {
    expect(Array.from(ZMODEM_ABORT_SEQUENCE)).toEqual([
      0x18, 0x18, 0x18, 0x18, 0x18, 0x08, 0x08, 0x08, 0x08, 0x08
    ])
  })
})

describe('createPostAbortDrain', () => {
  it('passes bytes through while idle (normal path is unaffected)', () => {
    const drain = createPostAbortDrain(400, 10_000)
    expect(drain.absorb(1000)).toBe(false)
    expect(drain.isActive).toBe(false)
  })

  it('drops bytes once engaged', () => {
    const drain = createPostAbortDrain(400, 10_000)
    drain.engage(1000)
    expect(drain.isActive).toBe(true)
    expect(drain.absorb(1010)).toBe(true)
    expect(drain.absorb(1050)).toBe(true)
  })

  it('auto-releases at the hard cap so bytes never get swallowed forever', () => {
    const drain = createPostAbortDrain(400, 10_000)
    drain.engage(1000)
    // 9999ms in: still draining
    expect(drain.absorb(10_999)).toBe(true)
    // cap reached (1000 + 10000): releases and passes this chunk through
    expect(drain.absorb(11_000)).toBe(false)
    expect(drain.isActive).toBe(false)
    expect(drain.absorb(11_100)).toBe(false)
  })

  it('reports quiet only after the link has been silent for quietMs', () => {
    const drain = createPostAbortDrain(400, 10_000)
    drain.engage(1000)
    expect(drain.quietElapsed(1399)).toBe(false)
    expect(drain.quietElapsed(1400)).toBe(true)
    // incoming bytes keep resetting the quiet window
    expect(drain.absorb(1500)).toBe(true)
    expect(drain.quietElapsed(1800)).toBe(false)
    expect(drain.quietElapsed(1900)).toBe(true)
  })

  it('quietElapsed is false while idle', () => {
    const drain = createPostAbortDrain(400, 10_000)
    expect(drain.quietElapsed(999_999)).toBe(false)
  })

  it('disengage stops draining immediately', () => {
    const drain = createPostAbortDrain(400, 10_000)
    drain.engage(1000)
    expect(drain.absorb(1010)).toBe(true)
    drain.disengage()
    expect(drain.isActive).toBe(false)
    expect(drain.absorb(1020)).toBe(false)
  })
})
