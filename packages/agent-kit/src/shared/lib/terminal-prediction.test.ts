/**
 * 命令行跟踪（`trackInputLine`）的行为契约。
 *
 * 盯的是用户报过的那条路径：`docker ps` → 左移到 `docker` 后面 → 删掉一个字符 →
 * 再敲回去。旧实现把方向键当成「不可跟踪」，一按就把整行缓冲清空，于是预测拿最后敲的
 * 一个字符去套历史，给出 `rm` / `rsync` 这种毫不相干的建议。
 *
 * 另一半同样重要：**认不出的键必须返回 null**（返回一条猜出来的行比返回 null 更糟，
 * 预测会拿一条 shell 里根本不存在的行去匹配）。
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_INPUT_LINE, isTrackableInput, trackInputLine, type InputLine } from './terminal-prediction'

/** 把一串输入事件依次套到跟踪行上（遇到 null 就是「调用方清空」） */
function feed(events: string[], start: InputLine = EMPTY_INPUT_LINE): InputLine {
  let line = start
  for (const data of events) {
    const next = trackInputLine(line, data)
    if (!next) throw new Error(`不可跟踪：${JSON.stringify(data)}`)
    line = next
  }
  return line
}

const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'

describe('trackInputLine', () => {
  it('行尾键入累积，退格删末尾', () => {
    expect(feed(['d', 'o', 'c'])).toEqual({ text: 'doc', caret: 3 })
    expect(feed(['d', 'o', 'c', '\x7f'])).toEqual({ text: 'do', caret: 2 })
  })

  it('左移进行中间后编辑，整行文本仍然完整（用户报的那条路径）', () => {
    // docker ps，光标挪到 docker 后面（左移 3 次）
    const line = feed(['docker ps', LEFT, LEFT, LEFT])
    expect(line).toEqual({ text: 'docker ps', caret: 6 })
    // 删掉 r 再敲回来：文本回到 docker ps，光标停在 r 后面 —— 不是只剩一个 r
    const back = trackInputLine(line, '\x7f')
    expect(back).toEqual({ text: 'docke ps', caret: 5 })
    const retyped = trackInputLine(back!, 'r')
    expect(retyped).toEqual({ text: 'docker ps', caret: 6 })
  })

  it('光标越界被夹住（行首再左移 / 行尾再右移都不动）', () => {
    expect(feed(['ab', LEFT, LEFT, LEFT])).toEqual({ text: 'ab', caret: 0 })
    expect(feed(['ab', RIGHT, RIGHT])).toEqual({ text: 'ab', caret: 2 })
  })

  it('Home / End（含 Ctrl+A / Ctrl+E）跳到行首行尾', () => {
    expect(feed(['abc', '\x1b[H'])).toEqual({ text: 'abc', caret: 0 })
    expect(feed(['abc', '\x1b[H', '\x05'])).toEqual({ text: 'abc', caret: 3 })
    expect(feed(['abc', '\x1b[1~'])).toEqual({ text: 'abc', caret: 0 })
    expect(feed(['abc', '\x1b[4~'])).toEqual({ text: 'abc', caret: 3 })
  })

  it('Delete（\\x1b[3~）删光标处的字符，不动光标', () => {
    expect(feed(['abc', LEFT, '\x1b[3~'])).toEqual({ text: 'ab', caret: 2 })
  })

  it('在行中间插入文本（粘贴一段也照此处理）', () => {
    expect(feed(['ac', LEFT, 'b'])).toEqual({ text: 'abc', caret: 2 })
  })

  it('应用光标模式的方向键（DECCKM，\\x1bOD / \\x1bOC）同样按光标移动处理', () => {
    expect(feed(['ab', '\x1bOD'])).toEqual({ text: 'ab', caret: 1 })
    expect(feed(['ab', '\x1bOD', '\x1bOC'])).toEqual({ text: 'ab', caret: 2 })
  })

  it('认不出的输入一律 null：Tab / Ctrl 组合键 / 历史召回 / 裸 Esc', () => {
    for (const data of ['\t', '\x12', '\x03', '\x1b[A', '\x1bOA', '\x1b', '\x1b[1;5D', 'x\n']) {
      expect(trackInputLine({ text: 'abc', caret: 3 }, data), JSON.stringify(data)).toBeNull()
    }
  })
})

describe('isTrackableInput', () => {
  it('可打印文本为真，任何控制字符为假', () => {
    expect(isTrackableInput('docker ps')).toBe(true)
    expect(isTrackableInput('中文')).toBe(true)
    expect(isTrackableInput('\x1b[D')).toBe(false)
    expect(isTrackableInput('\x7f')).toBe(false)
    expect(isTrackableInput('')).toBe(false)
  })
})
