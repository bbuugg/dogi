/**
 * 滑块验证码组件（移植自 `console/apps/captcha/sdk/src/widget.ts` 的原生 DOM 实现）。
 *
 * 原版是一段命令式 DOM 代码（`createElement` + 手挂监听），这里按 React 的写法重排，
 * 但**交互语义逐条保留**：
 * - 按下即 `setPointerCapture`：指针滑出舞台也继续跟手（拖到图片外面不会中断）；
 * - 位置一律换算成「逻辑 px」（`challenge.width` 坐标系）再上报，与服务端答案同一坐标系；
 * - 松手时补一条终态采样，保证服务端「末点 == 提交的 x」的校验恒成立；
 * - 键盘可达：方向键微调、Home/End 到两端、Enter 提交。
 *
 * 校验通过 / 失败 / 网络异常这些**状态**由上层（`use-captcha.tsx`）持有，这里只管画和拖。
 */
import { type PointerEvent as ReactPointerEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { CaptchaAnswer, CaptchaChallenge } from '@fizz/contracts'
import { RefreshCw } from 'lucide-react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { TrackRecorder } from './track'

/** 键盘微调步长（逻辑 px）；按住 Shift 走大步 */
const KEY_STEP = 2
const KEY_STEP_LARGE = 10

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
  const stageRef = useRef<HTMLDivElement>(null)
  const recorderRef = useRef(new TrackRecorder())
  const startRef = useRef<{ pointerX: number; x: number } | null>(null)

  /** 拼图块左边位置（逻辑 px） */
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)

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

  /** 舞台内容盒宽度 → 逻辑 px 的换算比例 */
  const scaleOf = (): number => {
    const el = stageRef.current
    const logicalWidth = challenge?.width ?? 1
    if (!el || logicalWidth <= 0) return 1
    // clientWidth 不含 border（舞台有 1px 边框），正是我们要的内容宽度
    return el.clientWidth > 0 ? el.clientWidth / logicalWidth : 1
  }

  const clampX = (x: number): number => {
    const max = challenge?.maxX ?? 0
    return Math.min(Math.max(x, 0), max)
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    // 只认主键 / 触摸 / 笔，右键菜单不启动拖动
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const el = e.currentTarget
    // 捕获指针：拖出舞台也继续收到 move/up（原版同样依赖这一点）
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // 个别环境不支持捕获：退化成普通拖动，仍可用
    }
    el.focus()
    startRef.current = { pointerX: e.clientX, x: dragX }
    recorderRef.current.begin(dragX, performance.now())
    setDragging(true)
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current
    if (!start || !interactive) return
    const next = clampX(start.x + (e.clientX - start.pointerX) / scaleOf())
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
    const max = challenge?.maxX ?? 0
    let next: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = clampX(dragX - step)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = clampX(dragX + step)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = max
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
      <div
        ref={stageRef}
        className="cap-stage"
        style={stageStyle}
        role="slider"
        tabIndex={interactive ? 0 : -1}
        aria-label="滑块验证码：拖动拼图块到缺口处"
        aria-valuemin={0}
        aria-valuemax={challenge?.maxX ?? 0}
        aria-valuenow={Math.round(dragX)}
        aria-disabled={!interactive}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onKeyDown={handleKeyDown}
      >
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
