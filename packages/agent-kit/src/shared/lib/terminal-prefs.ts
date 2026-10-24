/**
 * 终端偏好的本地持久化 + 响应式订阅（与 `terminal-shell.ts` 同一套模式）。
 *
 * 现有四项：「选中即复制」「右键粘贴」「命令预测」「记录命令历史」。做成「模块级 + 订阅」而不是
 * 组件 useState：设置页（弹窗）写、TerminalPanel 读，两个组件要实时同步 ——
 * useSyncExternalStore 正好把订阅与 SSR 兜底都处理掉。以后终端偏好再加项就往这个文件里放。
 */
import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 拼一个布尔偏好的读 / 写 / 订阅三件套（读写 localStorage，坏数据当缺省值） */
function createBoolPref(key: string, defaultValue: boolean) {
  const get = (): boolean => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return defaultValue
      return raw === '1'
    } catch {
      return defaultValue
    }
  }
  const set = (enabled: boolean): void => {
    try {
      if (enabled === defaultValue) localStorage.removeItem(key)
      else localStorage.setItem(key, enabled ? '1' : '0')
    } catch {
      // 存不进去也不致命：本次会话内仍然生效
    }
    for (const listener of listeners) listener()
  }
  const use = (): boolean => useSyncExternalStore(subscribe, get, () => defaultValue)
  return { get, set, use }
}

// 别的窗口改了 localStorage：`storage` 事件只在「别的窗口改了存储」时触发（同窗口不会）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', () => {
    for (const listener of listeners) listener()
  })
}

/** 选中即复制：终端里选中文字后自动写入剪贴板（默认关，与主流终端的 copyOnSelection 一致） */
const copyOnSelect = createBoolPref('fizz.web.terminalCopyOnSelect', false)
export const getTerminalCopyOnSelect = copyOnSelect.get
export const setTerminalCopyOnSelect = copyOnSelect.set
export const useTerminalCopyOnSelect = copyOnSelect.use

/**
 * 右键粘贴：在终端里点**右键**时把系统剪贴板里的文本写进终端输入（默认开，Windows Terminal /
 * PuTTY 等主流终端的右键即粘贴）。
 *
 * 打开时会吞掉浏览器 / Electron 自带的右键菜单（否则菜单盖在终端上，粘贴什么都看不见）；
 * 已经有选中文字时**不粘贴**、保留原菜单 —— 那时用户点右键多半是要「复制 / 在浏览器中搜索」。
 * 关掉则完全回到原生右键菜单。
 */
const pasteOnRightClick = createBoolPref('fizz.web.terminalPasteOnRightClick', true)
export const getTerminalPasteOnRightClick = pasteOnRightClick.get
export const setTerminalPasteOnRightClick = pasteOnRightClick.set
export const useTerminalPasteOnRightClick = pasteOnRightClick.use

/**
 * 命令预测：输入时按命令历史 + 常见命令给补全建议（默认开）。
 * 只影响「提示」；历史照常记录（那是「记录命令历史」开关的事）。
 */
const commandPrediction = createBoolPref('fizz.web.terminalCommandPrediction', true)
export const getTerminalCommandPrediction = commandPrediction.get
export const setTerminalCommandPrediction = commandPrediction.set
export const useTerminalCommandPrediction = commandPrediction.use

/**
 * 记录命令历史：按回车提交的命令记入当前项目的历史（默认开，落
 * `<项目>/.fizz/terminal-history.json`）。关闭后不再记录；
 * 已有历史仍可用于预测与终端面板里的管理。
 */
const commandHistoryEnabled = createBoolPref('fizz.web.terminalCommandHistory', true)
export const getTerminalCommandHistoryEnabled = commandHistoryEnabled.get
export const setTerminalCommandHistoryEnabled = commandHistoryEnabled.set
export const useTerminalCommandHistoryEnabled = commandHistoryEnabled.use
