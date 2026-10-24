/**
 * 宿主进程（PTY 里跑着 shell）的**整棵进程树**的收掉方式。
 *
 * 为什么集中在这一处：仓库里有**两份** PTY 实现 —— `apps/server` 的
 * `openTerminalSession`（web 端打 `/api/terminal`）与 `packages/agent-host` 的
 * `openPtySession`（桌面端本机终端）。它们各自手写过一份「怎么杀」，其中 desktop 那份
 * 只调了 `IPty.kill()`（杀 shell 自己），于是 `npx vite --port 30000` 这种**前台子进程**
 * 会活下来 —— 用户报的「手动停止都停不下来」「端口还占着」。
 *
 * ## 为什么只杀 shell 不够
 *
 * `node-pty` 用 `forkpty` 起进程：shell 是会话首 / 进程组首，它启动的命令是**同一组里的
 * 子进程**。`IPty.kill()` 只对 shell 自己发信号：
 * - 前台命令（`npx vite`、`npm run dev`）收到的是 shell 的死，**它们不一定会跟着死**
 *   （尤其 Windows ConPTY，以及 detached 起来 / 被重新收养的进程），于是继续跑、继续占端口；
 * - shell 死了但子进程写 PTY 时，服务端还收得到输出 —— 「看起来还在跑」。
 *
 * 所以关闭终端必须**按树杀**：
 * - Windows：`taskkill /T /F`（`/T` 才是「连子进程一起」；`IPty.kill()` 底层的 `TerminateProcess`
 *   只作用于单个进程）；
 * - POSIX：`node-pty` 的 `forkpty` 让 shell 自成会话首（`pgid === pid`），给**进程组**
 *   `-pid` 发 SIGHUP（bash 在挂断时会把它的作业一起 SIGHUP），1.5s 后还没死就 SIGKILL 整组。
 *
 * ⚠️ 这里只管「杀」，不管 PTY 的 spawn / 输出。`node-pty` 只在实现侧引：本模块
 * 只接收 `{ pid, kill }` 这个最小形状，好让纯单测能塞假对象进来。
 */
import { execFile } from 'node:child_process'

/** 收掉一棵进程树需要的最小 PTY 形状（`node-pty` 的 `IPty` 满足它） */
export interface KillablePty {
  readonly pid: number
  /** 只杀 shell 自己 —— 作为整树杀失败时的兜底 */
  kill(): void
}

/** POSIX：SIGHUP 之后等这么久还没干净就 SIGKILL 整组 */
const KILL_ESCALATE_MS = 1500

/** 整组是否还存在。ESRCH = 没了；EPERM = 还在但没权限（也算「还在」） */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 收掉**整棵进程树**（shell + 它启动的所有命令）。
 *
 * 幂等、不抛：进程可能已经自己退了，调用方不该为「已经没了」写 try/catch。
 */
export function killPtyTree(proc: KillablePty): void {
  const pid = proc.pid
  if (!pid) return

  if (process.platform === 'win32') {
    // ⚠️ 异步 execFile 在服务端退出 / 进程崩溃时可能还没跑完，但这里是「用户点了停止」的
    // 交互路径，进程还活着，足够；失败再退回单杀 shell。
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
        // 结果不重要：进程可能已经自己退了
      })
    } catch {
      try {
        proc.kill()
      } catch {
        // 已退出
      }
    }
    return
  }

  // POSIX：会话首的 pgid 就是 pid
  try {
    process.kill(-pid, 'SIGHUP')
  } catch {
    // 进程组没了：直接退回单杀（也会失败，静默）
    try {
      proc.kill()
    } catch {
      // 已退出
    }
    return
  }
  // 兜底升级：vite / node 这类对 SIGHUP 不理会的进程，整组 SIGKILL。
  // `unref()` 让这个定时器不吊住进程退出（服务端收尾时不能因为它多活 1.5s）。
  const timer = setTimeout(() => {
    if (!groupAlive(pid)) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }, KILL_ESCALATE_MS)
  timer.unref?.()
}
