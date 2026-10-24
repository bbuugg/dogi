/**
 * 屏幕常亮：把 `lib/wake-lock.ts` 的持有逻辑挂到 React 树上。
 *
 * 挂在应用外壳上跑一次（见各端的 `app/app-shell.tsx`），和 `use-notify-watcher`
 * 同一个位置同一个理由：常亮是**整屏**的事 —— 对话 / 任务 / 流程三个页面都是
 * 「放着跑一会儿」的场景，不该由每个页面各自申请。
 *
 * ## 运行态从哪来
 *
 * `conversation-activity` 是**服务端权威**的「谁在跑」（含后台会话与其他标签页），
 * 这里只把它折成一个布尔喂给 wake-lock；wake-lock 自己不做 store / WS 订阅。
 * 这个 hook 只在「有会话开始 / 结束 / 进入等待」时重渲染，不跟流式 token。
 *
 * ## 为什么偏好不是 effect 依赖
 *
 * 偏好 / 运行态变化由 `startWakeLock` 内部订阅的监听自己驱动申请 / 释放（见那边
 * `listeners.add(sync)`）。真让 React 重渲染再驱动一次，会多出一条「卸载时该放锁、
 * 挂载时该申请」的路径 —— 而 `startWakeLock` 的清理函数是**故意不放锁**的
 * （视图切换时不该放，见那边注释）。
 */
import { useEffect } from 'react'
import { useActivities } from '@fizz/agent-kit/shared/lib/conversation-activity'
import {
  setWakeLockSessionRunning,
  startWakeLock
} from '@fizz/agent-kit/shared/lib/wake-lock'

export function useScreenAwake(): void {
  const activities = useActivities()
  const sessionRunning = [...activities.values()].some((activity) => activity.running)

  // 先同步运行态、再挂常亮：首帧就有一轮在跑时（刷新 / 切回来），startWakeLock
  // 的第一次 sync 才能直接算出「该锁」。
  useEffect(() => {
    setWakeLockSessionRunning(sessionRunning)
  }, [sessionRunning])

  useEffect(() => startWakeLock(), [])
}
