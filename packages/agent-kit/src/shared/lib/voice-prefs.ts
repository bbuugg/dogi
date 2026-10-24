/**
 * 「语音输入静音超时」偏好的本地持久化 + 响应式订阅（与 `terminal-prefs.ts` 同一套模式）。
 *
 * 为什么需要它：浏览器自带的 `SpeechRecognition` 即使设了 `continuous: true`，遇到说话
 * 停顿也常会自行 `onend`（端点检测比较敏感）—— 表现为「刚说了半句就停了」。`useVoiceInput`
 * 会在这类非主动的 `onend` 上自动续听，真正决定「何时停」的就是这个连续静音超时。
 *
 * 单位是**秒**（与设置页一致）。0 = 不自动停，一直听到用户手动点停。
 * 设置页（弹窗）写、Composer 读，两个组件要实时同步 —— 用 useSyncExternalStore
 * 把订阅与 SSR 兜底都处理掉。
 */
import { useSyncExternalStore } from 'react'

/** 连续静音超时：默认 60 秒；合法区间 [0, 3600]，0 = 不限 */
const SILENCE_TIMEOUT_KEY = 'fizz.web.voiceSilenceTimeout'
const DEFAULT_SILENCE_TIMEOUT_SEC = 60
const MAX_SILENCE_TIMEOUT_SEC = 3600

/** 归一化到 [0, MAX] 的整数秒；非数字 / 越界 / 负数都归一化，别让脏值流到识别逻辑里 */
export function normalizeSilenceTimeoutSec(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SILENCE_TIMEOUT_SEC
  return Math.min(MAX_SILENCE_TIMEOUT_SEC, Math.round(value))
}

/** 读「静音超时」偏好（秒）；没存过 / 存坏了都返回默认 60 */
export function getVoiceSilenceTimeout(): number {
  try {
    const raw = localStorage.getItem(SILENCE_TIMEOUT_KEY)
    if (raw === null) return DEFAULT_SILENCE_TIMEOUT_SEC
    return normalizeSilenceTimeoutSec(Number(raw))
  } catch {
    return DEFAULT_SILENCE_TIMEOUT_SEC
  }
}

/** 设置「静音超时」偏好（秒） */
export function setVoiceSilenceTimeout(sec: number): void {
  try {
    localStorage.setItem(SILENCE_TIMEOUT_KEY, String(normalizeSilenceTimeoutSec(sec)))
  } catch {
    // 存不进去也不致命：本次会话内 `useVoiceInput` 仍读内存 ref 生效
  }
  for (const listener of listeners) listener()
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// 别的窗口改了 localStorage：`storage` 事件只在「别的窗口改了存储」时触发（同窗口不会）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === SILENCE_TIMEOUT_KEY) for (const listener of listeners) listener()
  })
}

/** 订阅「静音超时」偏好（秒） */
export function useVoiceSilenceTimeout(): number {
  return useSyncExternalStore(subscribe, getVoiceSilenceTimeout, () => DEFAULT_SILENCE_TIMEOUT_SEC)
}
