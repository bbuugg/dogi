/**
 * 主题：类名落到 `<html>` 上，并**跨窗口跟随**。
 *
 * 「跟随系统」= 不锁定亮暗，交给 `prefers-color-scheme`；系统亮暗变化时实时跟着切。
 * 持久化的是**模式**（light / dark / system），落到 `<html>` 的是**解析后的亮暗**。
 *
 * 模式的读写**一律走宿主**（`AgentHost.loadTheme / saveTheme`）：web 落 localStorage；
 * desktop 落自己的 key 并同步主进程的 `nativeTheme.themeSource`（托盘菜单这类原生 UI
 * 的亮暗才跟得上）。多个窗口开同一个应用时，在一边切主题另一边得跟着变 —— `storage`
 * 事件正好只在「别的窗口改了存储」时触发（宿主都把模式落 localStorage，所以事件可用），
 * 拿它当跨窗口信号最省事。事件里不关心具体 key，重新读一次即可。
 */
import { useEffect, useState } from 'react'
import { getAgentHost, type ThemeMode } from '@fizz/agent-client/host'

/**
 * 主题模式：亮 / 暗 / 跟随系统。
 *
 * 定义在 `@fizz/agent-client/host`（宿主契约要按它落盘），这里只转出 —— 老引用
 * `import type { ThemeMode } from '@fizz/agent-kit/shared/hooks/useTheme'` 因此不用改。
 */
export type { ThemeMode }

/** 主题类名切换（dark 类挂到 <html> 上） */
export function applyThemeClass(theme: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

/**
 * 同一窗口内的主题变更广播。
 *
 * `storage` 事件**只在别的文档**里触发（同窗口的另一个 React 树收不到），而 desktop
 * 正是「标题栏 + 主界面」两棵并列的 React 树共享一个 document —— 在标题栏切了主题，
 * 主界面那棵树里 `useTheme` 的状态就不会更新（下次它自己 setMode 时又会把旧值写回去，
 * 表现为「切了没反应 / 弹回去」）。所以除了 window 级的 `storage`，再补一个同窗口的
 * CustomEvent：任一 `useTheme` 实例 `setMode` 后广播，其余实例据此重读宿主里的值。
 */
const THEME_CHANGED_EVENT = 'fizz:theme-changed'

function broadcastThemeChange(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT))
}

/** 系统当前偏好（`prefers-color-scheme`） */
function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 把主题模式解析成实际亮暗。
 *
 * 原来放在 `@fizz/agent-client/host` 里，但那个包不许碰 DOM（`window.matchMedia`），
 * 挪到这里 —— 它本来就是「界面怎么用主题」的一部分。
 */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? systemTheme() : mode
}

export interface UseTheme {
  /** 用户选的模式（light / dark / system）：设置里显示的那个 */
  mode: ThemeMode
  /** 实际生效的亮暗（跟随系统时随系统变） */
  theme: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
}

export function useTheme(): UseTheme {
  const [mode, setMode] = useState<ThemeMode>(() => getAgentHost().loadTheme())
  /** 系统偏好的当前值（mode = 'system' 时用它决定实际亮暗） */
  const [system, setSystem] = useState<'light' | 'dark'>(() => systemTheme())

  // 跟随系统：系统亮暗变化时实时同步（非 system 模式下这个值用不上，但代价为零）
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setSystem(mq.matches ? 'dark' : 'light')
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const theme: 'light' | 'dark' = mode === 'system' ? system : mode

  useEffect(() => {
    applyThemeClass(theme)
    getAgentHost().saveTheme(mode)
    // 通知同窗口的另一棵树（desktop 标题栏 ↔ 主界面）重读宿主里的模式。
    // 收方按「值没变就不 setState」处理，所以这里不会形成往返风暴。
    broadcastThemeChange()
  }, [mode, theme])

  useEffect(() => {
    const onStorage = (): void => {
      const next = getAgentHost().loadTheme()
      // 值一样就别 setState（免得两边来回写触发对方，白跑一圈）
      setMode((current) => (current === next ? current : next))
    }
    // 同窗口的另一棵树（desktop 标题栏）改了主题：storage 收不到，靠上面那个自定义事件
    const onSameWindow = onStorage
    window.addEventListener('storage', onStorage)
    window.addEventListener(THEME_CHANGED_EVENT, onSameWindow)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(THEME_CHANGED_EVENT, onSameWindow)
    }
  }, [])

  return { mode, theme, setMode }
}

/**
 * 让**已安装的 PWA** 的系统栏（安卓状态栏 + 浏览器工具栏）颜色跟着应用主题走。
 *
 * 安卓 Chrome 在「已安装」的 PWA 里，这条栏取 manifest 的 `theme_color`，而它在运行时可被
 * `<meta name="theme-color">` 覆盖。manifest 那份是**静态**的（`apps/mobile` 写死 `#0a0a0a`），
 * 切到亮色主题后栏还是深色、与页面顶部那条对不上。这里把 meta 同步到当前主题的
 * `--background` —— 就是手机壳最外层 / 顶栏 / 底栏那条底色，和 APK 下从透明状态栏里
 * 透出来的同色。
 *
 * ⚠️ 别改成 `--sidebar`：那是 web / desktop 外壳的色，比 `--background` 亮一档；
 * 手机壳通体是 `--background`，用侧栏色会让状态栏那条与页面「先灰后黑」。
 *
 * ⚠️ **Capacitor 壳里看不到效果也不冲突**：那边状态栏是透明的、`bg-background` 直接透出，
 * 图标深浅另由 `useStatusBarIconStyle` 管（见 `apps/mobile/src/app/client-root.tsx`）。
 * 桌面浏览器里这条 meta 同样决定安装后窗口工具栏的配色，无害。
 *
 * ⚠️ 值是 `oklch(...)` 原样 —— 需要较新的 Chrome（111+）才认这种色彩空间；更老的浏览器会
 * 忽略它、退回 manifest 的静态色（暗色），不会报错。
 */
export function useThemeColor(): void {
  useEffect(() => {
    const apply = (): void => {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue('--background')
        .trim()
      if (!value) return
      let meta = document.querySelector('meta[name="theme-color"]')
      if (!meta) {
        meta = document.createElement('meta')
        meta.setAttribute('name', 'theme-color')
        document.head.appendChild(meta)
      }
      meta.setAttribute('content', value)
    }

    apply()
    // 主题切换只改 `<html>` 上的两个属性（`class="dark"` 与 `data-theme="ocean"`，见 useTheme /
    // useColorTheme），没有事件可订阅，只能观察 —— **两个属性都要盯**，漏掉 data-theme 的话
    // 换了配色主题、状态栏颜色还停在旧主题的 `--background` 上。
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme']
    })
    return () => observer.disconnect()
  }, [])
}
