/**
 * 服务端 PTY 终端会话：给 web 端「服务端终端」用。
 *
 * 桌面端的终端不在这里 —— 那是本机 PTY，跑在 agent-host 的主进程里（IPC 桥）；
 * web 端碰不到服务端的交互式 shell 常规 HTTP，所以由这里 spawn + WS 转发。
 *
 * 与根应用 `src/main/services/terminal/sessions.ts` 同一思路的极简版：
 * 只需要 spawn / write / resize / kill，不做输出缓冲（WS 在线直传，断线即丢，
 * 重开终端 = 新会话 —— 对「在工作区里敲命令」的场景够用）。
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import { appLog, killPtyTree, startTerminalTranscript } from '@fizz/workspace'
import { resolveShell } from '@fizz/shells'

/** 必须是 256 色终端，否则 htop / lazygit 这类 ncurses 程序会渲染成黑白（与根应用一致） */
const TERM_TYPE = 'xterm-256color'

export interface TerminalSession {
  id: string
  /**
   * 写入 PTY。
   *
   * `string` = 键盘 / 粘贴的常规文本；`Uint8Array` = **二进制键入** —— 只有 ZMODEM
   * （rz/sz 传输）会用到，必须逐字节保真（与 SSH 通道的 `session.write` 同一份约定，
   * 见 `ssh/session.ts`）。
   */
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
  /**
   * 「停止」：把当前前台命令连同它的子进程收掉，**shell 保留**（终端还能继续用）。
   *
   * ⚠️ 拿不到前台进程组（停在提示符上 / Windows / 容器）时**什么都不做** —— 绝不能退回
   * 整树杀：调用方是 Ctrl+C 的延时补刀，那等于用户按几下 Ctrl+C 终端就没了。
   * 返回 Promise 是因为 POSIX 下要先往 PTY 里探一下前台 pgid（最多 600ms）。
   */
  stopForeground(): Promise<void>
}

interface TerminalHandlers {
  onData: (data: Buffer) => void
  onExit: (exitCode: number) => void
}

/**
 * 「这个终端开在容器里」的目标（容器型项目：宿主不碰那些文件，交互式 shell 要下沉进容器）。
 *
 * 命中时 spawn 的**命令 + 参数整组替换**为 `docker exec -i -t <name> <shellPath> -l`：
 * 宿主侧的 shell 清单（`shellId`）与额外 `args` 都**不适用**（那是给本机 shell 的，
 * 容器里是 Linux 的 `/bin/bash`）。`cwd` 同样无意义 —— 容器里已经挂了 `/workspace`。
 */
export interface TerminalContainerTarget {
  /** 容器名（容器型项目 = `fizz-proj-<slug>`，见 `container-projects/root.ts`） */
  name: string
  /** 容器内 shell；缺省 `/bin/bash` */
  shellPath?: string
}

/** cwd 不存在 / 不是目录时退回主目录（工作区路径在两次请求之间可能被删） */
function safeCwd(cwd: string): string {
  try {
    if (cwd && statSync(cwd).isDirectory()) return cwd
  } catch {
    // 落到主目录
  }
  return homedir()
}

/** 活跃会话表：id → pty 进程（kill / 收尾用） */
const sessions = new Map<string, pty.IPty>()

/**
 * 连**整棵进程树**一起收掉（实现在 `@fizz/workspace` 的 `host-process.ts`）。
 *
 * 这里曾经自己写了一份，而 desktop 的 `agent-host/pty.ts` 只调了 `IPty.kill()`（只杀 shell）
 * —— 于是 `npx vite --port 30000` 这类**前台子进程**在桌面上「停不下来」。两份实现合成
 * 一处之后，两边都按树杀：Windows `taskkill /T /F`、POSIX 先 SIGHUP 整组再升级 SIGKILL。
 */
const killProcessTree = killPtyTree

export function openTerminalSession(
  options: {
    cwd?: string
    cols: number
    rows: number
    shellId?: string
    /** 追加到 shell 自带 args **之后**的额外启动参数 */
    args?: string[]
    /** 启动后自动执行的一条命令（shell 起来后写进 PTY） */
    autoCommand?: string
    /**
     * 在**容器内**开这个终端（容器型项目）。命中时下面整组替换 spawn 的命令与参数，
     * `shellId` / `args` / `cwd` 都不再参与（见 `TerminalContainerTarget` 的说明）。
     */
    container?: TerminalContainerTarget
  },
  handlers: TerminalHandlers
): TerminalSession {
  const id = `term-${randomBytes(8).toString('hex')}`
  // shell 由 id 解析（认不出来回落平台默认）；args 一起用上 —— Git Bash 要 `--login -i`
  const shell = resolveShell(options.shellId)
  // 额外启动参数接在 shell 自带 args 之后（用户自定义优先，不能把 `--login -i` 顶掉）
  const args = [...shell.args, ...(options.args ?? [])]
  const cwd = safeCwd(options.cwd ?? '')
  /**
   * 容器型项目：命令换成 `docker exec -i -t`，`-l` 让容器内 shell 按登录态起来
   * （读 profile、PATH 齐全）。`-i` 保 stdin、`-t` 要 TTY —— 少了 `-t` 交互式程序
   * （`htop` / `lazygit`）会渲染不出来。
   *
   * ⚠️ 两个待实测项（**刻意没做运行时验证**，等真实容器上验）：
   * 1. Windows 宿主机下 `-t` 能否通过 —— 不行就退成 `-i`（去掉 `-t`）；
   * 2. 关标签后容器内那条 shell 进程是否随 `docker exec` 客户端一起退出（SIGHUP）。
   *    若实测发现它继续活着，就在关闭时补一次容器内 kill（进程组 id 在建会话时
   *    `echo $$` 取一次记下）。
   */
  const containerTarget = options.container
  const command = containerTarget ? 'docker' : shell.command
  const spawnArgs = containerTarget
    ? ['exec', '-i', '-t', containerTarget.name, containerTarget.shellPath ?? '/bin/bash', '-l']
    : args
  const spawnCwd = containerTarget ? process.cwd() : cwd
  /** 已经主动 kill 过：`onExit` 据此区分「自己退的」与「被关掉的」（只为日志文案） */
  let killed = false
  const proc = pty.spawn(command, spawnArgs, {
    name: TERM_TYPE,
    cols: Math.max(2, Math.floor(options.cols)),
    rows: Math.max(2, Math.floor(options.rows)),
    cwd: spawnCwd,
    // encoding: null → onData 收原始 Buffer，ANSI 转义 / 中文多字节都按字节保真
    encoding: null,
    env: { ...process.env, TERM: TERM_TYPE, COLORTERM: 'truecolor' } as Record<string, string>
  })
  sessions.set(id, proc)
  // 记进应用日志（日志面板的「终端」Tab）：**打开事件 + 整场输入输出**（转录持续回填到
  // 这一条上，见 `transcript.ts` 的「一次会话一条日志」）。
  // 这里是全 App 唯一开出「本机 PTY」的地方（web 的服务端终端、桌面端的本机终端、
  // 输入框那条 agent 终端都走它），所以日志只在这一处打就够，别在 ws.ts 等调用方各打一份
  // （那样同一条终端会因为入口不同而重复 / 漏记）。
  const transcript = startTerminalTranscript(
    'terminal',
    `打开终端 ${id}`,
    [
      containerTarget
        ? `容器: ${containerTarget.name}（docker exec ${containerTarget.shellPath ?? '/bin/bash'}）`
        : `shell: ${shell.command}${args.length ? ` ${args.join(' ')}` : ''}`,
      containerTarget ? '工作目录: /workspace（容器内挂载点）' : `工作目录: ${cwd}`,
      `尺寸: ${Math.floor(options.cols)}×${Math.floor(options.rows)}`,
      ...(options.autoCommand ? [`自动执行: ${options.autoCommand}`] : [])
    ].join('\n'),
    // 会话 id：整场输入输出除了回填日志条目，还落一份 `<dataDir>/logs/terminal/<id>.log`
    id
  )

  /** PTY 输出 → 转录 + 前端（抽成具名函数：从前台组探测要"扣住"输出那段历史留下的入口） */
  const dispatchData = (data: Buffer): void => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string)
    transcript.output(buf)
    handlers.onData(buf)
  }
  proc.onData((data) => dispatchData(Buffer.isBuffer(data) ? data : Buffer.from(data as string)))
  proc.onExit(({ exitCode }) => {
    sessions.delete(id)
    clearAutoTimer()
    // 「程序跑完自己退了」与「用户关掉终端」都会到这里 —— 后者 kill() 已经把 killed 置位，
    // 两边都只记一条，不重复（`appLog` 是模块级单例，前端按 seq 覆盖同一条）。
    const how = killed ? '已关闭' : '已退出'
    // 先收尾转录（回填到「打开终端」那一条），再单独记一条退出事件：前者是过程，后者是结果
    transcript.finish(`[${how}（退出码 ${exitCode}）]`)
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
  if (options.autoCommand) {
    const command = options.autoCommand
    autoTimer = setTimeout(() => {
      autoTimer = undefined
      try {
        // 自动执行的命令也是「输入」，一并记进转录（它不走下面的 write，会漏掉）
        transcript.input(`${command}\r`)
        proc.write(`${command}\r`)
      } catch {
        // 进程可能刚退出：静默
      }
    }, 400)
  }

  return {
    id,
    write: (data) => {
      // 键入记进转录（`Uint8Array` 是 ZMODEM 二进制帧，`input()` 内部会跳过）
      transcript.input(data)
      try {
        // 二进制直通（ZMODEM 的协议帧 / 文件块）：node-pty 的 write 收 string 或 Buffer，
        // 逐字节保真。本机终端不做字符集转码，所以没有 SSH 那边「gbk 会话下 zmodem 不可用」
        // 的限制。
        proc.write(typeof data === 'string' ? data : Buffer.from(data))
      } catch {
        // 进程可能刚退出：静默（马上会收到 exit 帧）
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
      killed = true
      clearAutoTimer()
      killProcessTree(proc)
      sessions.delete(id)
    },
    /**
     * 「停止」：把当前前台作业连同它的子进程一起收掉，shell 自己保留 —— 终端还能继续用。
     *
     * 与 `kill()` 的区别是**不删会话**、不置 `killed`。用户的预期是「Ctrl+C 不够，
     * 我要把这条命令彻底杀掉」，而不是「关掉终端」。
     *
     * 前台作业通常已经自成一个进程组（作业控制），给 `-pgid` 发信号即可。
     *
     * ⚠️ **拿不到前台作业时什么都不做，绝不退回整树杀**。这条路径由 Ctrl+C 的延时补刀
     * 调用（`TerminalPanel`，1.2s 后），退回整树杀 = 用户按几下 Ctrl+C 整条终端就没了
     * （用户报过「本地终端多次 Ctrl+C 直接断开」；SSH 通道不实现 `stop`，
     * 那条路的延迟兜底根本不挂，见 `apps/desktop/src/renderer/host.ts`）。
     * 落在这一档的情况：
     * - 停在提示符上（`tpgid` 与 shell 自己的组相同）—— 本来就没有东西可停；
     * - Windows 的 ConPTY 没有进程组概念 —— 只能 `taskkill /T`（连 shell 一起没），
     *   宁可让用户关标签，也不替他关终端；
     * - 容器型项目的终端 —— pid 在宿主上是 `docker exec` 客户端，前台作业在**容器**里，
     *   宿主查不到对应关系；硬按宿主号 kill 会打到毫不相干的本机进程组。
     */
    stopForeground: async () => {
      const pgid = await foregroundPgid(proc, Boolean(containerTarget))
      if (!pgid) return
      try {
        // SIGTERM 而不是 SIGHUP：vite / node 这类对 SIGHUP 有时不理会，TERM 才是「请你退出」
        process.kill(-pgid, 'SIGTERM')
      } catch {
        // 组没了（已经自己退了）：什么都不用做
        return
      }
      // 兜底升级：1.5s 后整组还在就 SIGKILL（与 killPtyTree 同一节奏）
      const timer = setTimeout(() => {
        try {
          process.kill(-pgid, 'SIGKILL')
        } catch {
          // 已退出
        }
      }, 1500)
      timer.unref?.()
    }
  }
}

/**
 * 读终端上的**前台进程组**：宿主侧 `ps -o tpgid=` 查一次，返回 0 表示「不知道」。
 *
 * 为什么不再「往 PTY 里打一条 `printf` 命令，从回显里取答案」：那行探测命令会**出现在
 * 用户的终端里**（以前只在点「停止」时发生一次；现在 Ctrl+C 的延时补刀每按一次就走一趟，
 * 等于每按一次 Ctrl+C 就往回显里插一行 `printf '__FIZZ_PGID__…'`）。`ps` 的 `tpgid`
 * 就是终端的前台进程组，同一个答案、零副作用。
 *
 * 返回 0 的四种情况（调用方据此**什么都不做**，绝不回退整树杀）：
 * - 进程已经没了 / `ps` 执行失败；
 * - Windows 的 ConPTY 没有进程组概念（直接返回 0，连 `ps` 都不跑）；
 * - 容器型终端：pid 是宿主上的 `docker exec` 客户端，前台作业在容器命名空间里，对不上号；
 * - 前台组 == shell 自己的组：停在提示符上，没有作业可停。
 */
function foregroundPgid(proc: pty.IPty, container: boolean): Promise<number> {
  if (process.platform === 'win32' || container) return Promise.resolve(0)
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'tpgid=,pgid=', '-p', String(proc.pid)],
      { windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(0)
          return
        }
        // 形如 `  1234   1234`（Linux）或空（进程刚没）。BSD 系不认 `tpgid` 会走上面的 err
        const [tpgid, shellPgid] = stdout
          .trim()
          .split(/\s+/)
          .map((value) => Number(value))
        resolve(Number.isFinite(tpgid) && tpgid > 0 && tpgid !== shellPgid ? tpgid : 0)
      }
    )
  })
}

/** 进程退出前收掉所有 shell 子进程（Windows 上不显式 kill 会留孤儿） */
export function killAllTerminalSessions(): void {
  for (const [, proc] of sessions) {
    killProcessTree(proc)
  }
  sessions.clear()
}
