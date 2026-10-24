/**
 * 工具权限模式的展示文案与本地持久化（设置 →「通用」、聊天框下拉、新建流程弹窗共用一份）。
 *
 * 展示只放「怎么显示」；真正的语义在服务端 / `tools.ts` 的 `guardWrite` 里。
 * 持久化直接落 localStorage（key 沿用旧 web-host 的，已存的设置不丢）。
 */
import type { AiPermissionMode } from '@fizz/contracts/types'
import { t } from '@fizz/i18n'

/** 命令执行权限：存本地（跟着浏览器走），默认 confirm —— 网页端不该默认裸跑命令 */
const PERMISSION_KEY = 'fizz.web.permissionMode'

/** 读权限档：full / confirm（默认）/ readonly；存坏了回落 confirm */
export function loadPermissionMode(): AiPermissionMode {
  // ⚠️ SSR 上没有 localStorage：store 在模块层创建时就会调这里（conversation slice 的
  // 初始 state），这里一裸读，整页 SSR 就是 unhandledRejection —— 同类 loader 的守卫
  // 见 lib/stores/slices/conversation.ts 的 lsGet / lsSet。
  if (typeof localStorage === 'undefined') return 'confirm'
  const raw = localStorage.getItem(PERMISSION_KEY)
  return raw === 'full' || raw === 'readonly' ? raw : 'confirm'
}

export function savePermissionMode(mode: AiPermissionMode): void {
  // 与 load 同守卫：目前只在浏览器事件里被调，留着这道墙防同坑复发
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(PERMISSION_KEY, mode)
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
