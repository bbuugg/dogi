import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Loader2, RotateCw, Globe, Monitor, Smartphone } from 'lucide-react'
import { Button, Input, Tooltip } from 'antd'
import type { BrowserSessionState, BrowserViewportMode } from '@shared/types'
import { BROWSER_VIEWPORT_PRESETS } from '@shared/browser'
import { cn } from '@/shared/lib/utils'
import type { RectLike } from './browser-input'
import {
  cdpModifiers,
  containedRect,
  keyEvent,
  mouseButton,
  toPageCoords,
  wheelEvent
} from './browser-input'

/**
 * Agent 会话页的内嵌浏览器视图。
 *
 * 浏览器本体是**无窗口**跑的（Playwright headless），这里看到的是 CDP screencast
 * 的帧流；用户的鼠标键盘再由 `input()` 转发回去。这样 Playwright 能完全控制它，
 * 而画面又嵌在 Dogi 的会话页里 —— Agent 的 `browser_*` 工具操作哪一页，这里就镜像哪一页
 * （见 AGENTS.md 的浏览器一节）。
 *
 * ⚠️ 视口**不跟随面板尺寸**：面板宽度是用户拖出来的，拿它当视口会让同一个页面
 * 在不同窗口大小下走不同的响应式断点。视口固定成预设（PC / 手机），画面由
 * `object-contain` 缩放填进面板 —— 见 @shared/browser 的 BROWSER_VIEWPORT_PRESETS。
 */

interface BrowserPaneProps {
  sessionId: string
  /** 点「打开浏览器」时的落点 */
  startUrl?: string
  /** 浏览器启动成功后通知（父组件据此更新状态） */
  onStarted?: () => void
  /**
   * 当前视口预设。**受控**：父组件要在浏览器还没启动时自己调 `open()`，
   * 它必须知道该用哪个预设，所以状态放在父组件。
   */
  mode: BrowserViewportMode
  onModeChange: (mode: BrowserViewportMode) => void
  className?: string
}

export function BrowserPane({
  sessionId,
  startUrl,
  onStarted,
  mode,
  onModeChange,
  className
}: BrowserPaneProps): React.ReactElement {
  const paneRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const stateRef = useRef<BrowserSessionState | null>(null)

  const [state, setState] = useState<BrowserSessionState | null>(null)
  const [hasFrame, setHasFrame] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [editingAddress, setEditingAddress] = useState(false)

  stateRef.current = state

  // -------------------------------------------------------------------
  // 订阅：帧直接写进 img.src（不走 React，60fps 的 setState 会拖垮面板）
  // -------------------------------------------------------------------
  useEffect(() => {
    setHasFrame(false)
    setState(null)
    setError(null)
    const offs = [
      window.api.browser.onFrame((f) => {
        if (f.sessionId !== sessionId) return
        const img = imgRef.current
        if (!img) return
        img.src = `data:image/jpeg;base64,${f.data}`
        // 只在第一帧时触发一次渲染，之后都由 img.src 直接更新
        setHasFrame((prev) => prev || true)
      }),
      window.api.browser.onState((s) => {
        if (s.sessionId !== sessionId) return
        setState(s)
      }),
      window.api.browser.onClosed((p) => {
        if (p.sessionId !== sessionId) return
        setState(null)
        setHasFrame(false)
        setError(`浏览器已关闭：${p.reason}`)
      })
    ]
    // 挂载时会话**可能已经跑起来了**（切标签页回来、外层组件重挂）：主进程只在
    // 事件发生时推状态，静止页面推不出来。主动拉一次 —— 顺带让主进程补一帧画面，
    // 否则这里会显示成「浏览器还没打开」，而 mode 也会退回默认的 PC。
    let cancelled = false
    void window.api.browser.state(sessionId).then((s) => {
      if (!cancelled && s) setState(s)
    })
    return () => {
      cancelled = true
      offs.forEach((off) => off())
    }
  }, [sessionId])

  /**
   * 视口预设以**主进程的会话状态**为准。
   *
   * `mode` 是受控 prop，面板重挂后父组件的状态会退回默认值（PC），而会话可能还停在
   * 手机视口 —— 不同步就会出现「按钮显示 PC、页面却是手机」。状态一到就把它拉回真实值。
   */
  useEffect(() => {
    if (state && state.viewportMode !== mode) onModeChange(state.viewportMode)
  }, [state, mode, onModeChange])

  // 地址栏跟随页面跳转；用户正在编辑时不打断
  useEffect(() => {
    if (editingAddress) return
    setAddress(state?.url ?? '')
  }, [state?.url, editingAddress])

  // -------------------------------------------------------------------
  // 启动 / 切换视口
  // -------------------------------------------------------------------
  const open = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      const s = await window.api.browser.open({ sessionId, url: startUrl, mode })
      setState(s)
      onStarted?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }, [sessionId, startUrl, mode, onStarted])

  /**
   * 切换 PC / 手机视口。
   *
   * 浏览器已经开着就直接改视口（页面状态、登录态都留着，只是重排一次）；
   * 还没开就只更新状态，等 `open()` 时带上去。
   */
  const switchMode = useCallback(
    (next: BrowserViewportMode): void => {
      if (next === mode) return
      onModeChange(next)
      if (stateRef.current) void window.api.browser.viewport(sessionId, next)
    },
    [mode, onModeChange, sessionId]
  )

  // -------------------------------------------------------------------
  // 输入转发
  // -------------------------------------------------------------------
  /**
   * 画面矩形 —— **不是** img 的元素矩形。
   *
   * 图片是 `size-full` 铺满面板、画面内部 `object-contain` 居中，四周有留白；
   * 元素矩形比画面大，直接拿它映射坐标会让点击整体偏移（见 containedRect 的注释）。
   */
  const frameRect = useCallback((current: BrowserSessionState): RectLike | null => {
    const img = imgRef.current
    if (!img) return null
    return containedRect(img.getBoundingClientRect(), {
      width: img.naturalWidth || current.viewport.width,
      height: img.naturalHeight || current.viewport.height
    })
  }, [])

  const sendMouse = useCallback(
    (e: React.MouseEvent, type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => {
      const current = stateRef.current
      if (!current) return
      const rect = frameRect(current)
      if (!rect) return
      const point = toPageCoords(e.clientX, e.clientY, rect, current.viewport)
      if (!point) return
      void window.api.browser.input(sessionId, {
        kind: 'mouse',
        type,
        x: point.x,
        y: point.y,
        button: mouseButton(e.button),
        clickCount: e.detail || 1,
        modifiers: cdpModifiers(e)
      })
    },
    [sessionId, frameRect]
  )

  /** mousemove 高频：上一帧还没画完就丢掉后续移动，避免 CDP 调用积压 */
  const moveThrottled = useRef(false)
  const onMouseMove = (e: React.MouseEvent): void => {
    if (moveThrottled.current) return
    moveThrottled.current = true
    requestAnimationFrame(() => {
      moveThrottled.current = false
    })
    sendMouse(e, 'mouseMoved')
  }

  // 滚轮必须用原生监听：React 的 onWheel 是 passive 的，preventDefault 无效，
  // 结果面板滚动的同时页面也在滚（或反过来完全不滚）
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const current = stateRef.current
      if (!current) return
      const rect = frameRect(current)
      if (!rect) return
      const event = wheelEvent(e, rect, current.viewport, cdpModifiers(e))
      if (event) void window.api.browser.input(sessionId, event)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [sessionId, frameRect])

  const onKey = (e: React.KeyboardEvent, type: 'keyDown' | 'keyUp'): void => {
    if (!stateRef.current) return
    const event = keyEvent(e.nativeEvent, type)
    if (!event) return
    // 面板内不允许浏览器默认行为（空格滚动、Tab 跳焦点…），它们会抢在转发之前生效
    e.preventDefault()
    e.stopPropagation()
    void window.api.browser.input(sessionId, event)
  }

  /** 输入法 / 粘贴：不经过按键，直接插入文本 */
  const onCompositionEnd = (e: React.CompositionEvent): void => {
    if (!stateRef.current || !e.data) return
    void window.api.browser.input(sessionId, { kind: 'text', text: e.data })
  }
  const onPaste = (e: React.ClipboardEvent): void => {
    if (!stateRef.current) return
    const text = e.clipboardData.getData('text')
    if (!text) return
    e.preventDefault()
    void window.api.browser.input(sessionId, { kind: 'text', text })
  }

  // -------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------
  const started = Boolean(state)
  const busy = starting || state?.loading

  return (
    <div className={cn('flex min-h-0 flex-col bg-background', className)}>
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        <Tooltip title="后退">
          <Button
            type="text"
            size="small"
            disabled={!state?.canGoBack}
            onClick={() => void window.api.browser.back(sessionId)}
            icon={<ArrowLeft className="size-3.5" />}
          />
        </Tooltip>
        <Tooltip title="前进">
          <Button
            type="text"
            size="small"
            disabled={!state?.canGoForward}
            onClick={() => void window.api.browser.forward(sessionId)}
            icon={<ArrowRight className="size-3.5" />}
          />
        </Tooltip>
        <Tooltip title="刷新">
          <Button
            type="text"
            size="small"
            disabled={!started}
            onClick={() => void window.api.browser.reload(sessionId)}
            icon={<RotateCw className="size-3.5" />}
          />
        </Tooltip>

        <Input
          size="small"
          value={address}
          disabled={!started}
          placeholder="输入网址后回车"
          variant="borderless"
          className="mx-1 min-w-0 flex-1 text-xs"
          onFocus={() => setEditingAddress(true)}
          onBlur={() => setEditingAddress(false)}
          onChange={(e) => setAddress(e.target.value)}
          onPressEnter={() => {
            setEditingAddress(false)
            if (address.trim()) void window.api.browser.navigate(sessionId, address)
          }}
        />

        {/* 视口切换：PC / 手机。激活态用 antd 自己的 type 区分，
            不靠 Tailwind 类改底色 —— cssinjs 是非 @layer 样式，压不动（AGENTS.md 6.5） */}
        <div className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1">
          <Tooltip
            title={`PC 视口 ${BROWSER_VIEWPORT_PRESETS.desktop.width}×${BROWSER_VIEWPORT_PRESETS.desktop.height}`}
          >
            <Button
              type={mode === 'desktop' ? 'primary' : 'text'}
              size="small"
              aria-label="PC 视口"
              aria-pressed={mode === 'desktop'}
              onClick={() => switchMode('desktop')}
              icon={<Monitor className="size-3.5" />}
            />
          </Tooltip>
          <Tooltip
            title={`手机视口 ${BROWSER_VIEWPORT_PRESETS.mobile.width}×${BROWSER_VIEWPORT_PRESETS.mobile.height}`}
          >
            <Button
              type={mode === 'mobile' ? 'primary' : 'text'}
              size="small"
              aria-label="手机视口"
              aria-pressed={mode === 'mobile'}
              onClick={() => switchMode('mobile')}
              icon={<Smartphone className="size-3.5" />}
            />
          </Tooltip>
        </div>

        {busy && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        {state && (
          <span className="shrink-0 pl-1 text-xs text-muted-foreground">
            {state.viewport.width}×{state.viewport.height}
          </span>
        )}
        {state?.channel && (
          <span className="shrink-0 pl-1 pr-1 text-xs text-muted-foreground">
            {state.channel}
          </span>
        )}
      </div>

      {/* 画面 / 占位 */}
      <div
        ref={paneRef}
        tabIndex={0}
        onMouseDown={(e) => {
          e.currentTarget.focus()
          sendMouse(e, 'mousePressed')
        }}
        onMouseUp={(e) => sendMouse(e, 'mouseReleased')}
        onMouseMove={onMouseMove}
        onKeyDown={(e) => onKey(e, 'keyDown')}
        onKeyUp={(e) => onKey(e, 'keyUp')}
        onCompositionEnd={onCompositionEnd}
        onPaste={onPaste}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-background outline-none',
          started && 'cursor-default'
        )}
      >
        <img
          ref={imgRef}
          alt="浏览器画面"
          draggable={false}
          className={cn('block size-full object-contain select-none', !hasFrame && 'invisible')}
        />

        {!started && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-center">
            <Globe className="size-10 text-muted-foreground/40" />
            <div className="text-sm text-muted-foreground">
              {error ?? '浏览器还没打开'}
            </div>
            <Button type="primary" loading={starting} onClick={() => void open()}>
              打开浏览器
            </Button>
            {error && (
              <div className="max-w-md px-4 text-xs text-destructive/80">{error}</div>
            )}
          </div>
        )}

        {started && !hasFrame && (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  )
}
