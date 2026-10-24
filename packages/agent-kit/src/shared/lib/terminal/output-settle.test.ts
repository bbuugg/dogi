import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForNewOutput, waitForOutputToSettle, type OutputProbe } from './output-settle'

/** 假终端：只暴露工具真正依赖的两个计数 */
function fakeProbe(): OutputProbe & { emit: () => void } {
  const state = { seq: 0, at: 0 }
  return {
    outputSeq: () => state.seq,
    lastOutputAt: () => state.at,
    emit: () => {
      state.seq += 1
      state.at = Date.now()
    }
  }
}

describe('waitForOutputToSettle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('快命令：输出停下 idleMs 就返回，不等满上限', async () => {
    const probe = fakeProbe()
    // 写命令后 100ms 来了回显 + 输出，之后彻底安静
    setTimeout(() => probe.emit(), 100)

    const startedAt = Date.now()
    const settled = waitForOutputToSettle(probe, 0, { idleMs: 600, maxMs: 3000 })
    await vi.advanceTimersByTimeAsync(699)
    // 699ms 时安静了 599ms，还差 1ms
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toBe('idle')
    // 100ms 有输出 + 600ms 安静 = 700ms，远早于 3000ms 的上限
    expect(Date.now() - startedAt).toBe(700)
  })

  it('一直在输出：到上限按 timeout 收场', async () => {
    const probe = fakeProbe()
    const timer = setInterval(() => probe.emit(), 150)

    const settled = waitForOutputToSettle(probe, 0, { idleMs: 600, maxMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await settled).toBe('timeout')
    clearInterval(timer)
  })

  it('一直没有输出：不会误判成 idle，等到上限', async () => {
    const probe = fakeProbe()

    const settled = waitForOutputToSettle(probe, 0, { idleMs: 600, maxMs: 800 })
    await vi.advanceTimersByTimeAsync(799)
    let done = false
    void settled.then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toBe('timeout')
  })

  it('baseline 之后的输出才算数：之前已有的输出不会让它提前返回', async () => {
    const probe = fakeProbe()
    probe.emit()
    probe.emit()

    const settled = waitForOutputToSettle(probe, 2, { idleMs: 300, maxMs: 600 })
    await vi.advanceTimersByTimeAsync(600)
    expect(await settled).toBe('timeout')
  })

  it('maxMs 为 0：立刻按 timeout 返回（与从前 sleep(0) 一致）', async () => {
    const probe = fakeProbe()
    expect(await waitForOutputToSettle(probe, 0, { idleMs: 600, maxMs: 0 })).toBe('timeout')
  })

  it('idleMs 比 maxMs 还长：上限先到，按 timeout 收场', async () => {
    const probe = fakeProbe()
    setTimeout(() => probe.emit(), 10)

    const settled = waitForOutputToSettle(probe, 0, { idleMs: 5000, maxMs: 300 })
    await vi.advanceTimersByTimeAsync(300)
    expect(await settled).toBe('timeout')
  })

  /**
   * 长任务回归用例：构建 / 安装这类命令本来就一顿一顿地打日志。
   * 固定 600ms 窗口会在 6.6 秒那处「600ms 没动静」直接收工，模型以为跑完了，
   * 转头去连读 `read_terminal_output`（用户看到的「快速不停地读取」）。
   */
  it('idleMs 传函数：跑久之后改用放大窗口，1.2 秒的停顿不算「停」', async () => {
    const probe = fakeProbe()
    // 0~6000ms 每 300ms 一段输出（600ms 窗口一直不成立）
    const fast = setInterval(() => probe.emit(), 300)
    setTimeout(() => clearInterval(fast), 6000)
    // 6 秒之后停 1.2 秒再来一段：600ms 窗口会判「停」，2000ms 窗口不会
    setTimeout(() => probe.emit(), 7200)

    const settled = waitForOutputToSettle(probe, 0, {
      idleMs: (elapsed) => (elapsed >= 5000 ? 2000 : 600),
      maxMs: 20_000
    })
    // 6600ms 处（6000 之后安静了 600ms）**不该**收场
    await vi.advanceTimersByTimeAsync(6600)
    let done = false
    void settled.then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    // 7200 来了输出，再安静 2000ms → 9200 收场
    await vi.advanceTimersByTimeAsync(2600)
    expect(await settled).toBe('idle')
  })
})

describe('waitForNewOutput', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('出现新输出就立刻返回 true，不等安静', async () => {
    const probe = fakeProbe()
    setTimeout(() => probe.emit(), 200)

    const appeared = waitForNewOutput(probe, 0, { maxMs: 5000 })
    await vi.advanceTimersByTimeAsync(300)
    expect(await appeared).toBe(true)
  })

  it('基线之前就有的输出不算：一直没新输出就到上限返回 false', async () => {
    const probe = fakeProbe()
    probe.emit()
    probe.emit()

    const appeared = waitForNewOutput(probe, 2, { maxMs: 500 })
    await vi.advanceTimersByTimeAsync(500)
    expect(await appeared).toBe(false)
  })
})
