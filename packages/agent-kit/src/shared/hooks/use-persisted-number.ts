"use client";

/**
 * localStorage 持久化的正数状态（sidebar / 抽屉 / 终端高度这类「宽度高度」偏好）。
 * 存不进去（隐私模式等）就只保留本次会话。
 */
import { useState } from 'react'

export function usePersistedNumber(key: string, initial: number): [number, (v: number) => void] {
  const [value, setValue] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(key)
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) && n > 0 ? n : initial
    } catch {
      return initial
    }
  })
  return [
    value,
    (v: number): void => {
      setValue(v)
      try {
        localStorage.setItem(key, String(v))
      } catch {
        // 存不进去就只保留本次会话
      }
    }
  ]
}
