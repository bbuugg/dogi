"use client";

/**
 * 图片查看器：点图弹一层**全屏浮层**，支持缩放 / 旋转 / 平移。
 *
 * 为什么不用 `react-medium-image-zoom`（本项目原来那套）：它只做「原位放大到铺满」这一种
 * 交互 —— 没有显式的放大 / 缩小按钮，也不能旋转，收起按钮又孤零零挂在右上角。这里按产品
 * 要求自建：**所有操作收进底部一条悬浮药丸工具条**（缩小 / 百分比 / 放大 / 左旋 / 右旋 /
 * 重置 / 关闭），图片本身只负责显示。
 *
 * ## 交互
 * - **滚轮**：缩放（`preventDefault` 挡掉页面滚动，故用原生非 passive 监听 —— React 的
 *   `onWheel` 是 passive 的，`preventDefault` 不生效）；
 * - **拖拽**：任意时刻按住图片即可平移（放大 / 旋转后尤其需要）；
 * - **双指捏合**：手机上以两指中点为锚点缩放，同时跟随中点平移；
 * - **键盘**：`Esc` 关闭、`+`/`-` 缩放、`r`/`R` 旋转、`0` 重置；
 *
 * 手机端拖拽不能让 React 每帧重渲染：手势期间直接把 transform 写进 `<img>` 的 style，
 * 并用 `requestAnimationFrame` 合并同一帧的多次 pointermove；浮层上必须 `touch-action: none`，
 * 否则浏览器会把手指移动当成滚动手势抢走，导致拖动一格一格地跳。
 * - 点遮罩空白处关闭；点图片 / 点工具条都不会误关。
 *
 * ## 为什么 portal 到 `document.body`
 * 调用方有的在可滚动的消息列表里、有的在带 `transform` 的面板里 —— `position: fixed` 遇到
 * 祖先的 `transform` / `filter` / `contain` 会以那个祖先为包含块，浮层就盖不满屏。挂到 body
 * 下没这个顾虑。
 *
 * 受控：`open` / `onOpenChange` 由调用方持有；打开或换图时自动复位。
 *
 * ## 动画
 *
 * 进出场用 `motion/react` 的 `AnimatePresence`：遮罩淡入淡出、图片轻微放大淡入、底部工具条
 * 上浮。**关闭时先播退场再卸载** —— 所以这里不能在 `open` 为假时直接 `return null`（内容没了
 * 就没得退出场）。用户自己拨的缩放 / 旋转 `transform` 仍在 `<img>` 的 style 上，动画只挂在它
 * 外层容器，两者互不打架（同一元素上挂 motion 会跟手写的 transform 抢）。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Download, Maximize, RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from "cn"

/** 缩放上下限：太小看不清、太大像素糊成马赛克，都没有意义 */
const MIN_SCALE = 0.2
const MAX_SCALE = 8
/** 按钮点一下的缩放步进 */
const STEP = 0.25
/** 每次旋转角度 */
const ROTATE_STEP = 90

function clampScale(v: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

export interface ImageViewerProps {
  src: string
  alt?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 传了才在工具条里多一颗「下载」 */
  onDownload?: () => void
}

/** 工具条按钮的共用样式 */
const TOOLBAR_BTN =
  'flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

type Transform = { x: number; y: number; scale: number; rotation: number }

type Gesture =
  | { mode: 'drag'; startX: number; startY: number; ox: number; oy: number }
  | {
      mode: 'pinch'
      startDist: number
      /** 起始双指中点（屏幕坐标） */
      midX: number
      midY: number
      /** 起始缩放 / 平移 */
      scale: number
      ox: number
      oy: number
      /** 浮层中心（屏幕坐标），缩放锚点计算用 */
      cx: number
      cy: number
    }

export function ImageViewer({ src, alt, open, onOpenChange, onDownload }: ImageViewerProps) {
  /** 仅用于工具条上的百分比与按钮禁用态；手势期间涨幅直接写 DOM，不回 React */
  const [scale, setScale] = useState(1)
  const [dragging, setDragging] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const percentRef = useRef<HTMLSpanElement>(null)
  /** 真正的变换状态：pointermove 每帧只写这个 ref + DOM，不触发重渲染 */
  const tf = useRef<Transform>({ x: 0, y: 0, scale: 1, rotation: 0 })
  /** 当前按在浮层上的指针（两指 = 捏合） */
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<Gesture | null>(null)
  const raf = useRef(0)
  /** 刚拖过 / 捏过：吞掉随之而来的 click，避免误触关闭 */
  const suppressClick = useRef(false)

  const paint = useCallback(() => {
    const t = tf.current
    if (imgRef.current) {
      imgRef.current.style.transform = `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale}) rotate(${t.rotation}deg)`
    }
    if (percentRef.current) percentRef.current.textContent = `${Math.round(t.scale * 100)}%`
  }, [])

  /** 同一帧内的多次 pointermove 合并成一次 DOM 写入 */
  const schedulePaint = useCallback(() => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      paint()
    })
  }, [paint])

  /** 手势结束 / 按钮操作后把 ref 同步回 React（百分比、禁用态） */
  const commit = useCallback(() => {
    setScale(tf.current.scale)
    paint()
  }, [paint])

  const zoomIn = useCallback(() => {
    tf.current.scale = clampScale(tf.current.scale + STEP)
    commit()
  }, [commit])
  const zoomOut = useCallback(() => {
    tf.current.scale = clampScale(tf.current.scale - STEP)
    commit()
  }, [commit])
  const rotateBy = useCallback(
    (delta: number) => {
      tf.current.rotation += delta
      paint()
    },
    [paint]
  )
  const reset = useCallback(() => {
    tf.current = { x: 0, y: 0, scale: 1, rotation: 0 }
    pointers.current.clear()
    gesture.current = null
    setDragging(false)
    commit()
  }, [commit])

  // 打开 / 换图即复位，免得残留上一张的缩放角度（图片挂载后再落一次 transform）
  useEffect(() => {
    if (open) reset()
  }, [open, src, reset])

  // 卸载时取消未执行的帧
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    },
    []
  )

  // 滚轮缩放：挂原生非 passive 监听（React onWheel 是 passive，挡不住页面滚动）
  useEffect(() => {
    if (!open) return
    const el = overlayRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      tf.current.scale = clampScale(tf.current.scale - e.deltaY * 0.002)
      commit()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open, commit])

  // 键盘快捷键
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenChange(false)
      else if (e.key === '+' || e.key === '=') zoomIn()
      else if (e.key === '-' || e.key === '_') zoomOut()
      else if (e.key === 'r' || e.key === 'R') rotateBy(-ROTATE_STEP)
      else if (e.key === '0') reset()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange, zoomIn, zoomOut, rotateBy, reset])

  // 浮层开着时锁住 body 滚动
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // 没有 document（SSR）就不渲染；**不能**因 `open` 为假而提前 return，否则退场没机会播
  const stop = (e: ReactMouseEvent): void => e.stopPropagation()

  /** 按剩余指针重建手势：0 = 结束、1 = 继续拖拽、2 = 继续捏合 */
  const rebuildGesture = useCallback(() => {
    const pts = [...pointers.current.values()]
    if (pts.length === 0) {
      gesture.current = null
      setDragging(false)
      commit()
      return
    }
    if (pts.length === 1) {
      gesture.current = {
        mode: 'drag',
        startX: pts[0].x,
        startY: pts[0].y,
        ox: tf.current.x,
        oy: tf.current.y
      }
      return
    }
    const el = overlayRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const [a, b] = pts
    gesture.current = {
      mode: 'pinch',
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      scale: tf.current.scale,
      ox: tf.current.x,
      oy: tf.current.y
    }
    setDragging(true)
  }, [commit])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // 工具条上的按钮不参与手势
    if ((e.target as HTMLElement).closest('[data-image-viewer-toolbar]')) return
    const el = overlayRef.current
    if (!el) return
    e.stopPropagation()
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId)
    suppressClick.current = false
    if (pointers.current.size === 1) setDragging(true)
    rebuildGesture()
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return

    if (g.mode === 'drag') {
      if (pointers.current.size !== 1) return
      const dx = e.clientX - g.startX
      const dy = e.clientY - g.startY
      if (Math.abs(dx) + Math.abs(dy) > 4) suppressClick.current = true
      tf.current.x = g.ox + dx
      tf.current.y = g.oy + dy
      schedulePaint()
      return
    }

    const pts = [...pointers.current.values()]
    if (pts.length < 2) return
    const [a, b] = pts
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
    const midX = (a.x + b.x) / 2
    const midY = (a.y + b.y) / 2
    const next = clampScale(g.scale * (dist / g.startDist))
    // 以双指中点为锚：缩放前后中点下的图像点保持不动，同时跟随中点平移
    const k = next / g.scale
    tf.current.scale = next
    tf.current.x = midX - g.cx - k * (g.midX - g.cx - g.ox)
    tf.current.y = midY - g.cy - k * (g.midY - g.cy - g.oy)
    suppressClick.current = true
    schedulePaint()
  }

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.delete(e.pointerId)) return
    const el = overlayRef.current
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    rebuildGesture()
  }

  const onClickOverlay = (e: ReactMouseEvent<HTMLDivElement>): void => {
    // 刚拖过 / 捏过：这次 click 是手势尾巴，不当作点击
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    if (e.target === overlayRef.current) onOpenChange(false)
  }

  // 没有 document（SSR）就不渲染；全部 hook 都已调用，此处才可提前返回
  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && src && (
        <motion.div
          ref={overlayRef}
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          onClick={onClickOverlay}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          style={{ touchAction: 'none', overscrollBehavior: 'none' }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 select-none"
        >
          {/* 图片外层只做**进出场**（淡入 + 轻微放大）；用户拨的 transform 在下面的 `<img>` 上 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="flex items-center justify-center"
          >
            <img
              ref={imgRef}
              src={src}
              alt={alt ?? ''}
              draggable={false}
              onClick={(e) => {
                e.stopPropagation()
                suppressClick.current = false
              }}
              onDragStart={(e) => e.preventDefault()}
              style={{
                transform: `translate3d(${tf.current.x}px, ${tf.current.y}px, 0) scale(${tf.current.scale}) rotate(${tf.current.rotation}deg)`,
                // 拖拽时去掉过渡，跟手；否则留 150ms 让按钮缩放 / 旋转有平滑感
                transition: dragging ? 'none' : 'transform 150ms ease',
                willChange: 'transform'
              }}
              className={cn(
                'max-h-[92vh] max-w-[92vw] touch-none object-contain select-none',
                dragging ? 'cursor-grabbing' : 'cursor-grab'
              )}
            />
          </motion.div>

          {/* 底部悬浮工具条：所有操作都在这里（图片右上角不再挂任何按钮）。
              居中用外层静态盒子的 `-translate-x-1/2`，上浮动画挂在内层 motion —— 同一元素上
              motion 的 y 会把 Tailwind 的 translate 顶掉。 */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
            <motion.div
              data-image-viewer-toolbar
              onClick={stop}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={{ duration: 0.2, delay: 0.04, ease: 'easeOut' }}
              className="flex items-center gap-0.5 rounded-full border border-border bg-popover/95 px-1.5 py-1 shadow-lg backdrop-blur"
            >
              <button type="button" title="缩小" aria-label="缩小" className={TOOLBAR_BTN} onClick={zoomOut} disabled={scale <= MIN_SCALE}>
                <ZoomOut className="size-4" />
              </button>
              <span ref={percentRef} className="w-12 select-none text-center text-xs tabular-nums text-muted-foreground">
                {Math.round(scale * 100)}%
              </span>
              <button type="button" title="放大" aria-label="放大" className={TOOLBAR_BTN} onClick={zoomIn} disabled={scale >= MAX_SCALE}>
                <ZoomIn className="size-4" />
              </button>

              <span className="mx-1 h-5 w-px shrink-0 bg-border" />

              <button type="button" title="向左旋转" aria-label="向左旋转" className={TOOLBAR_BTN} onClick={() => rotateBy(-ROTATE_STEP)}>
                <RotateCcw className="size-4" />
              </button>
              <button type="button" title="向右旋转" aria-label="向右旋转" className={TOOLBAR_BTN} onClick={() => rotateBy(ROTATE_STEP)}>
                <RotateCw className="size-4" />
              </button>

              <span className="mx-1 h-5 w-px shrink-0 bg-border" />

              <button type="button" title="重置（适应窗口）" aria-label="重置" className={TOOLBAR_BTN} onClick={reset}>
                <Maximize className="size-4" />
              </button>

              {onDownload && (
                <button type="button" title="下载" aria-label="下载" className={TOOLBAR_BTN} onClick={onDownload}>
                  <Download className="size-4" />
                </button>
              )}

              <span className="mx-1 h-5 w-px shrink-0 bg-border" />

              <button type="button" title="关闭" aria-label="关闭" className={TOOLBAR_BTN} onClick={() => onOpenChange(false)}>
                <X className="size-4" />
              </button>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}