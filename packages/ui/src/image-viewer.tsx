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
 * - **键盘**：`Esc` 关闭、`+`/`-` 缩放、`r`/`R` 旋转、`0` 重置；
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
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
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

export function ImageViewer({ src, alt, open, onOpenChange, onDownload }: ImageViewerProps) {
  const [scale, setScale] = useState(1)
  /** 角度制，顺时针为正 */
  const [rotation, setRotation] = useState(0)
  /** 平移量（屏幕像素，不随 scale 放大） */
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  /** 拖拽起点：记下按下时的指针位置与当时的 offset，move 时算差值 */
  const dragFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  const zoomIn = useCallback(() => setScale((s) => clampScale(s + STEP)), [])
  const zoomOut = useCallback(() => setScale((s) => clampScale(s - STEP)), [])
  const reset = useCallback(() => {
    setScale(1)
    setRotation(0)
    setOffset({ x: 0, y: 0 })
  }, [])

  // 打开 / 换图即复位，免得残留上一张的缩放角度
  useEffect(() => {
    if (open) reset()
  }, [open, src, reset])

  // 滚轮缩放：挂原生非 passive 监听（React onWheel 是 passive，挡不住页面滚动）
  useEffect(() => {
    if (!open) return
    const el = overlayRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      setScale((s) => clampScale(s - e.deltaY * 0.002))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open])

  // 键盘快捷键
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenChange(false)
      else if (e.key === '+' || e.key === '=') zoomIn()
      else if (e.key === '-' || e.key === '_') zoomOut()
      else if (e.key === 'r' || e.key === 'R') setRotation((r) => r - ROTATE_STEP)
      else if (e.key === '0') reset()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange, zoomIn, zoomOut, reset])

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
  if (typeof document === 'undefined') return null

  const stop = (e: ReactMouseEvent): void => e.stopPropagation()

  return createPortal(
    <AnimatePresence>
      {open && src && (
        <motion.div
          ref={overlayRef}
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          onClick={() => onOpenChange(false)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
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
              src={src}
              alt={alt ?? ''}
              draggable={false}
              onClick={stop}
              onPointerDown={(e) => {
                e.stopPropagation()
                e.currentTarget.setPointerCapture(e.pointerId)
                dragFrom.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
                setDragging(true)
              }}
              onPointerMove={(e) => {
                const from = dragFrom.current
                if (!from) return
                setOffset({ x: from.ox + (e.clientX - from.x), y: from.oy + (e.clientY - from.y) })
              }}
              onPointerUp={(e) => {
                dragFrom.current = null
                setDragging(false)
                e.currentTarget.releasePointerCapture?.(e.pointerId)
              }}
              onPointerCancel={() => {
                dragFrom.current = null
                setDragging(false)
              }}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)`,
                // 拖拽时去掉过渡，跟手；否则留 150ms 让按钮缩放 / 旋转有平滑感
                transition: dragging ? 'none' : 'transform 150ms ease'
              }}
              className={cn(
                'max-h-[92vh] max-w-[92vw] select-none object-contain',
                dragging ? 'cursor-grabbing' : 'cursor-grab'
              )}
            />
          </motion.div>

          {/* 底部悬浮工具条：所有操作都在这里（图片右上角不再挂任何按钮）。
              居中用外层静态盒子的 `-translate-x-1/2`，上浮动画挂在内层 motion —— 同一元素上
              motion 的 y 会把 Tailwind 的 translate 顶掉。 */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
            <motion.div
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
              <span className="w-12 select-none text-center text-xs tabular-nums text-muted-foreground">
                {Math.round(scale * 100)}%
              </span>
              <button type="button" title="放大" aria-label="放大" className={TOOLBAR_BTN} onClick={zoomIn} disabled={scale >= MAX_SCALE}>
                <ZoomIn className="size-4" />
              </button>

              <span className="mx-1 h-5 w-px shrink-0 bg-border" />

              <button type="button" title="向左旋转" aria-label="向左旋转" className={TOOLBAR_BTN} onClick={() => setRotation((r) => r - ROTATE_STEP)}>
                <RotateCcw className="size-4" />
              </button>
              <button type="button" title="向右旋转" aria-label="向右旋转" className={TOOLBAR_BTN} onClick={() => setRotation((r) => r + ROTATE_STEP)}>
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