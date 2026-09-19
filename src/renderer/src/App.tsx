import { useEffect, useState, useRef, useCallback } from 'react'
import { TerminalSquare } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { ActivityBar } from '@/components/ActivityBar'
import { useActiveActivity } from '@/activities'
import { pluginViewIdOf } from '@/activity-ids'
import { MonitorBadge } from '@/components/MonitorBadge'
import { SshProfileDialog } from '@/components/SshProfileDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { PaneLayout } from '@/components/PaneLayout'
import { CommandPalette } from '@/components/CommandPalette'
import { RunScriptDialog } from '@/components/RunScriptDialog'
import { ScriptsPage } from '@/components/ScriptsPage'
import { NotesPage } from '@/components/NotesPage'
import { PluginsPage } from '@/components/PluginsPage'
import { StatusBar } from '@/components/StatusBar'
import { ResizeHandle } from '@/components/ResizeHandle'
import { AntdProvider } from '@/components/AntdProvider'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { Button, Spin } from 'antd'
import { useIsDarkTheme } from '@/lib/theme'
import { customAccentVars } from '@/lib/theme'

function EmptyState() {
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
      <TerminalSquare className="size-12 opacity-30" />
      <div className="text-sm">还没有打开的终端</div>
      <div className="text-xs">添加主机即可连接远程 SSH 或本地终端</div>
      <Button type="primary" icon={<TerminalSquare className="size-4" />} onClick={() => setSshDialog(true, null)}>
        添加主机
      </Button>
    </div>
  )
}

/**
 * 收集当前主题信息，用于推送给 webview 插件。
 * 返回 { isDark, colorTheme, customVars } 结构，与 preload 脚本的 applyTheme 对齐。
 */
function collectThemeData(isDark: boolean, colorTheme: string, customColor?: string) {
  const isCustom = colorTheme === 'custom'
  const vars = isCustom && customColor ? customAccentVars(customColor) : null
  return {
    isDark,
    colorTheme,
    customVars: vars ?? undefined
  }
}

/** webview 模式插件渲染器：创建 <webview> 标签加载插件独立构建的 HTML */
function PluginWebview({
  entry,
  preload,
  active
}: {
  entry: string
  preload?: string | null
  active: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)

  const isDark = useIsDarkTheme()
  const colorTheme = useAppStore((s) => s.preferences.colorTheme)
  const customColor = useAppStore((s) => s.preferences.customColor)

  /** 向 webview 推送当前主题信息 */
  const pushTheme = useCallback(() => {
    const container = ref.current
    if (!container) return
    const wv = container.querySelector('webview') as (Electron.WebviewTag & { send: (ch: string, ...args: unknown[]) => void }) | null
    if (!wv) return
    // webview 被移除后 guestInstanceId 失效，send 会抛 Invalid guestInstanceId
    // 检查 isConnected 确保 DOM 仍然附着
    if (!wv.isConnected) return
    const data = collectThemeData(isDark, colorTheme, customColor)
    try {
      wv.send('plugin:theme', data)
    } catch {
      // webview 尚未准备好或已被销毁，忽略
    }
  }, [isDark, colorTheme, customColor])

  useEffect(() => {
    const container = ref.current
    if (!container) return

    // 清理旧 webview：在创建新 webview 之前先移除旧的。
    // Electron webview 的 guest 实例销毁是异步的，同步 remove + 立即创建新 webview
    // 会导致 "Invalid guestInstanceId"（旧 guest 还在清理，新 guest 就 attach）。
    // 用 try-catch 包裹 remove()，并跳到 microtask 再创建新 webview。
    const oldWv = container.querySelector('webview')
    if (oldWv) {
      try {
        oldWv.remove()
      } catch {
        // guest 已失效，DOM 节点仍残留，强制清空容器
        container.innerHTML = ''
      }
    }

    setLoading(true)

    let webview: (Electron.WebviewTag & { send: (ch: string, ...args: unknown[]) => void }) | null = null
    let cancelled = false

    // 延迟到 microtask 创建新 webview，给 Electron 时间清理旧 guest 实例
    const createWv = () => {
      if (cancelled || !container) return

      webview = document.createElement('webview') as Electron.WebviewTag & {
        send: (ch: string, ...args: unknown[]) => void
      }
      webview.src = entry
      webview.style.width = '100%'
      webview.style.height = '100%'
      webview.style.border = 'none'
      webview.setAttribute(
        'webpreferences',
        'contextIsolation=yes,nodeIntegration=no,spellcheck=no'
      )
      if (preload) {
        webview.setAttribute('preload', preload)
      }

      // webview 加载完成后隐藏 loading，并推送主题
      const onStopLoading = () => {
        if (!webview?.isConnected) return
        setLoading(false)
        pushTheme()
      }
      // 首次 DOM ready 时也推一次主题（did-stop-loading 可能晚于 DOM ready，
      // 提前推可让插件在首屏渲染时就拿到正确主题）
      const onDomReady = () => {
        if (!webview?.isConnected) return
        pushTheme()
      }
      webview.addEventListener('did-stop-loading', onStopLoading)
      webview.addEventListener('dom-ready', onDomReady)

      try {
        container.appendChild(webview)
      } catch {
        // attachGuestInstance 在极端竞态下仍可能抛错，忽略
      }
    }

    // 用 queueMicrotask 延迟一拍，让旧 guest 实例完成清理
    queueMicrotask(createWv)

    // 清理：取消待创建的 webview + 移除事件监听器 + 移除 webview 元素
    return () => {
      cancelled = true
      if (webview) {
        try {
          webview.remove()
        } catch {
          // 忽略
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, preload])

  // 主题变更时实时推送给 webview
  useEffect(() => {
    pushTheme()
  }, [pushTheme])

  return (
    <div
      ref={ref}
      className="relative h-full w-full"
      style={{ display: active ? 'block' : 'none' }}
    >
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
          <Spin size="large" />
        </div>
      )}
    </div>
  )
}

export default function App() {
  const layout = useAppStore((s) => s.layout)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const plugins = useAppStore((s) => s.plugins)
  const sidebarWidth = useAppStore((s) => s.ui.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  // 导航状态只有活动栏选中项一个真源，主区域显示什么由它派生
  const { activity, sidebarVisible } = useActiveActivity()
  const view = activity.view
  /** 当前功能区是插件视图时，它承载的插件视图 id */
  const pluginViewId = pluginViewIdOf(activity.id)

  /**
   * 已打开过的插件视图 id：保持挂载（非激活时用 hidden 隐藏），
   * 这样切到终端/其它页再切回来，插件内部 state（表单、编辑器内容等）不会丢。
   */
  const [mountedPluginViews, setMountedPluginViews] = useState<string[]>([])

  useEffect(() => {
    const alive = new Set(plugins.map((p) => p.viewId))
    setMountedPluginViews((prev) => {
      let changed = false
      const next = prev.filter((id) => {
        const ok = alive.has(id)
        if (!ok) changed = true
        return ok
      })
      if (view === 'plugin' && pluginViewId && alive.has(pluginViewId) && !next.includes(pluginViewId)) {
        next.push(pluginViewId)
        changed = true
      }
      return changed ? next : prev
    })
  }, [plugins, view, pluginViewId])

  return (
    <AntdProvider>
      {/* 单一 DndProvider：HostsPanel 与 PaneLayout 的拖拽共享同一 backend（react-dnd 禁止两个 HTML5 backend） */}
      <DndProvider backend={HTML5Backend}>
        {/* overflow-clip（而非 hidden）：clip 不构成滚动容器，Chrome 无法因焦点元素
            （如终端输入法组合期间被拉宽的 textarea）越界而对应用根节点做横向 scrollIntoView，
            杜绝「整个页面被推左」 */}
        <div className="flex h-screen w-screen flex-col overflow-clip bg-background text-foreground">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          {/* 活动栏常驻（不随侧边栏折叠消失），用于切换左侧功能区 */}
          <ActivityBar />
          {/* 侧边栏可折叠：外层容器宽度切换（内部保持固定宽度不回流，
              折叠时拖拽条隐藏，展开入口在标题栏） */}
          <div
            className="shrink-0 overflow-hidden"
            style={{ width: sidebarVisible ? sidebarWidth : 0 }}
          >
            <Sidebar />
          </div>
          {sidebarVisible && (
            <ResizeHandle
              width={sidebarWidth}
              min={180}
              max={480}
              onResize={setSidebarWidth}
            />
          )}

          <main className="relative flex min-w-0 flex-1 flex-col">
            {/* 终端区常驻挂载，切到脚本页时用 hidden 保活 xterm 实例 */}
            <div className={view === 'terminal' ? 'min-h-0 flex-1' : 'hidden'}>
              {layout ? <PaneLayout layout={layout} /> : <EmptyState />}
            </div>
            {view === 'scripts' && <ScriptsPage />}
            {view === 'notes' && <NotesPage />}
            {view === 'plugins' && <PluginsPage />}
            {/* 插件视图：已打开过的保持挂载，只有激活的那个可见（切去终端再切回不丢状态） */}
            {plugins
              .filter((p) => p.viewId === pluginViewId || mountedPluginViews.includes(p.viewId))
              .map((p) => (
                <div
                  key={p.viewId}
                  className={
                    view === 'plugin' && pluginViewId === p.viewId ? 'min-h-0 flex-1' : 'hidden'
                  }
                >
                  {p.renderType === 'webview' && p.webviewEntry ? (
                    <PluginWebview
                      entry={p.webviewEntry}
                      preload={p.webviewPreload}
                      active={view === 'plugin' && pluginViewId === p.viewId}
                    />
                  ) : (
                    <p.Component />
                  )}
                </div>
              ))}
          </main>
        </div>

        {/* 底部功能条（类 VS Code 状态栏），整宽；监控指标条常驻左侧 */}
        <StatusBar>{view === 'terminal' && <MonitorBadge sessionId={activeSessionId} />}</StatusBar>

        <SshProfileDialog />
        <SettingsDialog />
        <CommandPalette />
        <RunScriptDialog />
        </div>
      </DndProvider>
    </AntdProvider>
  )
}
