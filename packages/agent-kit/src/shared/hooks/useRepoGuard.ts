/**
 * 「这个项目目录是不是 git 仓库」的前置守卫。
 *
 * 新建**流程**要在弹窗**打开的那一刻**就探一次 —— 而不是等用户把表单填完、
 * 点了提交才告诉他「这个目录建不了」。
 *
 * 流程不强制要求仓库（产物只是写进项目目录，没仓库照跑，代价是 `.fizz/` 不会被
 * git 忽略），所以「否」的含义留给调用方，这里只管探测与初始化。
 */
import { useCallback, useState } from 'react'
import type { AgentApi } from '@fizz/agent-client/api'

export interface RepoGuardState {
  /** 正在探测仓库状态 / 正在初始化 */
  busy: boolean
  /** true = 正弹着「要不要初始化成 git 仓库」的确认框 */
  asking: boolean
  error: string | null
  /** 弹窗打开时调它：探一次仓库状态；不是仓库就把确认框弹出来 */
  check: () => Promise<void>
  /** 确认框里选「是」：`git init` + 首次提交。成功返回 true */
  confirm: () => Promise<boolean>
  /** 确认框里选「否」：只收掉确认框，后续由调用方决定 */
  decline: () => void
  /** 关弹窗时重置（否则下次打开会带着上一次的状态） */
  reset: () => void
}

export function useRepoGuard(api: AgentApi | null, workspaceId: string | null): RepoGuardState {
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = useCallback((): void => {
    setBusy(false)
    setAsking(false)
    setError(null)
  }, [])

  const check = useCallback(async (): Promise<void> => {
    if (!api || !workspaceId) return
    setBusy(true)
    setError(null)
    try {
      const status = await api.gitStatus(workspaceId)
      setAsking(!status.isRepo)
    } catch (err) {
      // 探测失败**不拦着**建：服务端建任务时本来就会再判一次，真不行它会给一句人话；
      // 在这里瞎猜「不是仓库」然后逼用户初始化，反而是更糟的错。
      setAsking(false)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [api, workspaceId])

  const confirm = useCallback(async (): Promise<boolean> => {
    if (!api || !workspaceId) return false
    setBusy(true)
    setError(null)
    try {
      await api.gitAction(workspaceId, { action: 'init-commit' })
      setAsking(false)
      return true
    } catch (err) {
      // 初始化失败：确认框留着（用户能看到原因，也能重试），别静默收掉
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [api, workspaceId])

  const decline = useCallback((): void => setAsking(false), [])

  return { busy, asking, error, check, confirm, decline, reset }
}
