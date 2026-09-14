// zmodem.js 不自带类型声明，这里做最小声明（运行期 API 以源码为准）。
declare module 'zmodem.js' {
  const Zmodem: {
    Sentry: new (options: {
      to_terminal: (octets: number[]) => void
      sender: (octets: number[] | Uint8Array) => void
      on_detect: (detection: {
        confirm: () => ZmodemSession
        deny: () => void
        is_valid: () => boolean
      }) => void
      on_retract: () => void
    }) => { consume: (input: Uint8Array | number[]) => void }
    Browser: Record<string, unknown>
    [key: string]: unknown
  }
  export default Zmodem
}

interface ZmodemSession {
  type: 'send' | 'receive'
  on: (event: string, cb: (payload?: unknown) => void) => void
  start: () => void
  close: () => Promise<void>
  abort: () => void
  send_offer: (params: {
    name: string
    size: number
    mtime?: Date
  }) => Promise<ZmodemTransfer | undefined>
  [key: string]: unknown
}

interface ZmodemTransfer {
  send: (data: Uint8Array | number[]) => void
  end: (data?: Uint8Array | number[]) => Promise<void>
  get_details: () => { name: string; size: number; [k: string]: unknown }
  accept: (opts?: { on_input?: string | ((p: Uint8Array) => void) }) => Promise<Uint8Array[]>
  skip: () => void
  on: (event: string, cb: (payload?: unknown) => void) => void
  [key: string]: unknown
}
