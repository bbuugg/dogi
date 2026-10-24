/**
 * 桌面 / web 的设置面板：**左侧分组菜单常驻 + 右侧内容区**，两栏同时在场。
 *
 * 只服务宽屏。手机那套「菜单 / 详情两级」是另一个组件（`MobileSettingsPanel`）：
 * 两边不共用导航结构，也不靠 `useIsMobile()` 在一份代码里分叉 —— 这里每个类名、
 * 每个交互都只为两栏服务，改桌面不会牵动手机，反之同理。
 *
 * 内容本身仍是共享的 `SettingsContent`（只有一个 tab 的选中值要管）。
 */
import { useState } from 'react'
import { useLanguage } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import type {
  SettingsCommonProps,
  SettingsTabId
} from '@fizz/agent-kit/features/settings/types'
import { buildSettingsGroups } from '@fizz/agent-kit/features/settings/sections'
import { SettingsContent } from '@fizz/agent-kit/features/settings/SettingsContent'

export function DesktopSettingsPanel({
  className,
  initialTab,
  ...common
}: SettingsCommonProps & {
  /** 宽高由调用方给：弹窗限高 60dvh（`SettingsDialog`）、独立窗口铺满（`SettingsWindow`） */
  className?: string
  /** 打开时落在哪个分组（模型选择下拉的设置入口用）；只在挂载时生效一次 */
  initialTab?: SettingsTabId
}) {
  useLanguage()
  // 弹窗关闭时 Radix 会卸载内容，下次打开重新挂载 —— initialTab 只在挂载时生效一次。
  const [tab, setTab] = useState<string>(initialTab ?? 'general')
  const groups = buildSettingsGroups(common.app)

  return (
    <div className={cn('flex min-h-0 flex-1 gap-2 px-2 pb-2', className)}>
      <nav className="w-44 shrink-0 overflow-auto no-scrollbar py-2 pr-1 space-y-4">
        {groups.map((group) => (
          <div key={group.title}>
            <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
              {group.title}
            </div>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  'mb-0.5 flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  tab === item.id
                    ? 'bg-primary-subtle text-foreground'
                    : 'text-muted-foreground hover:bg-primary-soft hover:text-foreground'
                )}
              >
                {/* 图标用 currentColor 描边，选中 / 悬停的颜色变化自动跟随按钮文字色 */}
                <item.icon className="size-4 shrink-0 mr-1.5" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col rounded-lg bg-background p-4">
        {/*
          `key={tab}`：**每个分组用自己那份滚动容器**（容器共用的话，在「通用」滚到底
          再切到「模型」，新分组会停在底部而不是顶部）。孩子本来就会随 tab 重挂。
        */}
        <div key={tab} className="min-h-0 flex-1 overflow-auto no-scrollbar py-2">
          <SettingsContent tab={tab} {...common} />
        </div>
      </div>
    </div>
  )
}
