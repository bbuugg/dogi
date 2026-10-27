/**
 * 终端偏好的本地持久化 + 响应式订阅（与 `terminal-shell.ts` 同一套模式）。
 *
 * 现有几项：「选中即复制」「右键粘贴」「命令预测」「记录命令历史」「滚动缓冲行数」。
 * 做成「模块级 + 订阅」而不是组件 useState：设置页（弹窗）写、TerminalPanel 读，两个组件要
 * 实时同步 —— useSyncExternalStore 正好把订阅与 SSR 兜底都处理掉。以后终端偏好再加项就往这个
 * 文件里放。
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

/**
 * 选中即复制：终端里选中文字后自动写入剪贴板（**默认开**，与 Windows Terminal 的
 * copyOnSelect 行为对齐 —— 选完不用再按一次 Ctrl+C，这是终端里最高频的动作）。
 *
 * 关掉的多是「只想选中读一下、不想动剪贴板」的场景，开关留在设置 → 终端里。
 */
const copyOnSelect = createBoolPref('fizz.web.terminalCopyOnSelect', true)
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

/**
 * 数字型偏好：存字符串，读的时候按**允许集合**校验 —— 手改 localStorage / 旧版本写进去的值
 * 认不出来就回落默认，不会把 `scrollback: NaN` 塞给 xterm（那会让滚动缓冲整个失效）。
 */
function createNumberPref<T extends number>(key: string, allowed: readonly T[], defaultValue: T) {
  const get = (): T => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return defaultValue
      const parsed = Number(raw)
      return (allowed as readonly number[]).includes(parsed) ? (parsed as T) : defaultValue
    } catch {
      return defaultValue
    }
  }
  const set = (value: T): void => {
    try {
      if (value === defaultValue) localStorage.removeItem(key)
      else localStorage.setItem(key, String(value))
    } catch {
      // 存不进去也不致命：本次会话内仍然生效
    }
    for (const listener of listeners) listener()
  }
  const use = (): T => useSyncExternalStore(subscribe, get, () => defaultValue)
  return { get, set, use }
}

/**
 * 滚动缓冲行数：一个终端标签能**往上翻多少行**。
 *
 * xterm 自己的默认是 1000 行 —— 跑一次 `npm test`、`cat` 一个大文件、或翻一次日志就顶满了，
 * 再往上就没有了（用户反馈的「只能往上滚少量内容」就是这个）。默认提到 5000（VS Code 量级），
 * 再往上可选 10000 / 50000。
 *
 * 上限刻意不放开成自由输入：xterm 的缓冲是**每行按列数存 cell**，5 万行 × 200 列大约几十 MB，
 * 而且**每个终端标签各占一份**（标签是 `hidden` 不卸载的，见 PanelView）—— 随手填个 100 万
 * 就是几个 G。
 */
export const TERMINAL_SCROLLBACK_OPTIONS = [1000, 5000, 10000, 50000] as const
export type TerminalScrollback = (typeof TERMINAL_SCROLLBACK_OPTIONS)[number]
const scrollback = createNumberPref<TerminalScrollback>(
  'fizz.web.terminalScrollback',
  TERMINAL_SCROLLBACK_OPTIONS,
  5000
)
export const getTerminalScrollback = scrollback.get
export const setTerminalScrollback = scrollback.set
export const useTerminalScrollback = scrollback.use
