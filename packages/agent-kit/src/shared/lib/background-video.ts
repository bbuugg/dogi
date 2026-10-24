/**
 * 背景视频的本地存放（IndexedDB）。
 *
 * ## 为什么不跟背景图走同一条路
 *
 * 背景图是**压过的 JPEG data URL**（≤1.6MB，见 `prepareThemeImage`），塞 localStorage 刚好。
 * 视频不行：动辄几十 MB，而 localStorage 只有 5MB 配额、且只收字符串（base64 再胖 1/3）。
 * IndexedDB 能直接存 `Blob`，配额按磁盘比例给 —— 视频本体放这儿。
 *
 * **引用**（`key` / `mime` / 文件名）仍然写在 localStorage 的主题配置里
 * （`ThemeBackground.video`）：主题切换、跨窗口同步还是同步的，视频晚一拍加载不影响配色。
 *
 * ## 边界
 *
 * - 这个模块只负责「存 / 取 / 删 Blob」，**不碰 DOM、不认识主题**。播放层在
 *   `shared/hooks/useColorTheme.ts`（`applyBackgroundVideo`）。
 * - 拿不到库（隐私模式 / 配额 0 / 老 WebView）时全部降级成「没有视频能力」：读回 `null`、
 *   写抛错，调用方按「存不下」提示 —— 绝不让启动挂在 `indexedDB.open` 上。
 */
const DB_NAME = 'fizz-media'
const DB_VERSION = 1
const STORE = 'background-videos'

/** 视频背景的**引用**（本体在 IndexedDB 里） */
export interface BackgroundVideoRef {
  /** IndexedDB 主键 */
  key: string
  /** 原始 MIME（`video/mp4` / `video/webm` …） */
  mime: string
  /** 文件名，设置页里显示用 */
  name: string
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    // 隐私模式 / 库被别的标签页占着：当作没有这个能力，别抛到启动路径上
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return dbPromise
}

/** 把视频写进库，返回引用（`key` 现生成，与主题配置里的那份一一对应） */
export async function putBackgroundVideo(blob: Blob, name: string): Promise<BackgroundVideoRef> {
  const db = await openDb()
  if (!db) throw new Error('本机不支持存放视频（IndexedDB 不可用）')
  const key = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(blob, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('视频写入失败'))
    tx.onabort = () => reject(tx.error ?? new Error('视频写入被中止'))
  })
  return { key, mime: blob.type || 'video/mp4', name }
}

/** 读回视频本体；不存在 / 库不可用时 `null` */
export async function getBackgroundVideo(key: string): Promise<Blob | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise<Blob | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const request = tx.objectStore(STORE).get(key)
      request.onsuccess = () => {
        const value: unknown = request.result
        resolve(value instanceof Blob ? value : null)
      }
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** 删掉一条视频（移除背景 / 换视频 / 删自定义主题时调用）；失败静默 —— 留个孤儿不影响功能 */
export async function deleteBackgroundVideo(key: string | null | undefined): Promise<void> {
  if (!key) return
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}
