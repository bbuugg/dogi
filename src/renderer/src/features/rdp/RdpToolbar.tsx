import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { Button, Select, Tooltip } from 'antd'
import { ChevronUp, GripVertical, Keyboard } from 'lucide-react'

/**
 * 远程桌面悬浮工具条：拖拽指示器 + 常用操作（Ctrl+Alt+Del / 远端分辨率）+ 收起。
 *
 * 位置与收起状态存在 localStorage（纯界面级偏好，不进 preferences 体系）：默认贴容器
 * 右上角（right/top 定位），一旦拖动过就换成 left/top 并用容器矩形夹取 —— 面板分屏 /
 * 拖拽改宽高后由 useLayoutEffect 重新夹一次，避免条漂到可视区外。
 *
 * 收起态只剩一个 grip 图标：拖动它移动、单击它展开（用位移阈值区分，见 DRAG_THRESHOLD）。
 */

/** 分辨率档位：'auto' = 跟随面板尺寸（默认），其余为「宽x高」 */
export type RdpSizeMode = 'auto' | '1280x720' | '1600x900' | '1920x1080' | '2560x1440'

export const RDP_SIZE_OPTIONS: { value: RdpSizeMode; label: string }[] = [
  { value: 'auto', label: '跟随面板' },
  { value: '1280x720', label: '1280 × 720' },
  { value: '1600x900', label: '1600 × 900' },
  { value: '1920x1080', label: '1920 × 1080' },
  { value: '2560x1440', label: '2560 × 1440' }
]

/** 解析手动档位；'auto' 返回 null（由调用方按容器尺寸现算） */
export function parseSizeMode(mode: RdpSizeMode): { width: number; height: number } | null {
  if (mode === 'auto') return null
  const [width, height] = mode.split('x').map(Number)
  return { width, height }
}

const SIZE_MODE_KEY = 'dogi:rdp-size-mode'

/** 读回上次选的分辨率档位（界面级选择，存储不可用时退回 'auto'） */
export function readStoredSizeMode(): RdpSizeMode {
  try {
    const raw = localStorage.getItem(SIZE_MODE_KEY)
    return RDP_SIZE_OPTIONS.some((o) => o.value === raw) ? (raw as RdpSizeMode) : 'auto'
  } catch {
    return 'auto'
  }
}

export function writeStoredSizeMode(mode: RdpSizeMode): void {
  try {
    localStorage.setItem(SIZE_MODE_KEY, mode)
  } catch {
    // 忽略：存储被禁用时不影响功能
  }
}

const TOOLBAR_KEY = 'dogi:rdp-toolbar'
/** 拖拽位移超过这个像素才算「拖动」，否则收起态的一次点按当「展开」 */
const DRAG_THRESHOLD = 4
/** 未拖动过时贴容器右上角的边距 */
const DEFAULT_MARGIN = 8

interface ToolbarPrefs {
  /** null = 从未拖动过（走 right/top 默认位） */
  x: number | null
  y: number | null
  collapsed: boolean
}

function readPrefs(): ToolbarPrefs {
  const fallback: ToolbarPrefs = { x: null, y: null, collapsed: false }
  try {
    const raw = localStorage.getItem(TOOLBAR_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<ToolbarPrefs>
    return {
      x: typeof parsed.x === 'number' ? parsed.x : null,
      y: typeof parsed.y === 'number' ? parsed.y : null,
      collapsed: parsed.collapsed === true
    }
  } catch {
    return fallback
  }
}

function writePrefs(prefs: ToolbarPrefs): void {
  try {
    localStorage.setItem(TOOLBAR_KEY, JSON.stringify(prefs))
  } catch {
    // 忽略：存储被禁用时不影响功能
  }
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

interface RdpToolbarProps {
  /** 夹取边界 / 定位参照：远程桌面容器（RdpPage 的 wrapRef） */
  containerRef: RefObject<HTMLDivElement | null>
  /** 远端当前桌面尺寸（展示用） */
  desktopSize: { width: number; height: number }
  /** 分辨率档位（受控：真源在 RdpPage，切换后由它下发 resize） */
  sizeMode: RdpSizeMode
  onSizeModeChange: (mode: RdpSizeMode) => void
  /** 发送 Ctrl+Alt+Del（登录 / 锁屏解锁界面用） */
  onCtrlAltDel: () => void
}

export function RdpToolbar({
  containerRef,
  desktopSize,
  sizeMode,
  onSizeModeChange,
  onCtrlAltDel
}: RdpToolbarProps) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const [storedPrefs] = useState(readPrefs)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(
    storedPrefs.x !== null && storedPrefs.y !== null ? { x: storedPrefs.x, y: storedPrefs.y } : null
  )
  const [collapsed, setCollapsed] = useState(storedPrefs.collapsed)

  useEffect(() => {
    writePrefs({ x: pos?.x ?? null, y: pos?.y ?? null, collapsed })
  }, [pos, collapsed])

  /**
   * 把工具条夹回容器内（值没变就原样返回，避免 setState 循环）。
   * 用函数式 setPos：既能被「展开 / 收起改变自身宽度」后的校正调用，
   * 也能直接挂在容器的 ResizeObserver 上。
   */
  const clampIntoContainer = useCallback((): void => {
    setPos((current) => {
      if (!current) return current
      const el = barRef.current
      const container = containerRef.current
      if (!el || !container) return current
      const cRect = container.getBoundingClientRect()
      const bRect = el.getBoundingClientRect()
      const x = clamp(current.x, 0, Math.max(0, cRect.width - bRect.width))
      const y = clamp(current.y, 0, Math.max(0, cRect.height - bRect.height))
      return x === current.x && y === current.y ? current : { x, y }
    })
  }, [containerRef])

  // 展开 / 收起改变自身宽度后校正（layout effect：DOM 已提交，量到的是新尺寸）
  useLayoutEffect(() => {
    clampIntoContainer()
  }, [collapsed, clampIntoContainer])

  // 容器尺寸变化（面板拖拽 / 分屏 / 窗口缩放）后校正：拖到右下角的工具条不会被挤出可视区
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => clampIntoContainer())
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, clampIntoContainer])

  /**
   * 拖拽。按下即把当前位置换算成「相对容器的 left/top」并固定下来（原本可能是
   * right/top 默认位），随后跟手移动；位移不超过阈值且传了 onClick 时按点击处理
   * —— 收起态的一下点按就是这样展开的。用 window 监听 + body 光标锁定，
   * 鼠标拖出窗口再松手也能正常收尾（与项目里其它拖拽一致）。
   */
  const startDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>, onClick?: () => void): void => {
      if (e.button !== 0) return
      const el = barRef.current
      const container = containerRef.current
      if (!el || !container) return
      e.preventDefault()
      const barRect = el.getBoundingClientRect()
      const cRect = container.getBoundingClientRect()
      const startLeft = barRect.left - cRect.left
      const startTop = barRect.top - cRect.top
      const maxX = Math.max(0, cRect.width - barRect.width)
      const maxY = Math.max(0, cRect.height - barRect.height)
      const startX = e.clientX
      const startY = e.clientY
      let moved = false
      setPos({ x: clamp(startLeft, 0, maxX), y: clamp(startTop, 0, maxY) })

      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
        moved = true
        setPos({ x: clamp(startLeft + dx, 0, maxX), y: clamp(startTop + dy, 0, maxY) })
      }
      const stop = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        if (!moved) onClick?.()
      }
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
    },
    [containerRef]
  )

  return (
    <div
      ref={barRef}
      className={
        collapsed
          ? 'absolute z-30 select-none'
          : 'absolute z-30 flex select-none items-center gap-0.5 rounded-md border border-border/70 bg-background/95 py-0.5 pl-0.5 pr-1 shadow-md backdrop-blur'
      }
      style={pos ? { left: pos.x, top: pos.y } : { right: DEFAULT_MARGIN, top: DEFAULT_MARGIN }}
    >
      {collapsed ? (
        <Tooltip title="拖动可移动，单击展开">
          <button
            type="button"
            aria-label="展开远程桌面工具条"
            onPointerDown={(e) => startDrag(e, () => setCollapsed(false))}
            className="flex size-6 cursor-grab items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-md backdrop-blur transition-colors hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-3.5" />
          </button>
        </Tooltip>
      ) : (
        <>
          <div
            role="button"
            aria-label="拖动移动工具条"
            title="拖动移动工具条"
            onPointerDown={(e) => startDrag(e)}
            className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-3.5" />
          </div>
          <span className="mr-1 shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {desktopSize.width}×{desktopSize.height}
          </span>
          <Tooltip title="发送 Ctrl+Alt+Del（登录 / 锁屏解锁用）">
            <Button
              size="small"
              type="text"
              aria-label="发送 Ctrl+Alt+Del"
              icon={<Keyboard className="size-3.5" />}
              onClick={onCtrlAltDel}
            />
          </Tooltip>
          <Select<RdpSizeMode>
            size="small"
            value={sizeMode}
            options={RDP_SIZE_OPTIONS}
            onChange={onSizeModeChange}
            popupMatchSelectWidth={false}
            className="w-[104px] shrink-0"
            aria-label="远端桌面分辨率"
          />
          <Tooltip title="收起工具条">
            <Button
              size="small"
              type="text"
              aria-label="收起工具条"
              icon={<ChevronUp className="size-3.5" />}
              onClick={() => setCollapsed(true)}
            />
          </Tooltip>
        </>
      )}
    </div>
  )
}
