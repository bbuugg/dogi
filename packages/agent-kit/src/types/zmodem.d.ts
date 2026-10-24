/**
 * `zmodem.js` 的最小类型声明（该包不自带 .d.ts，运行期 API 以源码为准）。
 *
 * 只声明 `TerminalPanel` 真正用到的部分：`Sentry`（嗅探入站字节里的 ZMODEM 会话）
 * 与它确认后拿到的 session / transfer 形状。形状照 zmodem.js 0.1.x 源码
 * （`lib/sentry.js` / `lib/zsession.js` / `lib/ztransfer.js`）与 dogi 的同名声明。
 */
declare module 'zmodem.js' {
  /** `Sentry` 嗅探到的候选会话（`confirm()` 之后字节就交给会话自己消费） */
  export interface ZmodemDetection {
    confirm: () => ZmodemSession
    /** 不认（把已缓冲的字节原样交回终端） */
    deny: () => void
    is_valid: () => boolean
  }

  export interface ZmodemSentry {
    /** 喂入一段入站字节：ZMODEM 帧被吞掉，其余经 `to_terminal` 回吐 */
    consume: (input: Uint8Array | number[]) => void
  }

  /** 一条 ZMODEM 会话：`send` = 远端在 rz（本地上传），`receive` = 远端在 sz（本地下载） */
  export interface ZmodemSession {
    type: 'send' | 'receive'
    on: (event: string, cb: (payload?: unknown) => void) => void
    start: () => void
    close: () => Promise<void>
    /** 中止会话（发 CAN 序列，远端会停手） */
    abort: () => void
    /** 上传：报一个文件并拿到它的传输句柄 */
    send_offer: (params: {
      name: string
      size: number
      mtime?: Date
    }) => Promise<ZmodemTransfer | undefined>
    [key: string]: unknown
  }

  export interface ZmodemTransfer {
    /** 上传：送一段字节 */
    send: (data: Uint8Array | number[]) => void
    /** 上传：收尾（`data` 是尾部残留，通常传空） */
    end: (data?: Uint8Array | number[]) => Promise<void>
    /** 下载：这一批的元信息（`name` / `size`） */
    get_details: () => { name: string; size: number; [k: string]: unknown }
    /**
     * 下载：接受并收完整个文件，返回分片数组（**整份在内存里**，大文件要留意）。
     * `on_input` 用来收进度 —— zmodem.js 回吐的是普通 `number[]`（只有 `.length` 可用）。
     */
    accept: (opts?: { on_input?: string | ((p: number[]) => void) }) => Promise<Uint8Array[]>
    /** 下载：跳过当前文件（干净跳过，会话继续） */
    skip: () => void
    on: (event: string, cb: (payload?: unknown) => void) => void
    [key: string]: unknown
  }

  const Zmodem: {
    Sentry: new (options: {
      /** 非 ZMODEM 字节回吐给终端渲染 */
      to_terminal: (octets: number[]) => void
      /** 会话发出的字节（要写回远端） */
      sender: (octets: number[] | Uint8Array) => void
      on_detect: (detection: ZmodemDetection) => void
      on_retract: () => void
    }) => ZmodemSentry
    Browser: Record<string, unknown>
    [key: string]: unknown
  }
  export default Zmodem
}
