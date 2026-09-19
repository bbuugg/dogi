import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * 事件订阅封装：与 preload 的 `subscribe` 保持同一形状 —— 同步返回退订函数。
 * Tauri 的 `listen` 是异步的，这里在 promise 落地后按需补退订。
 */
export function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null
  let cancelled = false
  void listen<T>(event, (e) => callback(e.payload)).then((fn) => {
    if (cancelled) fn()
    else unlisten = fn
  })
  return () => {
    cancelled = true
    if (unlisten) unlisten()
  }
}

/** Uint8Array → base64（Tauri IPC 走 JSON，二进制需自行编码） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** base64 → Uint8Array */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** 终端写入的数据：字符串按 UTF-8 编码后与二进制统一走 base64 */
export function terminalDataToBase64(data: string | Uint8Array): string {
  if (typeof data === 'string') return bytesToBase64(new TextEncoder().encode(data))
  return bytesToBase64(data)
}
