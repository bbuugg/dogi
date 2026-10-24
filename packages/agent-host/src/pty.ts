/**
 * 桌面主进程的本机 PTY 终端会话表。
 *
 * 桌面端终端是「本机 shell」，只有主进程能碰 node-pty；渲染端经 IPC 桥
 * （`./transport-ipc`）转发输入 / 尺寸 / 关闭，输出与退出由这里回调推回去。
 *
 * 与 `apps/server/src/terminal/pty.ts` 是两份刻意独立的实现：
 * 那边给 web 端的「服务端终端」（WS 转发），这边给桌面端的「本机终端」（IPC 直推），
 * 依赖方向与生命周期都不同，不值得为省十几行强行抽公共包。
 * 唯一共用的是「这台机器上有哪些 shell」的判定（`@fizz/contracts/shells`）——
 * 那件事两边必须给出同一个答案，各写一份只会漂。
 *
 * **日志转录**（`@fizz/workspace` 的 `startTerminalTranscript`）也共用：桌面端 server 是
 * 进程内装配的（`./manager.ts` 的 `startBackgroundServices`），主进程与 server 拿到的是
 * **同一个 `appLog` 单例**，所以这里记的终端日志在日志面板（`GET /api/app-log`）里读得到。
 * 它只是「把文本回填进一条日志」，不碰会话生命周期，不违反上面「两份独立实现」的取舍。
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import { resolveShell } from '@fizz/shells'
import { appLog, killPtyTree, startTerminalTranscript, type TerminalTranscript } from '@fizz/workspace'
import type { PtyOpenRequest } from './channels'

/** 必须是 256 色终端，否则 htop / lazygit 这类 ncurses 程序会渲染成黑白 */
const TERM_TYPE = 'xterm-256color'

interface PtyHandlers {
  onData: (data: Buffer) => void
  onExit: (exitCode: number) => void
}

export interface PtySessionHandle {
  /** `Uint8Array` 是 ZMODEM 之类的二进制键入：node-pty 的 write 收 Buffer，逐字节保真 */
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
  /** 「停止」：收掉前台命令的进程树（shell 可能一起没，见实现处的注释） */
  stop(): void
}

/** cwd 不存在 / 不是目录时退回主目录（工作区目录可能刚被删） */
function safeCwd(cwd: string): string {
  try {
    if (cwd && statSync(cwd).isDirectory()) return cwd
  } catch {
    // 落到主目录
  }
  return homedir()
}

/** 活跃会话表：id → pty 进程（write / resize / kill 用） */
const sessions = new Map<string, pty.IPty>()

/**
 * 日志转录表：id → 转录器。**不能挂在 `getPtySession` 返回的 handle 上** —— 那个 handle
 * 每次调用都新建一个，转录会被反复重置。`killed` 只为退出日志的文案服务（「已关闭」还是
 * 「已退出」），由 `kill()` / `killAllPtySessions()` 置位。
 */
const transcripts = new Map<string, { transcript: TerminalTranscript; killed: boolean }>()

export function openPtySession(input: PtyOpenRequest, handlers: PtyHandlers): string {
  const id = `pty-${randomBytes(8).toString('hex')}`
  // shell 由 id 解析（认不出来回落平台默认）；args 一起用上 —— Git Bash 要 `--login -i`
  const shell = resolveShell(input.shellId)
  // 额外启动参数接在 shell 自带 args 之后（用户自定义优先，不能把 `--login -i` 顶掉）
  const args = [...shell.args, ...(input.args ?? [])]
  const cwd = safeCwd(input.cwd)
  const cols = Math.max(2, Math.floor(input.cols))
  const rows = Math.max(2, Math.floor(input.rows))
  const proc = pty.spawn(shell.command, args, {
    name: TERM_TYPE,
    cols,
    rows,
    cwd,
    // encoding: null → onData 收原始 Buffer，ANSI 转义 / 中文多字节都按字节保真
    encoding: null,
    env: { ...process.env, TERM: TERM_TYPE, COLORTERM: 'truecolor' } as Record<string, string>
  })
  sessions.set(id, proc)
  // 日志（面板的「终端」Tab）：打开事件 + 整场输入输出 —— 转录持续回填到这一条上
  // （见 `@fizz/workspace` 的转录模块，与 `apps/server` 那两份终端同一套口径）
  const entry = {
    killed: false,
    transcript: startTerminalTranscript(
      'terminal',
      `打开终端 ${id}`,
      [
        `shell: ${shell.command}${args.length ? ` ${args.join(' ')}` : ''}`,
        `工作目录: ${cwd}`,
        `尺寸: ${cols}×${rows}`,
        ...(input.autoCommand ? [`自动执行: ${input.autoCommand}`] : [])
      ].join('\n'),
      // 会话 id：整场输入输出除了回填日志条目，还落一份 `<dataDir>/logs/terminal/<id>.log`
      id
    )
  }
  transcripts.set(id, entry)

  proc.onData((data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string)
    entry.transcript.output(buf)
    handlers.onData(buf)
  })
  proc.onExit(({ exitCode }) => {
    sessions.delete(id)
    clearAutoTimer()
    // 「程序跑完自己退了」与「用户关掉终端」都会到这里，后者 kill() 已把 killed 置位
    const how = entry.killed ? '已关闭' : '已退出'
    entry.transcript.finish(`[${how}（退出码 ${exitCode}）]`)
    transcripts.delete(id)
    appLog.info('terminal', `终端 ${id} ${how}（退出码 ${exitCode}）`)
    handlers.onExit(exitCode)
  })

  // 启动后自动执行：shell 起来后有一小段初始化（读 rc / 打 banner），立刻写会被吞掉，
  // 所以等一拍再送 —— 命令末尾的 `\r` 就是「回车」。
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  const clearAutoTimer = (): void => {
    if (autoTimer) {
      clearTimeout(autoTimer)
      autoTimer = undefined
    }
  }
  if (input.autoCommand) {
    const command = input.autoCommand
    autoTimer = setTimeout(() => {
      autoTimer = undefined
      try {
        // 自动执行的命令也是「输入」，一并记进转录（它不走 `getPtySession` 的 write，会漏掉）
        entry.transcript.input(`${command}\r`)
        proc.write(`${command}\r`)
      } catch {
        // 进程可能刚退出：静默
      }
    }, 400)
  }
  return id
}

/**
 * 收掉**整棵进程树**（实现在 `@fizz/workspace` 的 `host-process.ts`）。
 *
 * ⚠️ 这里原来是 `proc.kill()` —— 只杀 shell 自己。用户报过「AI 跑了
 * `npx vite --port 30000`，我手动停止竟然停不下来」：node-pty 用 `forkpty` 起 shell，
 * 前台命令是它的子进程，shell 一死子进程不一定跟着死（Windows ConPTY 尤其如此），
 * 于是继续跑、继续占端口。现在与 `apps/server` 的终端共用同一份按树杀。
 */
const killTree = (proc: pty.IPty): void => killPtyTree(proc)

/** POSIX：SIGTERM 之后等这么久还没干净就 SIGKILL 整个前台组（与 killPtyTree 同一节奏） */
const STOP_ESCALATE_MS = 1500

/**
 * 收掉**前台作业**，绝不动 shell 本身。
 *
 * 判据是 `ps -o tpgid=`（终端的前台进程组）：
 * - `tpgid !== pgid` → 有前台作业（交互式 shell 的作业控制会把它单独成组）→ 杀那一组；
 * - `tpgid === pgid`（或读不出来）→ 正停在提示符上，**什么都不做**。
 *
 * 为什么不再按树杀（`killPtyTree`）兜底：那是「关掉终端」，而调用方是 Ctrl+C 的延时补刀，
 * 用户按几下就整条终端没了（详见下面 `stop` 的注释）。宁可「这条命令没停掉、让用户关标签」，
 * 也不能替用户关掉他正在用的终端。
 *
 * ⚠️ SSH 终端根本没有这个能力（`apps/desktop/src/renderer/host.ts` 刻意不实现 `stop`）：
 * 远端进程组不在宿主视野里，以前那记「补发 `\x03`」只会让命令退出 1.2s 后再冒出个 `^C`。
 *
 * Windows 直接返回：ConPTY 没有进程组，能做的只有 `taskkill /T`（连 shell 一起没），
 * 与 SSH 通道同款处理 —— Ctrl+C 只发 `\x03`，不补刀。
 */
function stopForeground(proc: pty.IPty): void {
  if (process.platform === 'win32') return
  execFile(
    'ps',
    ['-o', 'tpgid=,pgid=', '-p', String(proc.pid)],
    { windowsHide: true },
    (err, stdout) => {
      // 进程没了 / 平台不认 `tpgid`（BSD 系）：保留终端，不猜
      if (err) return
      const [tpgid, pgid] = stdout
        .trim()
        .split(/\s+/)
        .map((value) => Number(value))
      if (!Number.isFinite(tpgid) || !tpgid || tpgid === pgid) return
      try {
        process.kill(-tpgid, 'SIGTERM')
      } catch {
        // 组自己退了
        return
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-tpgid, 'SIGKILL')
        } catch {
          // 已退出
        }
      }, STOP_ESCALATE_MS)
      timer.unref?.()
    }
  )
}

export function getPtySession(id: string): PtySessionHandle | undefined {
  const proc = sessions.get(id)
  if (!proc) return undefined
  return {
    write: (data) => {
      // 键入记进转录（`Uint8Array` 是 ZMODEM 二进制帧，`input()` 内部会跳过）
      transcripts.get(id)?.transcript.input(data)
      try {
        // 二进制不能过字符串（会按 UTF-8 重新编码、破坏字节）：直接给 Buffer
        proc.write(typeof data === 'string' ? data : Buffer.from(data))
      } catch {
        // 进程可能刚退出
      }
    },
    resize: (cols, rows) => {
      try {
        proc.resize(Math.max(2, cols), Math.max(2, rows))
      } catch {
        // 进程可能刚退出
      }
    },
    kill: () => {
      // 先置位：`onExit` 据此把日志文案记成「已关闭」而不是「已退出」
      const entry = transcripts.get(id)
      if (entry) entry.killed = true
      killTree(proc)
      sessions.delete(id)
    },
    /**
     * 「停止」：只收掉**前台作业**，shell 必须留着（终端还能继续用）。
     *
     * ⚠️ 这里原来是 `killTree(proc)`（整棵树）—— 而 `TerminalPanel` 的 Ctrl+C 在 1.2s 后
     * 会调它做兜底（「程序吞掉 SIGINT 按烂了也停不下来」）。于是**每按一次 Ctrl+C 就把
     * 整条本地终端干掉**：用户看到的就是「按几次 Ctrl+C 直接断开」（SSH 通道不实现
     * `stop`，压根不会走到这记补刀）。强停的边界必须是「前台那条命令」，
     * 不是「终端」。见 `stopForeground`。
     */
    stop: () => {
      stopForeground(proc)
    }
  }
}

/** 应用退出前收掉所有 shell 子进程（Windows 不显式 kill 会留孤儿） */
export function killAllPtySessions(): void {
  for (const [id, proc] of sessions) {
    // 同上：这批是「被关掉的」，不是自己跑完退出的
    const entry = transcripts.get(id)
    if (entry) entry.killed = true
    killTree(proc)
  }
  sessions.clear()
}
