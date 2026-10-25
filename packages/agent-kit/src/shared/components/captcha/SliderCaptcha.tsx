/**
 * 滑块验证码组件（移植自 `console/apps/captcha/sdk/src/widget.ts` 的原生 DOM 实现）。
 *
 * ## 拖的是「图下轨道」，不是图本身
 *
 * 拼图舞台（`.cap-stage`）**不接收任何指针事件**，只负责画背景与拼图块；真正可拖的是
 * 舞台下方那条滑轨（`.cap-track`）上的滑块（`.cap-knob`）。两者的位移按**比例**映射：
 * 滑块走满一程 = 拼图块从左端走到最右端（`challenge.maxX`），因为轨道宽度与舞台宽度
 * 并不相等，一一对应（1:1）会让滑块走不到轨道尽头。
 *
 * 其余交互语义逐条保留（原版同样是「按下 → 捕获指针 → 移动 → 松手提交」）：
 * - 按下即 `setPointerCapture`：指针滑出轨道也继续跟手（拖到轨道外面不会中断）；
 * - 位置一律换算成「逻辑 px」（`challenge.width` 坐标系）再上报，与服务端答案同一坐标系；
 * - 松手时补一条终态采样，保证服务端「末点 == 提交的 x」的校验恒成立；
 * - 键盘可达：方向键微调、Home/End 到两端、Enter 提交。
 *
 * 校验通过 / 失败 / 网络异常这些**状态**由上层（`use-captcha.tsx`）持有，这里只管画和拖。
 */
import { type PointerEvent as ReactPointerEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { CaptchaAnswer, CaptchaChallenge } from '@fizz/contracts'
import { Check, ChevronRight, RefreshCw } from 'lucide-react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { TrackRecorder } from './track'

/** 键盘微调步长（逻辑 px）；按住 Shift 走大步 */
const KEY_STEP = 2
const KEY_STEP_LARGE = 10
/**
 * 滑块宽度（px）。必须与 `captcha.css` 里 `.cap-knob` 的 `width` 一致：
 * 滑块左偏移用 `calc(ratio% - ratio * KNOB_WIDTH)` 换算（免测量、免 ResizeObserver）。
 */
const KNOB_WIDTH = 40

export type CaptchaStatus =
  | 'idle'
  | 'ready'
  | 'dragging'
  | 'verifying'
  | 'passed'
  | 'failed'
  | 'error'

export interface SliderCaptchaProps {
  /** 当前挑战；`null` = 还在加载（显示骨架屏） */
  challenge: CaptchaChallenge | null
  status: CaptchaStatus
  /** 底部提示文案（由上层按状态给） */
  hint: string
  /** 是否禁用拖动（校验中 / 已通过 / 加载失败） */
  disabled?: boolean
  /** 正在加载新挑战（刷新按钮转圈） */
  loading?: boolean
  /** 加载失败文案（有值时叠在骨架屏上） */
  loadError?: string | null
  /** 挑战到达前的占位比例（宽 / 高），与真实比例一致可避免高度跳变 */
  aspectRatio?: number
  /** 提交答案（松手 / 键盘确认时） */
  onAnswer: (answer: CaptchaAnswer) => void
  /** 换一张 */
  onRefresh: () => void
}

export function SliderCaptcha({
  challenge,
  status,
  hint,
  disabled = false,
  loading = false,
  loadError = null,
  aspectRatio = 2,
  onAnswer,
  onRefresh
}: SliderCaptchaProps) {
  const t = useT()
  const railRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const recorderRef = useRef(new TrackRecorder())
  /** 一次按下的起点：指针 clientX + 滑块当时的偏移 px + 当时的可走行程 px */
  const startRef = useRef<{ pointerX: number; offset: number; travel: number } | null>(null)

  /** 拼图块左边位置（逻辑 px） */
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)

  const maxX = challenge?.maxX ?? 0
  const interactive = !!challenge && !disabled && status !== 'passed' && status !== 'verifying'

  // 换挑战：位置归零、轨迹重置
  useEffect(() => {
    setDragX(0)
    setDragging(false)
    startRef.current = null
    recorderRef.current.reset()
  }, [challenge?.id])

  // 被禁用（进入校验）时收掉拖动态，避免松手事件丢失后一直显示 grabbing
  useEffect(() => {
    if (!interactive) {
      setDragging(false)
      startRef.current = null
    }
  }, [interactive])

  const clampX = (x: number): number => Math.min(Math.max(x, 0), maxX)

  /** 轨道的可走行程（px）= 轨道内容宽 − 滑块宽 */
  const travelOf = (): number => {
    const rail = railRef.current
    const knob = knobRef.current
    if (!rail || !knob) return 1
    // clientWidth 不含 border（轨道有 1px 边框），正是滑块能走的范围
    return Math.max(rail.clientWidth - knob.offsetWidth, 1)
  }

  /** 逻辑 px → 滑块在轨道上的偏移 px */
  const offsetOf = (x: number): number => (maxX > 0 ? (clampX(x) / maxX) * travelOf() : 0)

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    // 只认主键 / 触摸 / 笔，右键菜单不启动拖动
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const el = e.currentTarget
    // 捕获指针：拖出轨道也继续收到 move/up（原版同样依赖这一点）
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // 个别环境不支持捕获：退化成普通拖动，仍可用
    }
    el.focus()
    startRef.current = { pointerX: e.clientX, offset: offsetOf(dragX), travel: travelOf() }
    recorderRef.current.begin(dragX, performance.now())
    setDragging(true)
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current
    if (!start || !interactive) return
    const offset = Math.min(Math.max(start.offset + (e.clientX - start.pointerX), 0), start.travel)
    const next = maxX > 0 ? clampX((offset / start.travel) * maxX) : 0
    setDragX(next)
    recorderRef.current.sample(next, performance.now())
  }

  const finishDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current
    if (!start || !interactive) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 没捕获成功时释放会抛，忽略
    }
    startRef.current = null
    setDragging(false)

    const { track, elapsedMs } = recorderRef.current.finish(dragX, performance.now())
    // x 取整：服务端按逻辑 px 比较，客户端画的是亚像素位置
    onAnswer({
      x: Math.round(dragX),
      elapsedMs: Math.round(elapsedMs),
      track: track.map((p) => ({ x: p.x, t: Math.round(p.t) }))
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    let next: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = clampX(dragX - step)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = clampX(dragX + step)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = maxX
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const rec = recorderRef.current
      if (!rec.started) rec.begin(dragX, performance.now())
      const { track, elapsedMs } = rec.finish(dragX, performance.now())
      onAnswer({
        x: Math.round(dragX),
        elapsedMs: Math.round(elapsedMs),
        track: track.map((p) => ({ x: p.x, t: Math.round(p.t) }))
      })
      return
    } else return

    e.preventDefault()
    const rec = recorderRef.current
    if (!rec.started) rec.begin(dragX, performance.now())
    rec.sample(next, performance.now())
    setDragX(next)
  }

  const stageStyle = challenge
    ? { aspectRatio: `${challenge.width} / ${challenge.height}` }
    : { aspectRatio: String(aspectRatio) }

  // 滑块行程比例（0..1）：滑块左偏移 = ratio × (轨道宽 − 滑块宽)，用 calc 表达可免测量
  const ratio = maxX > 0 ? Math.min(Math.max(dragX / maxX, 0), 1) : 0
  const pct = Math.round(ratio * 1000) / 10
  const knobLeft = `calc(${pct}% - ${((pct / 100) * KNOB_WIDTH).toFixed(2)}px)`
  const fillWidth = `calc(${pct}% + ${(KNOB_WIDTH - (pct / 100) * KNOB_WIDTH).toFixed(2)}px)`

  return (
    <div
      className={cn(
        'cap',
        `cap--${status}`,
        dragging && 'cap--dragging',
        disabled && 'cap--disabled',
        loading && 'cap--loading'
      )}
    >
      {/* 舞台：只画，不响应指针（拖动一律走下方轨道） */}
      <div className="cap-stage" style={stageStyle}>
        {challenge ? (
          <>
            <img className="cap-bg" src={challenge.background} alt="" draggable={false} />
            <img
              className="cap-piece"
              src={challenge.piece}
              alt=""
              draggable={false}
              style={{
                // 全部用百分比：容器宽度随弹窗变化时不需要重新测量
                left: `${(dragX / challenge.width) * 100}%`,
                top: `${(challenge.pieceY / challenge.height) * 100}%`,
                width: `${(challenge.pieceWidth / challenge.width) * 100}%`,
                height: `${(challenge.pieceHeight / challenge.height) * 100}%`
              }}
            />
          </>
        ) : (
          <div className="cap-skeleton" />
        )}

        {(!challenge || loadError) && (
          <div className="cap-overlay">
            {loadError ? (
              <span>{loadError}</span>
            ) : (
              <>
                <span className="cap-spinner" aria-hidden />
                <span>{t('正在加载验证码…')}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* 轨道：拖这里的滑块 */}
      <div ref={railRef} className="cap-track">
        <div className="cap-track-fill" style={{ width: fillWidth }} aria-hidden />
        <div
          ref={knobRef}
          className="cap-knob"
          style={{ left: knobLeft }}
          role="slider"
          tabIndex={interactive ? 0 : -1}
          aria-label={t('拖动滑块完成拼图')}
          aria-valuemin={0}
          aria-valuemax={maxX}
          aria-valuenow={Math.round(dragX)}
          aria-disabled={!interactive}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onKeyDown={handleKeyDown}
        >
          {status === 'passed' ? (
            <Check aria-hidden />
          ) : status === 'verifying' ? (
            <span className="cap-spinner" aria-hidden />
          ) : (
            <ChevronRight aria-hidden />
          )}
        </div>
      </div>

      <div className="cap-foot">
        <span className="cap-hint" role="status" aria-live="polite">
          {hint}
        </span>
        <button
          type="button"
          className="cap-refresh"
          onClick={onRefresh}
          disabled={loading}
          title={t('换一张')}
          aria-label={t('换一张验证码')}
        >
          <RefreshCw aria-hidden />
        </button>
      </div>
    </div>
  )
}
