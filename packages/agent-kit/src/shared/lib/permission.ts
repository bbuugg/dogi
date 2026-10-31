/**
 * 工具权限模式的展示文案与本地持久化（设置 →「通用」、聊天框下拉、新建流程弹窗共用一份）。
 *
 * 展示只放「怎么显示」；真正的语义在服务端 / `tools.ts` 的 `guardWrite` 里。
 * 持久化直接落 localStorage（key 沿用旧 web-host 的，已存的设置不丢）。
 */
import type { AiPermissionMode } from '@fizz/contracts/types'
import { t } from '@fizz/i18n'
import { readPref, subscribePrefs, writePref } from '@fizz/agent-kit/shared/lib/prefs-sync'

/** 命令执行权限：存本地（跟着浏览器走），默认 confirm —— 网页端不该默认裸跑命令 */
const PERMISSION_KEY = 'fizz.web.permissionMode'

/** 读权限档：full / confirm（默认）/ readonly；存坏了回落 confirm */
export function loadPermissionMode(): AiPermissionMode {
  // ⚠️ SSR 上没有 localStorage：store 在模块层创建时就会调这里（conversation slice 的
  // 初始 state），这里一裸读，整页 SSR 就是 unhandledRejection —— 守卫收在 prefs-sync。
  const raw = readPref(PERMISSION_KEY)
  return raw === 'full' || raw === 'readonly' ? raw : 'confirm'
}

export function savePermissionMode(mode: AiPermissionMode): void {
  // 写盘即广播：别的窗口（desktop 的设置窗口）会收到 storage 事件，见 prefs-sync
  writePref(PERMISSION_KEY, mode)
}

/**
 * 订阅「**别的窗口**改了权限档」。
 *
 * 桌面端的设置页是独立窗口（独立渲染进程 = 另一份 store 单例），在那边改完只写了
 * localStorage —— 主窗口的 store 不重读就会一直按旧档跑，现象与「重试次数改了要重启」
 * 是同一个（详见 `conversation/storage.ts` 的 `watchConversationPrefs`）。
 *
 * 只覆盖跨窗口那一半：同窗口写 localStorage 不触发 `storage` 事件，那半由
 * `setPermissionMode` 自己 `set({ permissionMode })`。
 */
export function watchPermissionMode(
  onChange: (mode: AiPermissionMode) => void
): () => void {
  return subscribePrefs(PERMISSION_KEY, () => onChange(loadPermissionMode()))
}

export interface PermissionOption {
  value: AiPermissionMode
  /** 短标签（下拉里显示） */
  label: string
  /** 一句话说明（设置页显示当前选中项的解释） */
  hint: string
}

/** 顺序按「稳妥 → 放开」排，默认落在 confirm */
export const PERMISSION_OPTIONS: PermissionOption[] = [
  {
    value: 'confirm',
    label: '确认模式',
    hint: '改动前先询问；拒绝后不会重试。'
  },
  {
    value: 'readonly',
    label: '只读模式',
    hint: '只看不改，写入与执行都会被拒绝。'
  },
  {
    value: 'full',
    label: '完全访问',
    hint: '不问直接执行，请谨慎使用。'
  }
]

/**
 * 取某个模式的展示信息（取不到就退回第一个 = confirm）。
 *
 * ⚠️ 文案在这里现译（`t()`）：表里存的是**中文原文当 key**，英文见 `packages/i18n`。
 * 调用方要在渲染期取（每次重渲染都会重新翻），别在模块层缓存结果。
 */
export function permissionOption(mode: AiPermissionMode): PermissionOption {
  const option = PERMISSION_OPTIONS.find((o) => o.value === mode) ?? PERMISSION_OPTIONS[0]!
  return { ...option, label: t(option.label), hint: t(option.hint) }
}

/** 全部档位（已翻译）—— 给下拉列表用；`PERMISSION_OPTIONS` 本身是中文原文表，别直接渲染 */
export function permissionOptions(): PermissionOption[] {
  return PERMISSION_OPTIONS.map((option) => ({
    ...option,
    label: t(option.label),
    hint: t(option.hint)
  }))
}
