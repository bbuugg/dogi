/**
 * 滑块验证码弹窗 + 命令式入口（移植自 `console/apps/captcha/sdk/src/index.ts` 的 `open()`）。
 *
 * 用法与原来的 SDK 完全同构，只是把「加载远程 UMD 脚本 → 打开 iframe/Shadow DOM」换成了
 * 「渲染一个本地 Dialog」：
 *
 * ```tsx
 * const captcha = useCaptcha()
 * const passToken = await captcha.request(serverBase)   // '' = 服务端没要求；null = 用户取消
 * ...
 * {captcha.node}
 * ```
 *
 * 状态机与原版一致：签发 → 拖动 → 校验 → 通过（拿一次性票据）/ 失败（700ms 后自动换一张）。
 * 与原版的差别只有两点：
 * - 主题跟着工作台的 token 走（原版是 `system` / 显式 light|dark）；
 * - 文案只有中文（工作台没有多语言）。
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type {
  CaptchaAnswer,
  CaptchaChallenge,
  CaptchaIssueResponse,
  CaptchaVerifyResponse
} from '@fizz/contracts'
import { resolveServerUrl } from '@fizz/agent-client/server-base'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { t } from '@fizz/i18n'
import { SliderCaptcha, type CaptchaStatus } from './SliderCaptcha'
import '@fizz/agent-kit/shared/components/captcha/captcha.css'

/** 失败后多久自动换一张（与原版 SDK 一致：让用户看清「失败了」再刷新） */
const FAIL_RELOAD_DELAY = 700
/** 通过后停留多久再关窗（让用户看到「验证通过」） */
const PASS_CLOSE_DELAY = 450

const text = () => ({
  title: t('安全验证'),
  description: t('拖动下方滑块，把拼图块移到缺口处。'),
  idle: t('向右拖动滑块完成拼图'),
  ready: t('松开完成验证'),
  verifying: t('正在校验…'),
  passed: t('验证通过'),
  failed: t('验证失败，请重试'),
  network: t('网络异常，请重试'),
  loadFailed: t('加载失败，点右侧按钮重试'),
  empty: t('当前未启用验证码')
}) as const

interface CaptchaDialogProps {
  open: boolean
  /** 服务端地址覆盖（跨端连远端时用）；空 = 同源 */
  base?: string
  /** `''` = 服务端不要求验证码；`null` = 用户取消 */
  onResolve: (passToken: string | null) => void
}

function CaptchaDialog({ open, base, onResolve }: CaptchaDialogProps) {
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null)
  const [status, setStatus] = useState<CaptchaStatus>('idle')
  const [hint, setHint] = useState<string>(t('向右拖动滑块完成拼图'))
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  /** 组件已卸载 / 已关闭时不再 setState（请求是异步的，回来时可能已经关了） */
  const aliveRef = useRef(true)
  /** 只认最后一次签发的响应（连点刷新时旧响应会晚到） */
  const seqRef = useRef(0)
  const timersRef = useRef<number[]>([])
  const resolveRef = useRef(onResolve)
  resolveRef.current = onResolve

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((t) => t !== id)
      if (aliveRef.current) fn()
    }, ms)
    timersRef.current.push(id)
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      for (const id of timersRef.current) window.clearTimeout(id)
      timersRef.current = []
    }
  }, [])

  const load = useCallback(
    async (serverBase?: string) => {
      const seq = ++seqRef.current
      setLoading(true)
      setLoadError(null)
      setChallenge(null)
      setStatus('idle')
      setHint(text().idle)

      try {
        const res = await fetch(resolveServerUrl(serverBase, '/api/auth/captcha'), {
          cache: 'no-store'
        })
        if (seq !== seqRef.current) return
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as CaptchaIssueResponse
        if (seq !== seqRef.current) return

        // 服务端不要求验证码（鉴权未启用 / 显式关了）：直接放行，不用打扰用户
        if (!data.enabled) {
          resolveRef.current('')
          return
        }
        if (!data.challenge) throw new Error('缺少挑战数据')
        setChallenge(data.challenge)
        setStatus('ready')
        setHint(text().idle)
      } catch {
        if (seq !== seqRef.current) return
        setLoadError(text().loadFailed)
        setStatus('error')
        setHint(text().loadFailed)
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    },
    []
  )

  // 每次打开都换一张新挑战（挑战是一次性的，复用必失败）
  useEffect(() => {
    if (!open) return
    void load(base)
  }, [open, base, load])

  const submit = useCallback(
    async (answer: CaptchaAnswer) => {
      if (!challenge) return
      setStatus('verifying')
      setHint(text().verifying)

      try {
        const res = await fetch(resolveServerUrl(base, '/api/auth/captcha/verify'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: challenge.id, answer })
        })
        const data = (await res.json().catch(() => null)) as CaptchaVerifyResponse | null

        if (data?.ok && data.passToken) {
          setStatus('passed')
          setHint(text().passed)
          const token = data.passToken
          later(() => resolveRef.current(token), PASS_CLOSE_DELAY)
          return
        }

        setStatus('failed')
        setHint(data?.error ?? text().failed)
        // 失败：挑战已被服务端烧掉，必须换一张
        later(() => void load(base), FAIL_RELOAD_DELAY)
      } catch {
        setStatus('error')
        setHint(text().network)
        later(() => void load(base), FAIL_RELOAD_DELAY)
      }
    },
    [base, challenge, later, load]
  )

  const handleOpenChange = (next: boolean) => {
    if (!next) resolveRef.current(null)
  }

  const disabled = status === 'verifying' || status === 'passed' || !!loadError

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{text().title}</DialogTitle>
          <DialogDescription>{text().description}</DialogDescription>
        </DialogHeader>
        <SliderCaptcha
          challenge={challenge}
          status={status}
          hint={hint}
          disabled={disabled}
          loading={loading}
          loadError={loadError}
          onAnswer={(answer) => void submit(answer)}
          onRefresh={() => void load(base)}
        />
      </DialogContent>
    </Dialog>
  )
}

export interface CaptchaController {
  /**
   * 打开验证码弹窗，等用户完成。
   *
   * - 返回**票据字符串**：登录时放进 `captchaPass`；
   * - 返回 `''`：服务端当前不要求验证码，直接登录；
   * - 返回 `null`：用户关掉了弹窗（调用方应当中止登录，别把空票据发过去）。
   */
  request: (base?: string) => Promise<string | null>
  /** 挂到任意位置即可（内容为空，真正的弹窗走 portal） */
  node: ReactNode
}

export function useCaptcha(): CaptchaController {
  const [session, setSession] = useState<{
    resolve: (token: string | null) => void
    base?: string
  } | null>(null)

  const request = useCallback(
    (base?: string) =>
      new Promise<string | null>((resolve) => {
        setSession(base ? { resolve, base } : { resolve })
      }),
    []
  )

  const settle = useCallback((token: string | null) => {
    setSession((cur) => {
      cur?.resolve(token)
      return null
    })
  }, [])

  return {
    request,
    node: (
      <CaptchaDialog
        open={session !== null}
        {...(session?.base ? { base: session.base } : {})}
        onResolve={settle}
      />
    )
  }
}
