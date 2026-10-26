/**
 * 任务管理器采集层的解析测试。
 *
 * 这里测的全是「写错了也不会报错、只会在界面上显示一堆怪数字」的地方：
 *
 * - `parseCpuTime`：`1:02` 是 1 分 2 秒，`1:02:03` 是 1 时 2 分 3 秒。少判断段数，
 *   「跑了 3 分钟的进程」会被算成 3 小时 —— 瞬时 CPU 直接变成 0，而且看不出来是错的。
 * - `parseMemKb`：`tasklist` 的内存列带千分位（`12,345 K`），而千分位字符**跟系统区域
 *   设置走**，按逗号切在某些机器上会把 `12.345 K` 切成两段。
 * - `parseCsvLine`：进程名里可以有逗号（`foo, bar.exe`），`split(',')` 会让整行字段错位
 *   —— 于是「用户名」列显示的其实是 CPU 时间。
 * - `parsePsOutput`：`args` 里必然有空格，所以它必须是**最后一个**字段；列序错一位，
 *   `ppid` 就会变成用户名。
 */
import { describe, expect, it } from 'vitest'
import { parseCpuTime, parseCsvLine, parseMemKb } from './raw'
import { parsePsOutput } from './collect-posix'
import { parseCimProcesses, parseTasklistCsv } from './collect-win32'
import { stateOf } from './index'

describe('parseCpuTime —— 累计 CPU 时间', () => {
  it('识别 mm:ss / hh:mm:ss / d-hh:mm:ss 三种长度', () => {
    expect(parseCpuTime('0:00:00')).toBe(0)
    expect(parseCpuTime('0:01:23')).toBe(83)
    // 两段是「分:秒」而不是「时:分」—— 这条错了会差 60 倍
    expect(parseCpuTime('1:02')).toBe(62)
    expect(parseCpuTime('10:00')).toBe(600)
  })

  it('认得 macOS 的百分之一秒后缀', () => {
    expect(parseCpuTime('0:01.50')).toBeCloseTo(1.5, 5)
    expect(parseCpuTime('1:00:00.25')).toBeCloseTo(3600.25, 5)
  })

  it('认得超过一天的天数段', () => {
    expect(parseCpuTime('2-03:04:05')).toBe(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5)
  })

  it('空串 / 乱码都给 0，不抛', () => {
    expect(parseCpuTime('')).toBe(0)
    expect(parseCpuTime('   ')).toBe(0)
  })
})

describe('parseMemKb —— tasklist 的内存列', () => {
  it('千分位逗号与点号都当分隔符抠掉', () => {
    // 同一个数值，两种区域设置
    expect(parseMemKb('12,345 K')).toBe(12_345)
    expect(parseMemKb('12.345 K')).toBe(12_345)
    expect(parseMemKb('8 K')).toBe(8)
  })

  it('占位符给 0', () => {
    expect(parseMemKb('N/A')).toBe(0)
    expect(parseMemKb('')).toBe(0)
  })
})

describe('parseCsvLine —— tasklist 的引号规则', () => {
  it('带千分位的数值不会被切开', () => {
    const fields = parseCsvLine(
      '"node.exe","4242","Console","1","123,456 K","Running","CORP\\alice","0:12:34","N/A"'
    )
    expect(fields).toHaveLength(9)
    expect(fields[4]).toBe('123,456 K')
    expect(fields[6]).toBe('CORP\\alice')
  })

  it('进程名里的逗号不会让字段错位', () => {
    const fields = parseCsvLine('"foo, bar.exe","7","Console","1","1 K"')
    expect(fields[0]).toBe('foo, bar.exe')
    expect(fields[1]).toBe('7')
    expect(fields).toHaveLength(5)
  })

  it('成对的双引号是一个字面引号', () => {
    expect(parseCsvLine('"say ""hi"".exe","9"')).toEqual(['say "hi".exe', '9'])
  })
})

describe('parsePsOutput —— ps 一次采样的解析', () => {
  const PS = [
    '  PID  PPID USER       RSS STAT     TIME COMMAND',
    '    1     0 root      1234 Ss   00:00:04 /sbin/init splash',
    '  123     1 alice    56789 Sl   1:02:03 /usr/bin/node /app/index.js --port 3000',
    '  124     1 alice        0 Z    00:00:00 [defunct]',
    '    2     0 root         0 S    00:00:00',
    ''
  ].join('\n')

  it('表头被跳过，列序不错位', () => {
    const procs = parsePsOutput(PS)
    expect(procs).toHaveLength(4)
    expect(procs.map((p) => p.pid)).toEqual([1, 123, 124, 2])
    expect(procs.map((p) => p.ppid)).toEqual([0, 1, 1, 0])
    expect(procs[1]!.user).toBe('alice')
  })

  it('命令行里的空格原样保留（args 是最后一列）', () => {
    const procs = parsePsOutput(PS)
    expect(procs[1]!.cmdline).toBe('/usr/bin/node /app/index.js --port 3000')
    expect(procs[0]!.cmdline).toBe('/sbin/init splash')
  })

  it('进程名取命令行首段的 basename', () => {
    const procs = parsePsOutput(PS)
    expect(procs[0]!.name).toBe('init')
    expect(procs[1]!.name).toBe('node')
    // 内核线程 / 僵尸进程的 cmdline 本身就是方括号形式
    expect(procs[2]!.name).toBe('[defunct]')
    // 完全没有 cmdline 时用 pid 兜底，不能留空串
    expect(procs[3]!.name).toBe('[2]')
  })

  it('累计 CPU 时间按 TIME 列解析', () => {
    const procs = parsePsOutput(PS)
    expect(procs[0]!.cpuSeconds).toBe(4)
    expect(procs[1]!.cpuSeconds).toBe(3723)
    expect(procs[2]!.cpuSeconds).toBe(0)
  })

  it('rss 单位是 KB（乘 1024 之后才是字节）', () => {
    expect(parsePsOutput(PS)[1]!.rssKb).toBe(56_789)
  })
})

describe('parseTasklistCsv —— Windows 降级通路（tasklist CSV）', () => {
  const CSV = [
    '"System Idle Process","0","Services","0","8 K","Unknown","NT AUTHORITY\\SYSTEM","0:00:00","N/A"',
    '"node.exe","4242","Console","1","123,456 K","Running","CORP\\alice","0:12:34","N/A"',
    '"weird, name.exe","7","Console","1","1.234 K","N/A","N/A","0:00:01","N/A"',
    ''
  ].join('\r\n')

  it('取 映像名 / PID / 内存 / 状态 / 用户 / CPU 时间', () => {
    const procs = parseTasklistCsv(CSV)
    expect(procs).toHaveLength(3)
    expect(procs[1]).toMatchObject({
      pid: 4242,
      name: 'node.exe',
      user: 'CORP\\alice',
      rssKb: 123_456,
      cpuSeconds: 754,
      // tasklist 不提供这两列 —— 契约里写明了恒为 0 / 空串
      ppid: 0,
      cmdline: ''
    })
  })

  it('N/A 用户名归一成空串（界面显示破折号而不是 N/A）', () => {
    expect(parseTasklistCsv(CSV)[2]!.user).toBe('')
  })

  it('name 里有逗号也不影响后面各列', () => {
    const procs = parseTasklistCsv(CSV)
    expect(procs[2]!.name).toBe('weird, name.exe')
    expect(procs[2]!.rssKb).toBe(1234)
  })
})

describe('parseCimProcesses —— Windows 主通路（PowerShell + CIM）', () => {
  /** 真实 WMI 的字段名是 PascalCase，且 `CommandLine` 对受保护进程是 null */
  const json = JSON.stringify([
    {
      ProcessId: 0,
      ParentProcessId: 0,
      Name: 'System Idle Process',
      CommandLine: null,
      WorkingSetSize: 8192,
      KernelModeTime: 10_000_000,
      UserModeTime: 0
    },
    {
      ProcessId: 4242,
      ParentProcessId: 100,
      Name: 'node.exe',
      CommandLine: '"C:\\Program Files\\node.exe" a.js',
      WorkingSetSize: 1_048_576,
      // 单位是 100ns：2000 万 + 3000 万 = 5000 万 → 5 秒
      KernelModeTime: 20_000_000,
      UserModeTime: 30_000_000
    }
  ])

  it('100ns 换算成秒、内存 kB、父子关系都在', () => {
    const procs = parseCimProcesses(json)
    const node = procs.find((p) => p.pid === 4242)!
    expect(node.cpuSeconds).toBe(5)
    expect(node.rssKb).toBe(1024)
    expect(node.ppid).toBe(100)
    expect(node.cmdline).toBe('"C:\\Program Files\\node.exe" a.js')
    // Win32_Process 没有这两个属性 —— 界面靠空串 / 空状态显示「—」
    expect(node.user).toBe('')
    expect(node.rawState).toBe('')
  })

  it('pid 0（System Idle Process）被丢掉 —— 否则它永远霸占表头第一行', () => {
    expect(parseCimProcesses(json).map((p) => p.pid)).toEqual([4242])
  })

  it('只有一个进程时 ConvertTo-Json 给的是对象而不是数组', () => {
    const one = JSON.stringify({
      ProcessId: 7,
      ParentProcessId: 1,
      Name: 'a.exe',
      CommandLine: '',
      WorkingSetSize: 2048,
      KernelModeTime: 0,
      UserModeTime: 10_000_000
    })
    expect(parseCimProcesses(one)).toHaveLength(1)
    expect(parseCimProcesses(one)[0]!.cpuSeconds).toBe(1)
  })

  it('没有 Name 时用命令行的 basename 兜底；输出不是 JSON 就返回空数组', () => {
    const noName = JSON.stringify({
      ProcessId: 9,
      ParentProcessId: 0,
      Name: null,
      CommandLine: '"C:\\Tools\\x.exe" --flag',
      WorkingSetSize: 0,
      KernelModeTime: 0,
      UserModeTime: 0
    })
    expect(parseCimProcesses(noName)[0]!.name).toBe('x.exe')
    expect(parseCimProcesses('not json')).toEqual([])
    expect(parseCimProcesses('')).toEqual([])
  })
})

describe('stateOf —— 两个平台的原始状态码归一', () => {
  it('POSIX 的状态首字母', () => {
    expect(stateOf('Ssl')).toBe('sleeping')
    expect(stateOf('R+')).toBe('running')
    expect(stateOf('D')).toBe('sleeping')
    expect(stateOf('T')).toBe('stopped')
    expect(stateOf('Z')).toBe('zombie')
  })

  it('Windows 的整词（含中文系统）', () => {
    expect(stateOf('Running')).toBe('running')
    // 「未响应」是「在跑但卡住」，不是「跑不起来」—— 归到 running，原始码留给悬停提示
    expect(stateOf('Not Responding')).toBe('running')
    expect(stateOf('Suspended')).toBe('stopped')
    expect(stateOf('未知')).toBe('unknown')
    expect(stateOf('已挂起')).toBe('stopped')
  })

  it('空串 / N/A 都是 unknown', () => {
    expect(stateOf('')).toBe('unknown')
    expect(stateOf('N/A')).toBe('unknown')
    expect(stateOf('???')).toBe('unknown')
  })
})
