import { editorSaveKey, useAppStore } from '@/stores/app-store'
import { TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { ActivityBar } from '@/components/ActivityBar'
import { useActiveActivity } from '@/activities'
import { MonitorBadge } from '@/components/MonitorBadge'
import { EditorSaveStatus } from '@/components/EditorSaveStatus'
import { AiStatusButton } from '@/components/AiStatusButton'
import { SshProfileDialog } from '@/components/SshProfileDialog'
import { SettingsDialog } from '@/components/SettingsDialog'
import { CommandPalette } from '@/components/CommandPalette'
import { RunScriptDialog } from '@/components/RunScriptDialog'
import { PanelView } from '@/components/PanelView'
import { TabCloseConfirm } from '@/components/TabCloseConfirm'
import { StatusBar } from '@/components/StatusBar'
import { ResizeHandle } from '@/components/ResizeHandle'
import { AntdProvider } from '@/components/AntdProvider'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'

export default function App() {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const sidebarWidth = useAppStore((s) => s.ui.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  /** 当前激活标签是否为终端：决定状态栏是否显示该会话的监控指标 */
  const isTerminalActive = useAppStore((s) => {
    const gid = s.activeGroupId
    const activeTabId = gid ? s.groups[gid]?.activeTabId : null
    const tab = activeTabId ? s.ui.panelTabs.find((t) => t.id === activeTabId) : undefined
    return tab?.type === 'terminal'
  })
  /**
   * 当前激活标签若是可编辑页（脚本 / 笔记 / 接口请求），返回其保存状态的键：
   * 决定状态栏是否显示该页的保存状态。
   *
   * 这里必须返回**字符串**而不是对象：zustand 用 Object.is 比较快照，
   * 每次返回新对象会被判定为「一直在变」而无限重渲染。
   */
  const activeEditorKey = useAppStore((s) => {
    const gid = s.activeGroupId
    const activeTabId = gid ? s.groups[gid]?.activeTabId : null
    const tab = activeTabId ? s.ui.panelTabs.find((t) => t.id === activeTabId) : undefined
    if (tab?.type === 'script' && tab.scriptId) return editorSaveKey('script', tab.scriptId)
    if (tab?.type === 'note' && tab.noteId) return editorSaveKey('note', tab.noteId)
    // WebSocket 与 HTTP 请求共用一张表，但状态栏提示语不同，所以键前缀分开（见 editorSaveKey）
    if (tab?.type === 'api' && tab.apiRequestId)
      return editorSaveKey(tab.apiProtocol === 'ws' ? 'ws' : 'api', tab.apiRequestId)
    return null
  })
  const { sidebarVisible } = useActiveActivity()

  return (
    <AntdProvider>
      {/* 单一 DndProvider：HostsPanel 与 PanelView 的拖拽共享同一 backend（react-dnd 禁止两个 HTML5 backend） */}
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
            <PanelView />
          </main>
        </div>

        {/*
          底部功能条（类 VS Code 状态栏），整宽。
          左侧：监控指标条仅在终端标签激活时显示；
          右侧：编辑页（脚本 / 笔记 / 接口请求）保存状态 + AI 助手开关（纯图标）。
          AiStatusButton 自己判断「当前激活标签是终端」才渲染，操作的是该终端页面自己的开关状态；
          保存状态同理只在激活标签是脚本 / 笔记时出现 —— 两者互斥，不会同时占位。
        */}
        <StatusBar
          right={
            <>
              {activeEditorKey && <EditorSaveStatus statusKey={activeEditorKey} />}
              <AiStatusButton />
            </>
          }
        >
          {isTerminalActive && <MonitorBadge sessionId={activeSessionId} />}
        </StatusBar>

        <SshProfileDialog />
        <SettingsDialog />
        <CommandPalette />
        <RunScriptDialog />
        <TabCloseConfirm />
        </div>
      </DndProvider>
    </AntdProvider>
  )
}
