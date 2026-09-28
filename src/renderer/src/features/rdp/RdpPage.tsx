import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Form, Input, Modal, Spin, message } from 'antd'
import { Monitor, RotateCw, TriangleAlert } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import {
  RdpToolbar,
  parseSizeMode,
  readStoredSizeMode,
  writeStoredSizeMode,
  type RdpSizeMode
} from './RdpToolbar'
import type { RdpCredentials } from '@shared/types'

/**
 * RDP 远程桌面页（主区域标签）：嵌入式 WASM 客户端（ironrdp-wasm）+ 主进程本地桥。
 *
 * 数据路径：WASM 客户端 --WebSocket(127.0.0.1)--> 主进程本地桥（RDCleanPath 握手 / TLS）
 * --> RDP 服务器。标签 id（rdp-<profileId>）同时是本地桥的 connId；卸载时关会话并收桥。
 *
 * 凭据来自主机配置（kind = rdp）：打开标签即读配置 —— 密码已保存就直接连接，
 * 没有则弹对话框收集（可勾选保存回配置，主进程 safeStorage 加密落盘）。
 * 地址 / 端口一律以主机配置为准（桥按配置固定目标，destination 必须与之一致）。
 *
 * 键盘：按物理键位映射成 RDP 扫描码（扩展键带 0xE0 前缀）发给远端 —— 中文输入走
 * 远端输入法组字（经典远程桌面路径）；本地输入法合成（compositionend）也会以
 * unicode 事件兜底转发。鼠标坐标按 object-fit: contain 的实际绘制区换算。
 *
 * 本轮范围外（有意不做，见方案文档）：本地↔远端剪贴板 / 音频 / 磁盘重定向、
 * 经跳板机与隧道走 RDP。
 */

type IronRdpModule = typeof import('ironrdp-wasm')
/** 类名作类型引用即实例类型（这两个类的构造函数是私有的，InstanceType 接不住） */
type RdpSessionHandle = import('ironrdp-wasm').Session
type RdpInputTransaction = import('ironrdp-wasm').InputTransaction

let ironRdpPromise: Promise<IronRdpModule> | null = null

/**
 * 懒加载并初始化 WASM 模块（模块级缓存：所有 RDP 标签共用一份实例）。
 *
 * wasm 文件由 scripts/copy-rdp.cjs 拷到 public/rdp/；开发态由 Vite 静态服务提供，
 * 打包后渲染端跑在 file:// 下（fetch 不支持 file: 协议），改由主进程 IPC 读字节。
 */
function loadIronRdp(): Promise<IronRdpModule> {
  if (!ironRdpPromise) {
    ironRdpPromise = (async () => {
      const mod = await import('ironrdp-wasm')
      if (import.meta.env.DEV) {
        const response = await fetch('/rdp/rdp_client_bg.wasm')
        if (!response.ok) throw new Error(`加载 RDP WASM 失败：HTTP ${response.status}`)
        await mod.default({ module_or_path: response })
      } else {
        await mod.default({ module_or_path: await window.api.rdp.wasm() })
      }
      mod.setup('info')
      return mod
    })().catch((e: unknown) => {
      // 失败不缓存，下次重连可以重试
      ironRdpPromise = null
      throw e
    })
  }
  return ironRdpPromise
}

/**
 * 浏览器 KeyboardEvent.code → RDP Set-1 扫描码（扩展键编码为 0xE0xx）。
 * 移植自 mstsc.js 的键位表（与 electerm 同源）；非美式布局中映射外的可打印
 * 字符走 unicode 事件兜底（见 keydown 处理）。
 */
const KEY_SCANCODES: Record<string, number> = {
  Escape: 0x0001,
  Digit1: 0x0002,
  Digit2: 0x0003,
  Digit3: 0x0004,
  Digit4: 0x0005,
  Digit5: 0x0006,
  Digit6: 0x0007,
  Digit7: 0x0008,
  Digit8: 0x0009,
  Digit9: 0x000a,
  Digit0: 0x000b,
  Minus: 0x000c,
  Equal: 0x000d,
  Backspace: 0x000e,
  Tab: 0x000f,
  KeyQ: 0x0010,
  KeyW: 0x0011,
  KeyE: 0x0012,
  KeyR: 0x0013,
  KeyT: 0x0014,
  KeyY: 0x0015,
  KeyU: 0x0016,
  KeyI: 0x0017,
  KeyO: 0x0018,
  KeyP: 0x0019,
  BracketLeft: 0x001a,
  BracketRight: 0x001b,
  Enter: 0x001c,
  ControlLeft: 0x001d,
  KeyA: 0x001e,
  KeyS: 0x001f,
  KeyD: 0x0020,
  KeyF: 0x0021,
  KeyG: 0x0022,
  KeyH: 0x0023,
  KeyJ: 0x0024,
  KeyK: 0x0025,
  KeyL: 0x0026,
  Semicolon: 0x0027,
  Quote: 0x0028,
  Backquote: 0x0029,
  ShiftLeft: 0x002a,
  Backslash: 0x002b,
  KeyZ: 0x002c,
  KeyX: 0x002d,
  KeyC: 0x002e,
  KeyV: 0x002f,
  KeyB: 0x0030,
  KeyN: 0x0031,
  KeyM: 0x0032,
  Comma: 0x0033,
  Period: 0x0034,
  Slash: 0x0035,
  ShiftRight: 0x0036,
  NumpadMultiply: 0x0037,
  AltLeft: 0x0038,
  Space: 0x0039,
  CapsLock: 0x003a,
  F1: 0x003b,
  F2: 0x003c,
  F3: 0x003d,
  F4: 0x003e,
  F5: 0x003f,
  F6: 0x0040,
  F7: 0x0041,
  F8: 0x0042,
  F9: 0x0043,
  F10: 0x0044,
  Pause: 0x0045,
  ScrollLock: 0x0046,
  Numpad7: 0x0047,
  Numpad8: 0x0048,
  Numpad9: 0x0049,
  NumpadSubtract: 0x004a,
  Numpad4: 0x004b,
  Numpad5: 0x004c,
  Numpad6: 0x004d,
  NumpadAdd: 0x004e,
  Numpad1: 0x004f,
  Numpad2: 0x0050,
  Numpad3: 0x0051,
  Numpad0: 0x0052,
  NumpadDecimal: 0x0053,
  PrintScreen: 0x0054,
  IntlBackslash: 0x0056,
  F11: 0x0057,
  F12: 0x0058,
  NumpadEqual: 0x0059,
  NumpadEnter: 0xe01c,
  ControlRight: 0xe01d,
  NumpadDivide: 0xe035,
  AltRight: 0xe038,
  NumLock: 0xe045,
  Home: 0xe047,
  ArrowUp: 0xe048,
  PageUp: 0xe049,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  End: 0xe04f,
  ArrowDown: 0xe050,
  PageDown: 0xe051,
  Insert: 0xe052,
  Delete: 0xe053,
  OSLeft: 0xe05b,
  OSRight: 0xe05c,
  ContextMenu: 0xe05d
}

/** IronError.kind() 的错误码 → 用户可读文案（与 ironrdp-wasm 的 IronErrorKind 对应） */
const IRON_ERROR_KIND_TEXT: Record<number, string> = {
  0: '连接出错',
  1: '用户名或密码错误',
  2: '登录被拒绝（检查账号权限 / 域设置）',
  3: '服务器拒绝访问',
  4: 'RDP 接入握手失败',
  5: '无法连接本地 RDP 桥',
  6: '协议协商失败（检查服务器 RDP 安全设置）'
}

/** 把 WASM / JS 异常整理成可读的错误文案（IronRDP 错误对象带 kind() 与 backtrace()） */
function formatRdpError(e: unknown): string {
  if (e && typeof e === 'object' && '__wbg_ptr' in e) {
    try {
      const err = e as unknown as { kind: () => number; backtrace: () => string }
      const label = IRON_ERROR_KIND_TEXT[err.kind()] ?? `错误码 ${err.kind()}`
      const backtrace = err.backtrace()
      return backtrace ? `${label}：${backtrace}` : label
    } catch {
      // 落到通用分支
    }
  }
  if (e instanceof Error) return e.message
  return String(e)
}

const clampNumber = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
const toEven = (v: number): number => Math.max(2, Math.round(v / 2) * 2)

/** 容器实际尺寸 → 远端桌面尺寸（夹到合理范围、取偶数；隐藏时退回 1280×720） */
function measureDesktopSize(el: HTMLElement | null): { width: number; height: number } {
  const rect = el?.getBoundingClientRect()
  const w = rect && rect.width > 0 ? rect.width : 1280
  const h = rect && rect.height > 0 ? rect.height : 720
  return { width: toEven(clampNumber(w, 640, 3840)), height: toEven(clampNumber(h, 480, 2160)) }
}

/**
 * 画布按 object-fit: contain 显示，元素框与位图很少同尺寸（一条轴会有留边）。
 * 直接用元素框算缩放会把指针送偏（经典的「只有左上角区域有反应」），这里按实际
 * 绘制区换算（与 electerm 的 remote-pointer.js 同思路）。
 */
function eventToRemotePos(
  e: MouseEvent,
  el: HTMLElement,
  sourceWidth: number,
  sourceHeight: number
): { x: number; y: number } {
  if (!sourceWidth || !sourceHeight) return { x: 0, y: 0 }
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return { x: 0, y: 0 }
  const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight)
  if (!scale) return { x: 0, y: 0 }
  const left = rect.left + (rect.width - sourceWidth * scale) / 2
  const top = rect.top + (rect.height - sourceHeight * scale) / 2
  return {
    x: clampNumber(Math.round((e.clientX - left) / scale), 0, sourceWidth - 1),
    y: clampNumber(Math.round((e.clientY - top) / scale), 0, sourceHeight - 1)
  }
}

interface RdpCredFormValues {
  username: string
  password: string
  domain?: string
  /** 勾选后把本次凭据写回主机配置（密码走系统加密存储） */
  saveToHost?: boolean
}

/** 标签内收集的会话凭据（端口不在这里维护：连接时按主机配置现读现用） */
type RdpSessionCreds = Pick<RdpCredentials, 'username' | 'password' | 'domain'>

/** 标签状态机：loading（读配置）/ prompt（弹凭据）/ idle（取消后待命）/ connecting / connected / ended（断开） */
type RdpPhase = 'loading' | 'prompt' | 'idle' | 'connecting' | 'connected' | 'ended'

/**
 * 远程桌面页（主区域标签）。
 *
 * 打开标签即读主机配置：密码已保存就直接连接；没有则弹对话框收集（用户名 / 域
 * 预填配置值，密码必填，可勾选保存回配置 —— 主进程 safeStorage 加密落盘）。
 * 连接失败 / 会话结束的遮罩上可沿用当前凭据「重新连接」或「修改凭据」重来。
 */
export function RdpPage({ profileId }: { profileId: string }) {
  const profile = useAppStore((s) => s.profiles.find((p) => p.id === profileId))
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const host = profile?.host ?? ''

  /** 标签 id 同时作为本地桥的 connId（确定性、幂等，一个主机只开一座桥） */
  const [connId] = useState(() => `rdp-${profileId}`)
  const [form] = Form.useForm<RdpCredFormValues>()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<RdpSessionHandle | null>(null)
  const modRef = useRef<IronRdpModule | null>(null)
  /** 连接尝试的代际号：被新一轮尝试取代的旧异步流程会安静退出（不碰桥与状态） */
  const epochRef = useRef(0)

  const [phase, setPhase] = useState<RdpPhase>('loading')
  const [creds, setCreds] = useState<RdpSessionCreds | null>(null)
  /** 上次读到的主机配置快照（预填对话框 / 展示端口；保存回配置后由 refreshProfiles 刷新） */
  const [configCreds, setConfigCreds] = useState<RdpCredentials | null>(null)
  /** 不可恢复错误（主机配置不存在 / 不是 rdp 类型）：整页提示，不再渲染连接流程 */
  const [fatal, setFatal] = useState<string | null>(null)
  /** 每次「重新连接」自增，触发连接 effect 重跑（凭据不变也重连） */
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  /** 远端桌面分辨率档位（工具条选择；'auto' = 跟随面板尺寸） */
  const [sizeMode, setSizeMode] = useState<RdpSizeMode>(readStoredSizeMode)
  /** 远端当前桌面尺寸（工具条展示用，与画布位图尺寸一致） */
  const [remoteSize, setRemoteSize] = useState({ width: 0, height: 0 })
  /** 连接流程里读最新档位：切分辨率不该重跑连接 effect（那会重连），所以走 ref */
  const sizeModeRef = useRef(sizeMode)
  useEffect(() => {
    sizeModeRef.current = sizeMode
  }, [sizeMode])

  /** 以会话当前的桌面尺寸同步画布位图尺寸（远端请求改分辨率后回调触发） */
  const syncCanvasFromSession = useCallback((): void => {
    const session = sessionRef.current
    const canvas = canvasRef.current
    if (!session || !canvas) return
    try {
      const size = session.desktopSize()
      canvas.width = size.width
      canvas.height = size.height
      setRemoteSize({ width: size.width, height: size.height })
      size.free()
    } catch {
      // 会话可能刚结束
    }
  }, [])

  // 打开标签即读主机配置：密码已保存就直接连接，没有则弹对话框收集
  useEffect(() => {
    let alive = true
    void window.api.rdp
      .credentials(profileId)
      .then((c) => {
        if (!alive) return
        setConfigCreds(c)
        if (c.password) {
          setCreds({ username: c.username, password: c.password, domain: c.domain })
          return
        }
        form.setFieldsValue({
          username: c.username,
          password: '',
          domain: c.domain,
          saveToHost: false
        })
        setPhase('prompt')
      })
      .catch((e: unknown) => {
        if (alive) setFatal(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [profileId, form])

  // 卸载：关掉 WASM 会话并收起本地桥（重复关闭是幂等的）
  useEffect(() => {
    return () => {
      const session = sessionRef.current
      sessionRef.current = null
      if (session) {
        try {
          session.shutdown()
        } catch {
          // 会话可能已结束
        }
      }
      void window.api.rdp.close(connId)
    }
  }, [connId])

  // 连接流程：凭据就绪（或每次重连）后：开桥 → 加载 WASM → connect → 进入事件循环。
  // 所有 await 之后都检查代际号：被新尝试取代 / 组件卸载时安静退出。
  useEffect(() => {
    if (!creds || !host) return
    const myToken = ++epochRef.current
    let cancelled = false
    const canvas = canvasRef.current
    void (async () => {
      setPhase('connecting')
      setError(null)
      let session: RdpSessionHandle | null = null
      try {
        // 端口以主机配置为准（可能刚被编辑过）：桥按配置固定目标，destination 必须与之一致
        const { port } = await window.api.rdp.credentials(profileId)
        if (myToken !== epochRef.current || cancelled) return
        const { wsUrl } = await window.api.rdp.open(connId, profileId)
        if (myToken !== epochRef.current) return
        if (cancelled) {
          // 真卸载（非 StrictMode 重跑）：把可能刚注册的桥收掉
          void window.api.rdp.close(connId)
          return
        }
        const mod = await loadIronRdp()
        if (myToken !== epochRef.current) return
        if (cancelled) {
          void window.api.rdp.close(connId)
          return
        }
        modRef.current = mod
        if (!canvas) throw new Error('远程桌面画布未就绪')
        // 手动档位优先（用户在工具条上选了固定分辨率），否则跟随面板尺寸
        const size = parseSizeMode(sizeModeRef.current) ?? measureDesktopSize(wrapRef.current)
        canvas.width = size.width
        canvas.height = size.height
        setRemoteSize({ width: size.width, height: size.height })
        // WASM 内部用 getContext('2d')（不带参数）取上下文，而同一 canvas 上的第二次
        // getContext 会直接返回已建好的那个 —— 所以这里先把参数定死：
        //   alpha: false        远端画面本就不透明（wasm 侧每帧还把 alpha 强写成 0xFF），
        //                       省掉 putImageData 的逐像素混合；
        //   desynchronized: true 走低延迟合成路径：脏区更新不等合成器同步，高频小块
        //                       重绘时画面更跟手（平台不支持时浏览器会自行忽略该选项）。
        if (!canvas.getContext('2d', { alpha: false, desynchronized: true })) {
          throw new Error('无法创建远程桌面画布上下文')
        }

        const builder = new mod.SessionBuilder()
        builder.username(creds.username)
        builder.password(creds.password)
        if (creds.domain) builder.serverDomain(creds.domain)
        // 桥会校验 destination 与它固定的目标一致（防任意端口转发）
        builder.destination(`${host}:${port}`)
        builder.proxyAddress(wsUrl)
        builder.authToken('none')
        builder.desktopSize(new mod.DesktopSize(size.width, size.height))
        builder.renderCanvas(canvas)
        // Windows 默认要求 NLA（CredSSP）：显式打开，否则协商阶段就会被服务器拒绝
        builder.extension(new mod.Extension('enable_credssp', true))
        builder.setCursorStyleCallbackContext(canvas)
        builder.setCursorStyleCallback((style: string) => {
          canvas.style.cursor = style || 'default'
        })
        builder.canvasResizedCallback(() => {
          syncCanvasFromSession()
        })

        session = await builder.connect()
        if (myToken !== epochRef.current || cancelled) {
          try {
            session.shutdown()
          } catch {
            // 忽略
          }
          if (cancelled && myToken === epochRef.current) void window.api.rdp.close(connId)
          return
        }
        sessionRef.current = session
        syncCanvasFromSession()
        setPhase('connected')
        canvas.focus()

        const active = session
        void active
          .run()
          .then((info) => {
            if (myToken !== epochRef.current || cancelled) return
            setPhase('ended')
            setError(`远程会话已结束：${info.reason()}`)
          })
          .catch((e: unknown) => {
            if (myToken !== epochRef.current || cancelled) return
            setPhase('ended')
            setError(formatRdpError(e))
          })
          .finally(() => {
            if (sessionRef.current === active) sessionRef.current = null
          })
      } catch (e) {
        if (myToken !== epochRef.current || cancelled) return
        setPhase('ended')
        setError(formatRdpError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [creds, attempt, host, profileId, connId, syncCanvasFromSession])

  // 输入转发：键盘（扫描码 + unicode 兜底 + 输入法合成）、鼠标、滚轮
  useEffect(() => {
    if (phase !== 'connected') return
    const canvas = canvasRef.current
    if (!canvas) return

    const sendEvents = (build: (tx: RdpInputTransaction, mod: IronRdpModule) => void): void => {
      const session = sessionRef.current
      const mod = modRef.current
      if (!session || !mod) return
      try {
        const tx = new mod.InputTransaction()
        build(tx, mod)
        session.applyInputs(tx)
      } catch (e) {
        console.warn('[RDP] 输入转发失败：', e)
      }
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!sessionRef.current || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      const scancode = KEY_SCANCODES[e.code]
      if (scancode !== undefined) {
        sendEvents((tx, mod) => tx.addEvent(mod.DeviceEvent.keyPressed(scancode)))
        return
      }
      // 映射外的可打印字符（非美式布局等）：走 RDP unicode 输入通道补发（按下 + 抬起）
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const ch = e.key
        sendEvents((tx, mod) => {
          tx.addEvent(mod.DeviceEvent.unicodePressed(ch))
          tx.addEvent(mod.DeviceEvent.unicodeReleased(ch))
        })
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (!sessionRef.current || e.isComposing) return
      e.preventDefault()
      const scancode = KEY_SCANCODES[e.code]
      if (scancode !== undefined) {
        sendEvents((tx, mod) => tx.addEvent(mod.DeviceEvent.keyReleased(scancode)))
      }
    }

    // 本地输入法合成提交（画布上少见，但有则按 unicode 事件逐个字符转发）
    const onCompositionEnd = (e: CompositionEvent): void => {
      const text = e.data
      if (!text) return
      sendEvents((tx, mod) => {
        for (const ch of text) {
          tx.addEvent(mod.DeviceEvent.unicodePressed(ch))
          tx.addEvent(mod.DeviceEvent.unicodeReleased(ch))
        }
      })
    }

    // 鼠标移动是最高频的输入事件（高刷屏每秒上百次），而每次都要建一个 WASM 输入事务、
    // 编码一条 RDP 输入 PDU 发出去 —— 远端只认最新坐标，中间点没有意义。合并到下一帧
    // 只发最后一个位置（mstsc 同款行为）；按下 / 抬起 / 滚轮前先冲掉挂起坐标，
    // 否则点击会落在旧位置上。
    let pendingMove: { x: number; y: number } | null = null
    let moveFrame = 0
    const flushMove = (): void => {
      moveFrame = 0
      if (!pendingMove) return
      const { x, y } = pendingMove
      pendingMove = null
      sendEvents((tx, mod) => tx.addEvent(mod.DeviceEvent.mouseMove(x, y)))
    }
    const flushPendingMove = (): void => {
      if (moveFrame) {
        cancelAnimationFrame(moveFrame)
        moveFrame = 0
      }
      flushMove()
    }

    const onMouseMove = (e: MouseEvent): void => {
      if (!sessionRef.current) return
      pendingMove = eventToRemotePos(e, canvas, canvas.width, canvas.height)
      if (!moveFrame) moveFrame = requestAnimationFrame(flushMove)
    }

    const onMouseDown = (e: MouseEvent): void => {
      e.preventDefault()
      canvas.focus()
      flushPendingMove()
      sendEvents((tx, mod) => tx.addEvent(mod.DeviceEvent.mouseButtonPressed(e.button)))
    }

    const onMouseUp = (e: MouseEvent): void => {
      e.preventDefault()
      flushPendingMove()
      sendEvents((tx, mod) => tx.addEvent(mod.DeviceEvent.mouseButtonReleased(e.button)))
    }

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      flushPendingMove()
      if (e.deltaY !== 0) {
        sendEvents((tx, mod) =>
          tx.addEvent(mod.DeviceEvent.wheelRotations(true, e.deltaY > 0 ? -1 : 1, mod.RotationUnit.Line))
        )
      }
      if (e.deltaX !== 0) {
        sendEvents((tx, mod) =>
          tx.addEvent(mod.DeviceEvent.wheelRotations(false, e.deltaX > 0 ? -1 : 1, mod.RotationUnit.Line))
        )
      }
    }

    const onContextMenu = (e: MouseEvent): void => e.preventDefault()

    // 窗口失焦时释放所有按键：避免切走时按住的修饰键在远端「卡住」
    const onWindowBlur = (): void => {
      const session = sessionRef.current
      if (!session) return
      try {
        session.releaseAllInputs()
      } catch {
        // 忽略
      }
    }

    canvas.addEventListener('keydown', onKeyDown)
    canvas.addEventListener('keyup', onKeyUp)
    canvas.addEventListener('compositionend', onCompositionEnd)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      canvas.removeEventListener('keydown', onKeyDown)
      canvas.removeEventListener('keyup', onKeyUp)
      canvas.removeEventListener('compositionend', onCompositionEnd)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('blur', onWindowBlur)
      if (moveFrame) cancelAnimationFrame(moveFrame)
    }
  }, [phase])

  // 容器尺寸变化（面板拖拽 / 分屏 / 窗口缩放）→ 防抖后同步远端桌面分辨率。
  // 手动档位下不动：分辨率由用户选定，画面交给 canvas 的 object-contain 缩放。
  useEffect(() => {
    if (phase !== 'connected' || sizeMode !== 'auto') return
    const wrap = wrapRef.current
    if (!wrap) return
    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const session = sessionRef.current
        const canvas = canvasRef.current
        if (!session || !canvas) return
        const rect = wrap.getBoundingClientRect()
        // 标签被隐藏（display:none）时尺寸为 0：跳过，等切回可见再处理
        if (rect.width < 200 || rect.height < 150) return
        const next = measureDesktopSize(wrap)
        try {
          const current = session.desktopSize()
          const same = current.width === next.width && current.height === next.height
          current.free()
          if (same) return
          session.resize(next.width, next.height)
          canvas.width = next.width
          canvas.height = next.height
        } catch {
          // 会话可能刚结束
        }
      }, 400)
    })
    observer.observe(wrap)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [phase, sizeMode])

  /** 发送 Ctrl+Alt+Del（SAS 序列，用于 Windows 登录 / 锁屏解锁；与 FreeRDP 一致的扩展 Delete） */
  const sendCtrlAltDel = useCallback((): void => {
    // 点工具条按钮会把焦点从画布拿走（键盘事件就发不到远端了），点完还回去
    canvasRef.current?.focus()
    const session = sessionRef.current
    const mod = modRef.current
    if (!session || !mod) return
    try {
      const tx = new mod.InputTransaction()
      const sequence: Array<[number, boolean]> = [
        [0x1d, true],
        [0x38, true],
        [0xe053, true],
        [0xe053, false],
        [0x38, false],
        [0x1d, false]
      ]
      for (const [code, down] of sequence) {
        tx.addEvent(down ? mod.DeviceEvent.keyPressed(code) : mod.DeviceEvent.keyReleased(code))
      }
      session.applyInputs(tx)
    } catch (e) {
      console.warn('[RDP] 发送 Ctrl+Alt+Del 失败：', e)
    }
  }, [])

  /**
   * 切换远端桌面分辨率档位（工具条下拉）：
   * - 'auto'：按容器当前尺寸重新对齐（之后容器变化继续自动跟随）；
   * - 手动档位：直接下发 `session.resize`，画布位图同步成该尺寸（显示交给 object-contain 缩放）。
   * 未连接 / 已断开时只记档位并改画布，下次连接按它开画布（session 不参与）。
   */
  const applySizeMode = useCallback((mode: RdpSizeMode): void => {
    setSizeMode(mode)
    writeStoredSizeMode(mode)
    const next = parseSizeMode(mode) ?? measureDesktopSize(wrapRef.current)
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = next.width
      canvas.height = next.height
    }
    setRemoteSize(next)
    // 下拉占用焦点期间键盘发不到远端，切完把焦点还给画布
    canvasRef.current?.focus()
    const session = sessionRef.current
    if (!session) return
    try {
      session.resize(next.width, next.height)
    } catch (e) {
      console.warn('[RDP] 切换远端分辨率失败：', e)
    }
  }, [])

  /** 打开凭据对话框：预填当前凭据 / 主机配置（修改凭据入口也走这里） */
  const openCredPrompt = useCallback((): void => {
    form.setFieldsValue({
      username: creds?.username ?? configCreds?.username ?? profile?.username ?? '',
      // 已输入 / 已保存的密码直接带回，改完用户名后一键重连；留空则重新输入
      password: creds?.password ?? '',
      domain: creds?.domain ?? configCreds?.domain ?? '',
      saveToHost: false
    })
    setPhase('prompt')
  }, [form, creds, configCreds, profile])

  /** 把凭据写回主机配置（密码由主进程 safeStorage 加密落盘） */
  const saveCredsToProfile = async (c: RdpSessionCreds): Promise<void> => {
    if (!profile) {
      message.error('主机配置已被删除，凭据未保存')
      return
    }
    try {
      await window.api.ssh.save({
        ...profile,
        username: c.username,
        password: c.password,
        domain: c.domain || undefined,
        updatedAt: Date.now()
      })
      await refreshProfiles()
      message.success('凭据已保存到主机配置')
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 提交凭据对话框：勾选「保存到主机配置」时写回配置，随后发起连接 */
  const submitCreds = async (): Promise<void> => {
    let values: RdpCredFormValues
    try {
      values = await form.validateFields()
    } catch {
      return // 校验失败：保持弹窗
    }
    const next: RdpSessionCreds = {
      username: values.username.trim(),
      password: values.password,
      domain: (values.domain ?? '').trim()
    }
    if (values.saveToHost) void saveCredsToProfile(next)
    setCreds(next)
  }

  // 主机配置缺失 / 类型不对（标签开着时主机被删等）：整页提示，不再渲染连接流程
  if (fatal) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 overflow-hidden bg-black p-6 text-center">
        <TriangleAlert className="size-10 text-amber-500/80" />
        <div className="text-sm font-medium text-foreground">无法打开远程桌面</div>
        <div className="max-w-md break-all text-xs text-muted-foreground">{fatal}</div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="relative h-full min-h-0 w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className="absolute inset-0 h-full w-full cursor-default object-contain outline-none"
      />

      {(phase === 'loading' || phase === 'connecting') && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <Spin />
          <div className="text-xs text-muted-foreground">
            {phase === 'loading' ? '正在读取主机配置 …' : `正在连接 ${host} …`}
          </div>
        </div>
      )}

      {phase === 'idle' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <Monitor className="size-12 opacity-30" />
          <div className="text-sm">未连接远程桌面</div>
          <Button size="small" onClick={openCredPrompt}>
            连接远程桌面
          </Button>
        </div>
      )}

      {phase === 'ended' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-1 flex items-center gap-2 text-sm font-medium">
              <TriangleAlert className="size-4 shrink-0 text-amber-500" />
              远程桌面连接已断开
            </div>
            <div className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
              {error ?? '未提供错误信息'}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="small" onClick={openCredPrompt}>
                修改凭据
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<RotateCw className="size-3.5" />}
                onClick={() => setAttempt((n) => n + 1)}
              >
                重新连接
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === 'connected' && (
        <RdpToolbar
          containerRef={wrapRef}
          desktopSize={remoteSize}
          sizeMode={sizeMode}
          onSizeModeChange={applySizeMode}
          onCtrlAltDel={sendCtrlAltDel}
        />
      )}

      <Modal
        title={`远程桌面 — ${profile?.name ?? host}`}
        open={phase === 'prompt'}
        okText="连接"
        cancelText="取消"
        maskClosable={false}
        forceRender
        onOk={() => void submitCreds()}
        onCancel={() => setPhase('idle')}
      >
        <div className="mb-3 rounded border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          主机：{host}:{configCreds?.port ?? 3389}（地址与端口取自主机配置）。密码只发给远端 RDP
          服务，勾选下方选项后由系统加密保存在本机。
        </div>
        <Form form={form} layout="vertical">
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input autoComplete="off" placeholder="Windows 账号（域账号可只填用户名）" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete="off" placeholder="Windows 登录密码" />
          </Form.Item>
          <Form.Item name="domain" label="域（可选）">
            <Input autoComplete="off" placeholder="域环境填域名（如 CORP）；本机账户留空" />
          </Form.Item>
          {profile && (
            <Form.Item name="saveToHost" valuePropName="checked" className="mb-0">
              <Checkbox>保存到主机配置（用户名 / 域 / 密码，加密存储）</Checkbox>
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  )
}
