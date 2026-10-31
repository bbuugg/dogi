/**
 * 「语音输入静音超时」偏好的读写 + 响应式订阅（与 `terminal-prefs.ts` 同一套模式）。
 *
 * 这个值跟着人走（说话习惯），不跟着设备走，所以它在 `PREF_KEYS` 里、由服务端存一份，
 * 本地只是首帧缓存 —— 手机上改成 90 秒，桌面上也是 90 秒。
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
import { readPref, subscribePrefs, writePref } from './prefs-sync'

/** 连续静音超时：默认 60 秒；合法区间 [0, 3600]，0 = 不限 */
const SILENCE_TIMEOUT_KEY = 'fizz.web.voiceSilenceTimeout'
const DEFAULT_SILENCE_TIMEOUT_SEC = 60
const MAX_SILENCE_TIMEOUT_SEC = 3600

/** 归一化到 [0, MAX] 的整数秒；非数字 / 越界 / 负数都归一化，别让脏值流到识别逻辑里 */
export function normalizeSilenceTimeoutSec(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SILENCE_TIMEOUT_SEC
  return Math.min(MAX_SILENCE_TIMEOUT_SEC, Math.round(value))
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 读「静音超时」偏好（秒）；没存过 / 存坏了都返回默认 60 */
export function getVoiceSilenceTimeout(): number {
  const raw = readPref(SILENCE_TIMEOUT_KEY)
  if (raw === null) return DEFAULT_SILENCE_TIMEOUT_SEC
  return normalizeSilenceTimeoutSec(Number(raw))
}

/**
 * 设置「静音超时」偏好（秒）。
 *
 * 这个 key 在 `PREF_KEYS` 里（跨端一致：它取决于人的说话习惯，不取决于这台设备的
 * 麦克风），所以 `writePref` 除了写本地缓存还会合并上行到 `POST /api/prefs`。
 */
export function setVoiceSilenceTimeout(sec: number): void {
  writePref(SILENCE_TIMEOUT_KEY, String(normalizeSilenceTimeoutSec(sec)))
  for (const listener of listeners) listener()
}

/*
 * 订阅变更：本地总线（别的窗口）**和**服务端下行（`state-ws` 的 `prefs` 快照）。
 * 模块级单例，不需要退订。
 */
subscribePrefs(SILENCE_TIMEOUT_KEY, () => {
  for (const listener of listeners) listener()
})

/** 订阅「静音超时」偏好（秒） */
export function useVoiceSilenceTimeout(): number {
  return useSyncExternalStore(subscribe, getVoiceSilenceTimeout, () => DEFAULT_SILENCE_TIMEOUT_SEC)
}
