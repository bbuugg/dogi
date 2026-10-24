/**
 * 代码编辑器的视图偏好：**自动换行** / **行号**。
 *
 * 这两个开关的入口在文件面板自己的标签条右侧（`FilesPanel`），不是 `MonacoEditor`
 * 自带的那条工具栏 —— 那边被 `showHeader={false}` 收起来了。所以偏好由 `FilesPanel`
 * 持有、以受控 props 传给 `MonacoEditor`。
 *
 * 全局一份（不按工作区 / 会话）：它们是「看代码的手感」，不是某个文件的状态 ——
 * 换项目时还回默认才叫别扭。默认：换行开、行号开。
 *
 * 与 `lib/terminal-prefs.ts` / `lib/panel-width.ts` 同一套 `useSyncExternalStore` 写法。
 */
import { useSyncExternalStore } from 'react'

const WRAP_KEY = 'fizz.web.editorWordWrap'
const LINE_NUMBERS_KEY = 'fizz.web.editorLineNumbers'

/** Monaco 的 `wordWrap` 取值 */
export type WordWrap = 'on' | 'off'

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** 自动换行；没存过 = `'on'`（窄面板里换行更实用） */
export function getWordWrap(): WordWrap {
  try {
    return localStorage.getItem(WRAP_KEY) === 'off' ? 'off' : 'on'
  } catch {
    return 'on'
  }
}

export function setWordWrap(value: WordWrap): void {
  const next: WordWrap = value === 'off' ? 'off' : 'on'
  try {
    localStorage.setItem(WRAP_KEY, next)
  } catch {
    // 存不进去也不致命：本次会话内仍然生效
  }
  notify()
}

/** 是否显示行号；存了 `'0'` 才关 */
export function getLineNumbers(): boolean {
  try {
    return localStorage.getItem(LINE_NUMBERS_KEY) !== '0'
  } catch {
    return true
  }
}

export function setLineNumbers(value: boolean): void {
  try {
    localStorage.setItem(LINE_NUMBERS_KEY, value ? '1' : '0')
  } catch {
    // 同上
  }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// 服务端快照 = 默认值，与客户端首帧一致，不会 hydration 打架
export function useWordWrap(): WordWrap {
  return useSyncExternalStore(subscribe, getWordWrap, () => 'on' as WordWrap)
}

export function useLineNumbers(): boolean {
  return useSyncExternalStore(subscribe, getLineNumbers, () => true)
}

// 别的窗口改了 localStorage：`storage` 事件只在「别的窗口改了存储」时触发（同窗口不会）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === WRAP_KEY || e.key === LINE_NUMBERS_KEY) notify()
  })
}