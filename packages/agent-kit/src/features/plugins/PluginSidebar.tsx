"use client";

/**
 * 插件的**侧栏**（活动栏右边那一列的内容）。
 *
 * 它是所有插件共用的一份（不是每个插件一份）：当前活动的是哪个插件，由活动栏 id
 * `plugin:<插件id>` 解出来，再按它声明的 `opens` 找到要显示的面 ——
 * 这样加一个插件**不需要**再往 `activities.tsx` 里塞一项（那张表只放内置功能区）。
 *
 * props 故意声明得比 `ActivityPanelProps` **窄**（`{ app, width, mobileOpen, onMobileOpenChange }`）：
 * 函数参数逆变，窄签名照样能挂到 `Activity.sidebar` 上（见 `app/activities.tsx` 的说明）。
 */
import { ActivitySidebar } from '@fizz/agent-kit/shared/components/activity-sidebar'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { pluginIdOfActivityId } from '@fizz/agent-kit/shared/lib/activity-ids'
import { useActiveActivityId } from '@fizz/agent-kit/shared/lib/activity-state'
import { openPluginTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'
import type { PluginSurfaceView } from '@fizz/contracts/agent-api'
import { usePluginSurfaces } from '@fizz/agent-kit/shared/lib/plugin-surfaces'
import { PluginSurfaceBody } from '@fizz/agent-kit/features/plugins/PluginSurfaceBody'

/**
 * 这颗图标「点开谁」。
 *
 * 插件声明 `opens: 'sider:<id>'` / `'view:<id>'`；不给就找**同 id 的 sider** ——
 * 最常见的写法是「图标栏项与侧栏面同名」，省掉一个字段。
 */
function openedTarget(
  entry: PluginSurfaceView | undefined,
  surfaces: PluginSurfaceView[]
): PluginSurfaceView | undefined {
  if (!entry) return undefined
  const opens = entry.opens
  const kind = opens?.startsWith('view:') ? 'view' : 'sider'
  const id = opens ? opens.slice(`${kind}:`.length) : entry.id
  return surfaces.find((s) => s.pluginId === entry.pluginId && s.kind === kind && s.id === id)
}

export function PluginSidebar({
  app,
  width,
  mobileOpen,
  onMobileOpenChange
}: {
  app: AgentApp
  width: number
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const activeId = useActiveActivityId()
  const pluginId = pluginIdOfActivityId(activeId) ?? ''
  const surfaces = usePluginSurfaces(app, app.activeWorkspaceId ?? undefined)

  const entry = surfaces.find((s) => s.kind === 'activityBar' && s.pluginId === pluginId)
  const target = openedTarget(entry, surfaces)
  /** 这个插件有没有「主视图区」的那一面（有就给一个打开按钮） */
  const viewSurface = surfaces.find((s) => s.kind === 'view' && s.pluginId === pluginId)
  const pluginName = entry?.pluginName ?? t('插件')
  /** 这一面声明了顶栏图标按钮（刷新 / 新增…）→ 顶栏交给 SidebarTopBar，标题只留插件名 */
  const hasTopbar = (target?.headerActions?.length ?? 0) > 0

  const openInView = (): void => {
    if (!viewSurface) return
    // 面板只在对话视图渲染：不在那儿就先切过去（与接口请求面板同款）
    openPluginTab({
      pluginId: viewSurface.pluginId,
      surfaceId: viewSurface.id,
      label: viewSurface.title,
      title: `${viewSurface.pluginName} · ${viewSurface.title}`
    })
  }

  return (
    /*
      ⚠️ 这里**不用** `SidebarScaffold`（主机 / 接口请求 / AI Agent 用的那个骨架）：
      骨架管的是「顶部栏 + `StackedSections` 分区容器」那套固定结构，而插件侧的正文是
      **插件自己声明的一面**（`PluginSurfaceBody`，还可以自带顶栏），既不是分区、也不一定有。
      硬套就得给骨架开一个「跳过分区容器」的开关，那不如让这一处继续直接挂在
      `ActivitySidebar`（外壳那一层是三处共享的）。
    */
    <ActivitySidebar width={width} mobileOpen={mobileOpen} onMobileOpenChange={onMobileOpenChange}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/*
          顶栏：插件**声明了 `headerActions`** 时交给 `PluginSurfaceBody` 去渲染
          `SidebarTopBar`（左边插件名、右边刷新 / 新增那颗 +）—— 那种情况下这里**不再画**
          自己那两行（插件名 + 面标题）：同一块地方摆两套标题是重复的，而面标题
          （如「Redis 连接」）本来就只是插件名下面的一行小字。

          插件面是 `SidebarTopBar` 现在**唯一**的使用者（内置功能区侧栏的顶栏已全部删除，
          见那个组件的文件头），所以这条视觉契约只在「插件 ↔ 宿主」之间还成立。

          没声明 `headerActions` 的插件保持原样（两行标题），行为不变。
        */}
        {hasTopbar ? null : (
          <div className="shrink-0 px-3 py-2">
            <div className="truncate text-xs font-medium" title={`${pluginName} · ${target?.title ?? ''}`}>
              {pluginName}
            </div>
            <div className="truncate text-[0.625rem] text-muted-foreground">
              {target?.title ?? t('没有可显示的内容')}
            </div>
          </div>
        )}

        {target?.kind === 'sider' ? (
          /* 侧栏里不再放「在主视图打开」那颗按钮：插件要开标签页，自己通过动作结果的
             `openView` 请求（例：侧栏里点一条连接 → 开出它的管理页）。宿主不替它猜。 */
          <PluginSurfaceBody
            app={app}
            pluginId={target.pluginId}
            kind="sider"
            id={target.id}
            {...(hasTopbar
              ? { topbar: { label: pluginName, actions: target.headerActions ?? [] } }
              : {})}
          />
        ) : viewSurface ? (
          /* 声明的是「标签页」而不是侧栏：侧栏里就只给一个入口，不把标签页内容塞进来 */
          <div className="space-y-2 px-3 py-4">
            <p className="text-xs text-muted-foreground">
              {t('这个插件的界面是一个「标签页」（不是侧栏内容）。')}
            </p>
            <button
              type="button"
              onClick={openInView}
              className="rounded-md border border-border/60 px-2 py-1 text-[0.6875rem] transition-colors hover:bg-secondary"
            >
              {t('在主视图打开「{title}」', { title: viewSurface.title })}
            </button>
          </div>
        ) : (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('这个插件没有声明可显示的内容（它只注册了图标栏那一颗）。')}
          </p>
        )}
      </div>
    </ActivitySidebar>
  )
}
