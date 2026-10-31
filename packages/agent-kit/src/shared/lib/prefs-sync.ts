/**
 * 偏好总线：本地偏好的**跨窗口**变更 + 需要跨端一致的那批的**服务端同步**。
 *
 * ## 两个层级，别混
 *
 * 1. **本地总线**（本文件下半部分）：浏览器原生 `storage` 事件。它**只在别的窗口写存储时
 *    触发**，正好覆盖桌面端「设置页是独立窗口（另一个渲染进程 = 另一份模块级单例）」这一半，
 *    不要求宿主实现任何新能力（desktop 生产构建跑在 `file://` 下，三个窗口共享同一份
 *    localStorage，主题 / 快捷键 / 面板宽度早就依赖这点）。
 * 2. **服务端同步**（`configurePrefsSync` / `applyServerPrefs`）：`PREF_KEYS` 里那些要
 *    「不管哪里打开都是同一份」的偏好（见 `@fizz/contracts` 的 `prefs.ts`）。写入走
 *    `POST /api/prefs`（**提交几个 key 就改几个**），下行靠 `state-ws` 的 `prefs` 快照域。
 *
 * ## 谁走哪条
 *
 * - `PREF_KEYS` 里的：`writePref` 写本地（首帧缓存）**并**上行 → 服务端落盘 → 推给所有端；
 * - 其余（面板宽度 / 字号 / 快捷键 / 通知 / 主题…）：只走本地总线。这些是**设备形态**相关，
 *   同步过去是负体验（手机跟着桌面的字号变）。
 *
 * ## 为什么下行要「手工派发一个合成 StorageEvent」
 *
 * 服务端推来新值后，本窗口把值写进 localStorage —— 但按规范，**同窗口写存储不会触发**
 * `storage` 事件。于是收得到推送、界面却不更新。这里在写完之后补一个合成的 `StorageEvent`，
 * 让仓库里那批「各自 `addEventListener('storage', …)`」的老实现（终端 / 文件树 / 面板宽度…）
 * 全部自动生效，不用逐个改造。
 *
 * ⚠️ 约定：新增偏好**一律用 `writePref` 写盘 + `subscribePrefs` 订阅**，不要再自己
 * `window.addEventListener('storage', ...)`；要不要跨端一致，只看它进不进 `PREF_KEYS`。
 */
import {
  DEFAULT_PREFS,
  PREF_KEYS,
  isPrefKey,
  normalizePrefs,
  type PrefsPatch
} from '@fizz/contracts'

/** 订阅回调：偏好变了，自己去 `loadXxx()` 重读（总线不缓存值，避免两份真源） */
type Listener = () => void

/**
 * 订阅 / 分发核：**不碰 window**，纯 Map + Set 的记账。
 *
 * 单独抽出来是为了能在 node 环境直接测（仓库没有 jsdom，见 AGENTS.md 的测试约定）；
 * 浏览器那一层只是把 `storage` 事件喂给 `dispatch` / `dispatchAll`。
 */
export interface PrefsHub {
  /** 订阅若干 key（`'*'` = 任意 key）。返回退订函数 */
  subscribe(keys: string | readonly string[], cb: Listener): () => void
  /** 某个 key 变了。没人订就什么都不做 */
  dispatch(key: string): void
  /** 整个存储被清空（`storage` 事件的 `key === null`）：所有订阅者都重读 */
  dispatchAll(): void
}

export function createPrefsHub(): PrefsHub {
  /** key → 订阅者（同一个 key 可能被 store、面板、下拉多处关注） */
  const byKey = new Map<string, Set<Listener>>()
  /** 不关心具体 key 的订阅者（`'*'`）：登出清场、或一次要重读一整批偏好 */
  const wildcard = new Set<Listener>()

  const dispatch = (key: string): void => {
    const direct = byKey.get(key)
    if ((direct?.size ?? 0) === 0 && wildcard.size === 0) return
    // 同一个回调既订了具体 key 又订了 '*' 时只调一次
    const targets = new Set<Listener>(direct ?? [])
    for (const fn of wildcard) targets.add(fn)
    for (const fn of targets) fn()
  }

  const dispatchAll = (): void => {
    const targets = new Set<Listener>(wildcard)
    for (const set of byKey.values()) for (const fn of set) targets.add(fn)
    for (const fn of targets) fn()
  }

  return {
    dispatch,
    dispatchAll,
    subscribe: (keys, cb) => {
      const list = typeof keys === 'string' ? [keys] : keys
      /** 记下「订到了哪个桶」，退订时按桶删 */
      const buckets: Array<{ key: string; set: Set<Listener> }> = []
      for (const key of list) {
        if (key === '*') {
          wildcard.add(cb)
          buckets.push({ key, set: wildcard })
          continue
        }
        let set = byKey.get(key)
        if (!set) {
          set = new Set<Listener>()
          byKey.set(key, set)
        }
        set.add(cb)
        buckets.push({ key, set })
      }
      return () => {
        for (const { key, set } of buckets) {
          set.delete(cb)
          // 空了就把桶摘掉，别让 byKey 随历史上出现过的 key 无限长
          if (set.size === 0 && key !== '*') byKey.delete(key)
        }
      }
    }
  }
}

/** 进程内唯一的总线（每个渲染进程 / 每个标签一份，跨窗口靠 storage 事件串起来） */
const hub = createPrefsHub()

let listening = false

/** 只挂**一个** window 级监听，按 key 分发（各写各的曾是 20 份并存） */
function ensureListening(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('storage', (event) => {
    // key === null = 别的窗口调了 localStorage.clear()（登出清场）→ 全部按缺省重读
    if (event.key === null) hub.dispatchAll()
    else hub.dispatch(event.key)
  })
}

/** 读一个本地偏好；SSR / 存储不可用都返回 null（缺省值由调用方的 `loadXxx()` 兜） */
export function readPref(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 写本地缓存（不上行）。返回是否真写进去了 */
function writeLocal(key: string, value: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    // 存储不可用（隐私模式 / 配额满）：本次会话内仍按内存态生效，只是不跨窗口 / 不跨重启
    return false
  }
}

// ---------------------------------------------------------------------------
// 服务端同步（上行：合并 patch；下行：快照 → 本地缓存 → 唤醒所有监听者）
// ---------------------------------------------------------------------------

/** 上行发送器：由 `agent-store.ts` 注入（那里才拿得到连接与 api） */
export type PrefsSender = (patch: PrefsPatch) => Promise<unknown>

let sendPrefs: PrefsSender | null = null

/** 攒着的改动（连续改 10 项只发一次请求）；key 也在 `pendingKeys` 里，下行时跳过 */
let pendingPatch: PrefsPatch = {}
const pendingKeys = new Set<string>()

let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush(delay: number): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPrefs()
  }, delay)
}

/**
 * 注入上行发送器。传 `null` 关闭上行（未连接 / 测试）。
 *
 * 注入时机是 `agent-store` 建好连接之后；注入前攒下的改动会在注入时补发。
 */
export function configurePrefsSync(send: PrefsSender | null): void {
  sendPrefs = send
  if (send && Object.keys(pendingPatch).length > 0) scheduleFlush(0)
}

async function flushPrefs(): Promise<void> {
  if (!sendPrefs) return
  const patch = pendingPatch
  if (Object.keys(patch).length === 0) return
  pendingPatch = {}
  try {
    await sendPrefs(patch)
    // 服务端收下了：解除「本地写优先」的保护，后续快照可以正常覆盖本地
    for (const key of Object.keys(patch)) pendingKeys.delete(key)
  } catch {
    // 失败（离线 / 服务端忙）：合回去，退避重试。别丢用户的改动，也别打成死循环
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in pendingPatch)) pendingPatch[key as keyof PrefsPatch] = value
    }
    scheduleFlush(5_000)
    return
  }
  // 发送期间又攒了新的
  if (Object.keys(pendingPatch).length > 0) scheduleFlush(120)
}

/**
 * 写一个偏好。
 *
 * - `PREF_KEYS` 里的：本地先写（首帧 / 离线可用），再**合并上行**到 `POST /api/prefs`；
 * - 其余的：只写本地，跨窗口靠浏览器 `storage` 事件（同窗口那半由调用方自己 `set()`）。
 *
 * 写盘失败不抛：本次会话内仍按内存态生效，别让界面挂掉。
 */
export function writePref(key: string, value: string): void {
  if (!writeLocal(key, value)) return
  if (!isPrefKey(key)) return
  pendingPatch[key] = value
  pendingKeys.add(key)
  scheduleFlush(120)
}

/**
 * 抹掉一个本地偏好（回到缺省值）。
 *
 * 同步 key 不能「删服务端那份」——语义是回到默认值，所以显式提交 `DEFAULT_PREFS[key]`。
 */
export function removePref(key: string): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(key)
    } catch {
      // 同 writePref：存不进去不致命
    }
  }
  if (!isPrefKey(key)) return
  pendingPatch[key] = DEFAULT_PREFS[key]
  pendingKeys.add(key)
  scheduleFlush(120)
}

/** 「本地值已收进服务端」的标记（本身不同步，只是个一次性开关） */
const MIGRATION_FLAG = 'fizz.web.prefsSyncedOnce'

let migrated = false

/**
 * 把浏览器里**已有的**偏好灌进服务端（只做一次）。
 *
 * 返回 `true` = 刚刚发起迁移，调用方应**跳过**这一次快照（否则旧默认值会把本地值压掉）。
 * 上行失败时 `pendingKeys` 保护仍然生效，下一份快照也不会覆盖，重试成功后自然收敛。
 */
function migrateLocalPrefs(): boolean {
  if (migrated) return false
  migrated = true
  if (readPref(MIGRATION_FLAG) === '1') return false
  writeLocal(MIGRATION_FLAG, '1')

  let queued = 0
  for (const key of PREF_KEYS) {
    const value = readPref(key)
    if (value === null) continue
    pendingPatch[key] = value
    pendingKeys.add(key)
    queued += 1
  }
  if (queued === 0) return false
  scheduleFlush(0)
  return true
}

/**
 * 下行：把服务端权威快照落到本地缓存，并唤醒所有订阅者。
 *
 * 调用方是 `agent-store` 里的 `prefs` 快照域订阅（`state-ws`），不需要别处再调。
 *
 * - 本地刚写、还没被服务端确认的 key（`pendingKeys`）**跳过**：否则一次迟到的旧快照会把
 *   用户刚改的值打回去；
 * - 值没变就什么都不做（快照是全量的，大部分 key 每次都不变）。
 */
export function applyServerPrefs(snapshot: unknown): void {
  /*
   * 升级迁移：老用户的偏好只存在浏览器里，服务端那份还是默认值。第一份快照**不能**直接把
   * 本地的自定义值覆盖掉（那等于把用户配好的重试次数 / 终端偏好抹回默认），要先上行一次，
   * 把本地已有值灌进服务端，之后才以服务端为准。标记写在本地，只做一次。
   */
  if (migrateLocalPrefs()) return

  const clean = normalizePrefs(snapshot)
  for (const key of PREF_KEYS) {
    if (pendingKeys.has(key)) continue
    const value = clean[key]
    if (readPref(key) === value) continue
    if (!writeLocal(key, value)) continue
    wakeListeners(key, value)
  }
}

/**
 * 让「同窗口」的监听者也动起来。
 *
 * 写 localStorage 在同窗口不触发 `storage` 事件，而仓库里那批老实现（终端偏好 / 文件树 /
 * 面板宽度…）都挂在这个事件上。合成一个派发出去，它们就自动重读了。
 * 老环境不支持 `new StorageEvent` 时退回内部总线（新代码都走 `subscribePrefs`）。
 */
function wakeListeners(key: string, value: string): void {
  if (typeof window !== 'undefined' && typeof StorageEvent === 'function') {
    try {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key,
          newValue: value,
          oldValue: null,
          storageArea: window.localStorage
        })
      )
      return
    } catch {
      // 某些环境（老 WebView）不让构造：退到内部总线
    }
  }
  hub.dispatch(key)
}

/**
 * 订阅本地偏好的变更（跨窗口 + 服务端下行）。`keys` 传 `'*'` 表示任意 key。
 *
 * 返回退订函数。SSR 上直接返回空操作（store 在模块层创建时就会调到这里）。
 */
export function subscribePrefs(
  keys: string | readonly string[],
  onPrefsChanged: Listener
): () => void {
  if (typeof window === 'undefined') return () => {}
  ensureListening()
  return hub.subscribe(keys, onPrefsChanged)
}
