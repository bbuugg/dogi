/**
 * 渲染端的语言：在 `@fizz/i18n` 的进程级语言状态之上，补两件宿主相关的事。
 *
 * - **持久化**：首帧前从 localStorage 读回上次选择（服务端设置还没拉到时界面不会闪回中文）；
 * - **React 订阅**：`useLanguage()` 走 `useSyncExternalStore`，切语言后所有用到 `useT()`
 *   的组件一起重渲染。
 *
 * 服务端那份是**权威值**（工具 / 提示词要用），连接后 `refresh()` 会把它同步回来并覆盖
 * localStorage（见 store 的 `server-lists`）。
 */
import { useSyncExternalStore } from 'react'
import {
  getLanguage,
  setLanguage,
  subscribeLanguage,
  t,
  type AppLanguage
} from '@fizz/i18n'

const STORAGE_KEY = 'fizz.language'

export function readStoredLanguage(): AppLanguage | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'en' || value === 'zh' ? value : null
  } catch {
    return null
  }
}

/** 首帧前调用：把 localStorage 里的语言灌进 i18n 单例 */
export function bootstrapLanguage(): void {
  const stored = readStoredLanguage()
  if (stored) setLanguage(stored)
}

/** 记住选择（服务端保存成功后调用；失败也先让本机界面切过去） */
export function persistLanguage(language: AppLanguage): void {
  try {
    localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // 隐私模式 / 配额满：只影响下次启动的初值，不影响本次切换
  }
}

/** 当前语言（订阅变化） */
export function useLanguage(): AppLanguage {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage)
}

/**
 * 取当前语言的翻译函数（key = 中文原文）。
 *
 * 返回的函数依赖 `language`，所以只要组件用了 `useT()`，切语言就会重渲染。
 */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  useLanguage()
  return t
}
