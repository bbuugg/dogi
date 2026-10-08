import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { Button, Modal } from 'antd'

/**
 * 标签面板内的确认框：antd Modal，但**挂在本标签面板里**而不是 portal 到 body ——
 * 遮罩只盖住所在标签（父容器需 `relative`），能明确看出是哪个标签在被确认，
 * 也不影响其他分屏。实现要点：`getContainer={false}` 让 Modal 内联渲染在消费方
 * 交给它的位置；antd 默认 `position: fixed` 会盖住整个窗口，用 `styles.mask` /
 * `styles.wrapper` 的行内样式压成 `absolute`，定位基准就是标签面板。
 *
 * 两种取用方式，别混：
 * - **`useInlineConfirm()`** —— 自己持有一个确认框（**拥有者**）：返回 `confirm` 与
 *   `element`，`element` 必须渲染在自己的 `relative` 容器里。全应用只有
 *   **面板组**（`PanelGroupView`）用这种方式，见下面 `CloseConfirmProvider`。
 * - **`useCloseConfirm()`** —— 取用所在组那个确认框（**消费者**）：页面组件（笔记 / Agent）
 *   在关闭确认里用它，不再自己渲染 `element`。
 */
export interface InlineConfirmAction {
  label: string
  /** 按钮样式：primary=主色，danger=红色描边，缺省为普通 */
  kind?: 'primary' | 'default' | 'danger'
  /** 点击后这条确认的决议：true = 放行关闭，false = 取消 */
  value: boolean
  /** 点击时的附加动作（如先保存 / 置丢弃标记）；返回 false 否决关闭（如保存失败） */
  run?: () => boolean | Promise<boolean>
}

export interface InlineConfirmOptions {
  title: string
  content?: ReactNode
  actions: InlineConfirmAction[]
  /** 按钮区上方的自定义内容（如「以后都不再提示」勾选） */
  extra?: ReactNode
}

/** 弹一次确认框；`true` = 用户选了放行的那一档，`false` = 取消（含 Esc / 遮罩 / 卸载结算） */
export type InlineConfirmFn = (opts: InlineConfirmOptions) => Promise<boolean>

interface Pending {
  opts: InlineConfirmOptions
  resolve: (ok: boolean) => void
}

export function useInlineConfirm(): {
  confirm: InlineConfirmFn
  element: ReactNode
} {
  const [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)

  /** 结算当前确认（幂等）；卸载时也会被调，保证调用方 await 不悬挂 */
  const settle = useCallback((ok: boolean) => {
    const p = pendingRef.current
    if (!p) return
    pendingRef.current = null
    setPending(null)
    p.resolve(ok)
  }, [])

  const confirm = useCallback<InlineConfirmFn>(
    (opts) => {
      // 已有未决确认时先按取消结算（同一确认框不会并发，防御连点 / StrictMode 重放）
      settle(false)
      return new Promise<boolean>((resolve) => {
        const p: Pending = { opts, resolve }
        pendingRef.current = p
        setPending(p)
      })
    },
    [settle]
  )

  // 卸载时结算挂起的 Promise（Modal 自身随组件卸载，不用管 DOM，但 await 方要落地）
  useEffect(() => () => settle(false), [settle])

  const choose = useCallback(
    async (action: InlineConfirmAction) => {
      let ok = true
      if (action.run) {
        // 附加动作抛错按「否决」处理：宁可不关，也不能让确认框卡死
        try {
          ok = await action.run()
        } catch {
          ok = false
        }
      }
      settle(action.value && ok)
    },
    [settle]
  )

  const opts = pending?.opts
  const element = (
    <Modal
      open={!!pending}
      title={opts?.title}
      onCancel={() => settle(false)}
      centered
      width={360}
      style={{ maxWidth: 'calc(100% - 32px)' }}
      closable={false}
      keyboard
      // 内联渲染：不 portal 到 body，Modal 就渲染在消费方放置 {element} 的位置
      //（标签面板 / 页面根容器内）。缺省 portal 到 body 的话，下面的 absolute
      // 定位会以视口为包含块、遮罩盖满整窗 —— 就失去了「只盖住本标签」的意义。
      getContainer={false}
      // 面板内绝对定位：fixed 的遮罩会盖住整个窗口，行内样式压过 cssinjs 的 fixed
      styles={{
        mask: { position: 'absolute', inset: 0 },
        wrapper: { position: 'absolute', inset: 0 }
      }}
      footer={
        <div className="flex justify-end gap-2">
          {opts?.actions.map((action) => (
            <Button
              key={action.label}
              type={action.kind === 'primary' ? 'primary' : 'default'}
              danger={action.kind === 'danger'}
              onClick={() => void choose(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      }
    >
      {opts?.content}
      {opts?.extra}
    </Modal>
  )

  return { confirm, element }
}

// ---------------------------------------------------------------------------
// 组级确认宿主
// ---------------------------------------------------------------------------

const CloseConfirmContext = createContext<InlineConfirmFn | null>(null)

/**
 * 把**组级**确认框提供给组内所有标签的页面组件。
 *
 * 为什么确认框挂在「组」上而不是「页面」上：关闭一个**非激活**标签时（右键「关闭其他」、
 * 「关闭整个组」、批量关），页面自己的确认框渲染在 `hidden` 容器里 —— 用户既看不到也点不到。
 * 旧实现为此在关闭前先把标签激活、再 `setTimeout(50)` 等 React 摘掉 `hidden`，
 * 那是在**赌渲染时序**：慢机器上 50ms 不够，确认框留在 `hidden` 里，关闭动作静默卡死。
 * 挂到组面板上就与「哪个标签是激活的」彻底无关了，也不必抢焦点。
 */
export function CloseConfirmProvider({
  value,
  children
}: {
  value: InlineConfirmFn
  children: ReactNode
}) {
  return <CloseConfirmContext.Provider value={value}>{children}</CloseConfirmContext.Provider>
}

/**
 * 没有 provider 时按「一律取消」处理（fail closed）。
 * 正常不会走到：页面只可能渲染在面板组里。真走到了说明有人把页面挂到了面板之外，
 * 此时宁可不关也不能让关闭流程静默走完。
 */
const noProvider: InlineConfirmFn = async () => {
  console.error('[InlineConfirm] 当前页面不在面板组里（缺 CloseConfirmProvider），关闭确认按「取消」处理')
  return false
}

/** 页面取用所在面板组的关闭确认框（见 `CloseConfirmProvider`） */
export function useCloseConfirm(): InlineConfirmFn {
  return useContext(CloseConfirmContext) ?? noProvider
}
