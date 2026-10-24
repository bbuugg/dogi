/// <reference path="../../types/zmodem.d.ts" />
/**
 * ZMODEM（rz/sz）传输控制器。
 *
 * 这个文件是从 `TerminalPanel` 的主 effect 里整块搬出来的：那段逻辑原本摊在 800 多行 effect
 * 的中间，靠 **8 个 ref** 与「打字输入 / Ctrl+C / 拖放 / 浮层按钮 / 清理」五个方向互相勾连
 * （`zsessionRef` / `currentOfferRef` / `uploadCancelRef` / `zmodemCancelledRef` /
 * `zmodemCancelRef` / `zmodemAwaitingRef` / `zmodemDropRef` / `zmodemPickRef`），
 * 读起来像「终端里还藏着另一个传输协议栈」。
 *
 * 搬出来之后边界收成一句话：**入站字节交给 `consume()`，Ctrl+C 交给 `interrupt()`，
 * 拖进来的文件交给 `dropFiles()`**。会话引用与各取消标志都成了这里的私有闭包变量，
 * 组件只留一个 `ZmodemState` 用来渲染浮层。
 *
 * ⚠️ 两个容易踩的点（原注释保留）：
 * 1. **异常结束**后不能直接收尾，要进「排水窗口」——zmodem.js 的 Sentry 在会话烂掉后会把
 *    之后每一个入站字节直吐 `to_terminal`，而远端还在猛发文件字节，终端就被刷屏。
 * 2. 排水期里 `session` 已经是 null，但 Ctrl+C 仍必须被拦成「中止传输」，
 *    否则就是用户报的「停不下来」。
 */
import type { Terminal } from '@xterm/xterm'
import Zmodem from 'zmodem.js'
import type { ZmodemSession, ZmodemTransfer } from 'zmodem.js'
import type { SshCharset } from '@fizz/contracts/types'
import type { TerminalProcess, ZmodemFile } from '@fizz/agent-client/web-host'
import { getZmodemBridge } from '@fizz/agent-client/web-host'
import { createSshTerminalDecoder } from './ssh-terminal-output'
import { consumeZmodemChunk, createPostAbortDrain, ZMODEM_ABORT_SEQUENCE } from './zmodem-input'

/**
 * 传输的实时状态：终端上方的进度浮层据此渲染。
 * 一次会话（`Sentry` 认出的一段 rz/sz）期间只有一份，逐文件刷新。
 */
export interface ZmodemState {
  /** 方向：upload = 远端 rz（本地选文件发过去）；download = 远端 sz（收下来存本机） */
  direction: 'upload' | 'download'
  /** 当前文件名（还没拿到时为空的） */
  name: string
  /** 一句话状态（选文件 / 上传中 / 已保存到哪） */
  text: string
  /** 0-100 */
  progress: number
  /**
   * 「等文件」态：远端 rz 在等我们发文件，而系统选框已被用户取消（Esc / 关框）——
   * 此时终端整体是拖拽投放区，浮层里也给「选择文件」按钮重开选框。
   */
  awaitingFiles?: boolean
}

export interface ZmodemControllerOptions {
  term: Terminal
  /** 进程按 ref 取：Sentry 要在进程创建**之前**挂上，`sender` 只能延迟读 */
  processRef: { current: TerminalProcess | null }
  /** 关掉嗅探器：容器工作台那条 bridge 是纯文本通道，二进制键入根本发不出去 */
  enabled: boolean
  /** 输出落进 xterm 前的解码方式（SSH 非 UTF-8 会话要转码） */
  charset: SshCharset
  /** 状态变化（null = 传输结束，收起浮层） */
  onState: (state: ZmodemState | null) => void
  /** 拖放高亮开关（传输结束时一并关掉） */
  onDropActive: (active: boolean) => void
}

export interface ZmodemController {
  /**
   * 入站字节的统一入口。
   *
   * - 排水期内：丢弃（止住刷屏），且**不进 Sentry**（免得对端重发握手又弹一个保存框）；
   * - 挂了嗅探器：先过 Sentry（协议字节被它吞掉，其余经 `to_terminal` 回吐渲染）；
   * - 没挂（容器工作台）：直接写终端。
   */
  consume: (data: Uint8Array) => void
  /**
   * Ctrl+C：返回 true 表示「这次按键归传输管」（已取消，别再发 `\x03`）。
   * 传输中与排水期都算 —— 排水期里会话已经没了，但远端可能还在猛发字节。
   */
  interrupt: () => boolean
  /** 有会话正在传：此时禁掉一切手动输入（中途插进来的键会被远端当成协议数据） */
  isBusy: () => boolean
  /** 远端 rz 正在等文件：此时拖进来的文件该喂给它，而不是走 SFTP */
  isAwaitingFiles: () => boolean
  /** 取消当前传输（浮层 ✕ 与 Ctrl+C 共用） */
  cancel: () => void
  /** 拖放进来的文件（等文件态） */
  dropFiles: (files: File[]) => void
  /** 浮层里的「选择文件」：重开系统选框 */
  pickFiles: () => void
  /** 会话拆除：清定时器、结束排水、清空所有引用 */
  dispose: () => void
}

export function createZmodemController(options: ZmodemControllerOptions): ZmodemController {
  const { term, processRef, enabled, charset, onState, onDropActive } = options

  /**
   * 会话已拆（换 shell / 关标签）：在飞的 async 流程（另存为框 / accept / 上传循环）返回后
   * 不能再碰 `term` —— xterm 已经 dispose，`focus()` / `write()` 会直接抛。
   */
  let disposed = false

  const decoder = charset === 'gbk' ? createSshTerminalDecoder('gbk') : null
  /** 写终端：`term.dispose()` 之后迟到的输出不该把整个会话搞崩（chunk 是异步派发的） */
  const writeTerminalOutput = (bytes: Uint8Array): void => {
    if (disposed) return
    try {
      term.write(decoder ? decoder(bytes) : bytes)
    } catch {
      // term 正在 dispose
    }
  }

  /** 当前 ZMODEM 会话；传输期间非空（这期间要拦掉手动键入） */
  let session: ZmodemSession | null = null
  /** 下载中当前的 offer（取消时优先对它 skip —— 干净跳过，远端不会乱码） */
  let currentOffer: ZmodemTransfer | null = null
  /** 上传发送循环的停止标志（Transfer 没有 skip，取消后靠它跳出循环） */
  let uploadCancelled = false
  /** 这次传输已被取消：之后到达的 offer 一律 skip，accept 回来的数据不再落盘 */
  let cancelled = false
  /** 「等文件」态（拖放判定在闭包里跑，读 state 只会拿到旧值） */
  let awaitingFiles = false
  /** 当前浮层状态；`patch` 依赖它做增量更新，避免每处都手写全量对象 */
  let current: ZmodemState | null = null

  const focusTerm = (): void => {
    if (!disposed) term.focus()
  }

  const emit = (next: ZmodemState | null): void => {
    current = next
    onState(next)
  }
  /** 只改现有状态的一部分（没有状态时什么也不做：传输已经收尾了） */
  const patch = (next: Partial<ZmodemState>): void => {
    if (current) emit({ ...current, ...next })
  }

  /**
   * 异常结束后的「排水窗口」（机制见 `zmodem-input.ts` 的 `createPostAbortDrain`）。
   * Ctrl+C 处理器要读它的 `isActive`，所以由控制器持有。
   */
  const drain = createPostAbortDrain(400, 10_000)
  /** 排水收尾的防抖定时器：链路安静 / 撞到硬上限后自动收起浮层、恢复终端渲染 */
  let drainTimer: number | null = null
  const clearDrainTimer = (): void => {
    if (drainTimer !== null) {
      window.clearTimeout(drainTimer)
      drainTimer = null
    }
  }

  /** 传输收尾：清掉会话引用、收起浮层（取消标志与上传停止标志由各处自行复位） */
  const end = (): void => {
    clearDrainTimer()
    drain.disengage()
    session = null
    currentOffer = null
    awaitingFiles = false
    emit(null)
    onDropActive(false)
  }

  /** 把中止序列直接写回 PTY —— **不依赖 `session`**：会话异常清空后，正是靠它让远端停手 */
  const abortPeer = (): void => {
    try {
      processRef.current?.write(ZMODEM_ABORT_SEQUENCE)
    } catch {
      // 进程已没：链路自然也就断了
    }
  }

  /** 排一个「排水收尾」定时器：安静 400ms（或撞到硬上限）后自动收起浮层；还在来字节就再等一轮 */
  const armDrainTimer = (): void => {
    clearDrainTimer()
    drainTimer = window.setTimeout(() => {
      drainTimer = null
      if (drain.isActive && !drain.quietElapsed(performance.now())) {
        armDrainTimer()
        return
      }
      end()
    }, 400)
  }

  /** **异常结束**的收尾：先进入排水窗口，把后续字节丢弃并通知远端停手 */
  const engageDrain = (): void => {
    drain.engage(performance.now())
    abortPeer()
    patch({ text: '正在中止传输…' })
    armDrainTimer()
  }

  /**
   * 取消当前传输。
   *
   * - 下载：对当前 offer 调 `skip()`（库推荐的干净跳过 —— 会话走到自然结束，远端不会乱码）；
   * - 上传：`Transfer` 只有 send / end、没有 skip，所以置停止标志让发送循环跳出，
   *   再 `session.abort()` 发 CAN 序列通知远端停手。
   *
   * `abort()` 之后同样可能冲刷，所以走排水收尾；`skip()` 是干净跳转，直接 `end()`。
   */
  const cancel = (): void => {
    uploadCancelled = true
    cancelled = true
    const active = session
    const offer = currentOffer
    let aborted = false
    try {
      if (offer) offer.skip()
      else if (active) {
        active.abort()
        aborted = true
      }
    } catch {
      // 会话已经结束
    }
    if (aborted) engageDrain()
    else if (drain.isActive) {
      // 排水期内再按 Ctrl+C：会话已经没了，有意义的是**再给对端补一次中止**并续上排水，
      // 而不是就此 end() —— 那会让还在猛发的远端接着刷屏
      abortPeer()
      armDrainTimer()
    } else end()
  }

  /**
   * 把文件逐份发给远端的 rz。**系统选框与拖拽投放两条入口都汇到这里** ——
   * 收尾（清会话 + 把焦点还给终端）只写一份。
   */
  const sendUploadFiles = async (active: ZmodemSession, files: ZmodemFile[]): Promise<void> => {
    awaitingFiles = false
    try {
      const CHUNK = 8192
      for (const file of files) {
        patch({
          direction: 'upload',
          name: file.name,
          text: `上传中：${file.name}`,
          progress: 0,
          awaitingFiles: false
        })
        const xfer = await active.send_offer({
          name: file.name,
          size: file.size,
          mtime: new Date()
        })
        if (!xfer) continue
        const total = file.data.byteLength
        let sent = 0
        let last = 0
        for (let off = 0; off < total; off += CHUNK) {
          // 已取消：停止发送（远端已由 cancel 的 abort 通知）
          if (uploadCancelled) return
          const chunk = file.data.subarray(off, Math.min(off + CHUNK, total))
          xfer.send(chunk)
          sent += chunk.length
          const now = performance.now()
          if (sent === total || now - last > 120) {
            last = now
            patch({ progress: (sent / total) * 100 })
          }
        }
        await xfer.end(new Uint8Array(0))
      }
      await active.close()
    } catch (err) {
      console.error('ZMODEM 上传失败', err)
    } finally {
      end()
      focusTerm()
    }
  }

  /** 进入「等文件」态：终端整体变成投放区（容器的拖放处理器），浮层里给「选择文件」按钮 */
  const awaitUploadFiles = (): void => {
    awaitingFiles = true
    patch({ awaitingFiles: true, text: '等待文件：拖进终端，或点「选择文件」' })
  }

  /**
   * 远端执行了 rz：先弹系统选框要文件。
   *
   * ⚠️ **用户取消（Esc / 关框）不再中止会话**：以前这里直接 `abort()` 把远端 rz 踢掉，但
   * 「系统选框弹出时鼠标指针看不见」是环境层的问题（Win11 24H2 + Chromium + 非默认指针方案），
   * 受影响的用户根本没法在框里选中东西 —— 一取消就中止等于把人堵死。所以取消只是**进入
   * 「等文件」态**：终端整体变成拖拽投放区，浮层里也给一个「选择文件」按钮重开选框。
   */
  const handleUpload = async (active: ZmodemSession): Promise<void> => {
    const bridge = getZmodemBridge()
    if (disposed) return
    term.blur()
    let files: ZmodemFile[] = []
    try {
      files = await bridge.pickFiles()
    } catch (err) {
      // 选框本身失败（桥坏了 / 没权限）：别把会话丢在死路上，落到「等文件」态让用户拖
      console.error('ZMODEM 选择文件失败', err)
    }
    if (files.length === 0) {
      awaitUploadFiles()
      return
    }
    await sendUploadFiles(active, files)
  }

  /** 远端在 sz：一份一份地收；每份先让用户选保存位置，收完立刻落盘 */
  const handleOffer = async (offer: ZmodemTransfer): Promise<void> => {
    const bridge = getZmodemBridge()
    // 已取消：批量传多个文件时，后续到达的 offer 一律跳过，直到会话自然结束
    if (cancelled) {
      try {
        offer.skip()
      } catch {
        // 忽略
      }
      return
    }
    /**
     * ⚠️ 防重入：`handleOffer` 是 async 的，中间要 await 系统「另存为」框与 `accept()`。
     * 远端若重复发 offer（重传 / 协议异常），第二次会**同时**叠弹一个保存框，且两次调用的
     * `finally` 会互相清 `currentOffer`。已有在飞的 offer 时，这份新的直接跳过。
     */
    if (currentOffer && currentOffer !== offer) {
      try {
        offer.skip()
      } catch {
        // 忽略
      }
      return
    }
    currentOffer = offer
    const details = offer.get_details()
    const rawName: string = details.name || 'file'
    const size: number = typeof details.size === 'number' ? details.size : 0
    patch({ direction: 'download', name: rawName, text: `下载中：${rawName}`, progress: 0 })
    // 远端给的文件名**不可信**（`../../x`、带控制字符的都出现过）：拿去当保存框默认名
    // 之前先剥掉路径分隔符与控制字符，免得出到别处去。显示仍用原名。
    const safeName = rawName.replace(/[\\/]/g, '_').replace(/[\x00-\x1f]/g, '').trim() || 'file'
    // 先选保存位置再开始收：用户取消能尽早退出，也免得白收一整份再丢
    const target = await bridge.askSavePath(safeName)
    focusTerm()
    // 等框期间会话可能已经被拆掉了：后面的 accept / 落盘都不该再跑
    if (disposed) return
    // 等对话框期间被取消了 / 用户没选：跳过这一份
    if (cancelled || !target) {
      try {
        offer.skip()
      } catch {
        // 忽略
      }
      // 只在仍指向本 offer 时置空（防重入那一关之后它理应就是本 offer）
      if (currentOffer === offer) currentOffer = null
      return
    }
    let downloaded = 0
    let last = 0
    // ⚠️ `input` 事件回传的是普通 number[]（不是 Uint8Array），只有 `.length` 可用：
    // 用 byteLength 会拿到 undefined，进度直接变 NaN
    offer.on('input', (payload) => {
      const chunk = payload as number[]
      downloaded += chunk.length
      if (!size) return
      const now = performance.now()
      if (downloaded >= size || now - last > 120) {
        last = now
        patch({ progress: Math.min(100, (downloaded / size) * 100) })
      }
    })
    try {
      // accept() 把整份收进内存（zmodem.js 的接口就是这样，大文件要留意）
      const spool = await offer.accept()
      // 收的过程中取消了：丢弃已收数据，不落盘
      if (cancelled) return
      const total = spool.reduce((sum, part) => sum + part.byteLength, 0)
      const merged = new Uint8Array(total)
      let off = 0
      for (const part of spool) {
        merged.set(part, off)
        off += part.byteLength
      }
      const saved = await bridge.saveFileTo(target, merged)
      // web 端没有路径，`saved` 就是下载用的文件名；失败（null）如实说
      patch({ progress: 100, text: saved ? `已保存：${saved}` : '保存失败' })
    } catch (err) {
      // 下载失败多半意味着会话已坏：先中止远端再排水，免得它继续把字节灌进终端
      console.error('ZMODEM 下载失败', err)
      try {
        // 顺带把 Sentry 内部的 `_zsession` 经 `session_end` 清掉，排水结束后嗅探器是干净的
        session?.abort()
      } catch {
        // 会话可能已结束
      }
      engageDrain()
    } finally {
      if (currentOffer === offer) currentOffer = null
    }
  }

  /**
   * zmodem.js 的 Sentry：扫描所有入站字节，认出 rz/sz 的 ZMODEM 会话后就接管。
   * 非 ZMODEM 字节由 `to_terminal` 原样吐回来正常渲染（所以能一直挂着、没有副作用）。
   *
   * **SSH 与本机终端都挂**（`enabled`，缺省开）：rz/sz 是**被连的那一侧**上的程序 ——
   * web 的「本机终端」其实是**服务端**的 shell（服务端装了 lrzsz 就能用），desktop 的本机
   * shell 通常没有 rz/sz，挂了也永远不会触发，代价为零。容器工作台传 false。
   */
  const sentry = enabled
    ? new Zmodem.Sentry({
        to_terminal: (octets: number[]) => {
          // 异常结束后的排水期：丢弃到达的字节（远端可能还在猛发文件内容），不刷屏
          if (drain.absorb(performance.now())) return
          try {
            writeTerminalOutput(new Uint8Array(octets))
          } catch {
            // term 正在 dispose
          }
        },
        sender: (octets: number[] | Uint8Array) => {
          // 二进制键入：走 TerminalProcess.write 的 Uint8Array 分支
          processRef.current?.write(octets instanceof Uint8Array ? octets : new Uint8Array(octets))
        },
        on_detect: (detection) => {
          let detected: ZmodemSession
          try {
            detected = detection.confirm()
          } catch {
            return
          }
          session = detected
          // 新会话：清掉上一轮遗留的取消 / 停止标志，以及可能还挂着的排水窗口
          clearDrainTimer()
          drain.disengage()
          uploadCancelled = false
          cancelled = false
          currentOffer = null
          emit({
            direction: detected.type === 'send' ? 'upload' : 'download',
            name: '',
            text: detected.type === 'send' ? '等待选择要上传的文件…' : '下载中…',
            progress: 0
          })
          if (detected.type === 'send') {
            // type 'send' = 远端在 rz，等我们发文件过去
            // 远端 rz 自己超时退出时也要收起浮层：否则「等文件」态会一直挂着，等于骗人
            detected.on('session_end', () => end())
            void handleUpload(detected)
          } else {
            // type 'receive' = 远端在 sz，把文件发过来给我们
            detected.on('offer', (payload) => void handleOffer(payload as ZmodemTransfer))
            detected.on('session_end', () => end())
            detected.start()
          }
        },
        on_retract: () => undefined
      })
    : null

  return {
    consume: (data) => {
      // 排水期**在源头丢弃**：既不让字节进 Sentry、也不写终端。
      // 不进 Sentry 的意义：对端若不理会 CAN、重发 ZRQINIT，也不会在排水期内触发新的
      // `on_detect`（否则又是一个「另存为」框）；不写终端 = 止住刷屏的那一刀。
      if (drain.absorb(performance.now())) return
      if (!sentry) {
        writeTerminalOutput(data)
        return
      }
      consumeZmodemChunk(data, (bytes) => sentry.consume(bytes), (error) => {
        console.error('ZMODEM 数据解析失败，已中止传输', error)
        uploadCancelled = true
        cancelled = true
        try {
          session?.abort()
        } catch {
          // 会话可能已结束
        }
        // 走排水收尾：会话烂掉后 Sentry 会把后续每字节直吐终端，这里丢掉它们
        engageDrain()
      })
    },
    interrupt: () => {
      if (!session && !drain.isActive) return false
      cancel()
      return true
    },
    isBusy: () => session !== null,
    isAwaitingFiles: () => awaitingFiles,
    cancel,
    dropFiles: (files) => {
      const active = session
      if (!active) return
      void (async () => {
        try {
          const converted: ZmodemFile[] = await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              size: file.size,
              data: new Uint8Array(await file.arrayBuffer())
            }))
          )
          await sendUploadFiles(active, converted)
        } catch (err) {
          console.error('ZMODEM 读取拖入的文件失败', err)
          awaitUploadFiles()
        }
      })()
    },
    pickFiles: () => {
      const active = session
      if (active) void handleUpload(active)
    },
    dispose: () => {
      disposed = true
      clearDrainTimer()
      drain.disengage()
      session = null
      currentOffer = null
      uploadCancelled = false
      cancelled = false
      awaitingFiles = false
      emit(null)
      onDropActive(false)
    }
  }
}
