import { cn } from '@/shared/lib/utils'
import { useAppStore } from '@/stores/app-store'
import type { PluginInfo } from '@shared/plugin'
import { Button, Input, Modal, Switch, message } from 'antd'
import { AlertCircle, ExternalLink, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { SidebarRowActions } from '@/shared/components/SidebarRowActions'

/** 统一把异常转成可提示的文本 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 插件侧边栏：列出全部插件（启用在前），支持搜索 / 安装 / 选中 / 启用禁用 / 打开 / 卸载。
 * 选中状态存在 store 的 ui.activePluginId，右侧 PluginsPage 据此展示插件详情。
 *
 * 行内操作分两类，位置都常驻、不改变行高（鼠标扫过列表时整列不跳）：
 * - 右侧上排：启停开关，常驻可见，任何时刻都能直接切换；
 * - 右侧下排（开关正下方）：「打开 / 卸载」纯图标按钮，`invisible` 占位、悬浮才显形。
 * 不用「悬浮时插入新的一行」：那会把 item 撑高。
 * 插件界面的入口也在命令面板（「打开插件」→ 选插件）。
 */
export function PluginsPanel() {
  const pluginList = useAppStore((s) => s.pluginList)
  const activePluginId = useAppStore((s) => s.ui.activePluginId)
  const plugins = useAppStore((s) => s.plugins)
  const selectPlugin = useAppStore((s) => s.selectPlugin)
  const openPluginsTab = useAppStore((s) => s.openPluginsTab)
  const openPluginTab = useAppStore((s) => s.openPluginTab)
  const togglePluginEnabled = useAppStore((s) => s.togglePluginEnabled)
  const uninstallPlugin = useAppStore((s) => s.uninstallPlugin)
  const [search, setSearch] = useState('')
  const [pendingUninstall, setPendingUninstall] = useState<PluginInfo | null>(null)

  /** 启用在前、其余按名称排序，并按搜索过滤 */
  const filtered = useMemo(() => {
    const sorted = [...pluginList].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      return a.name.localeCompare(b.name, 'zh')
    })
    const q = search.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        (p.author ?? '').toLowerCase().includes(q)
    )
  }, [pluginList, search])



  const openPlugin = (info: PluginInfo) => {
    const view = plugins.find((p) => p.pluginId === info.id)
    if (!view) return
    openPluginTab(view.viewId)
  }

  const toggleEnabled = async (info: PluginInfo, enabled: boolean) => {
    try {
      await togglePluginEnabled(info.id, enabled)
      message.success(enabled ? `已启用「${info.name}」` : `已禁用「${info.name}」`)
    } catch (e) {
      message.error(`操作失败：${errText(e)}`)
    }
  }

  const confirmUninstall = async () => {
    const target = pendingUninstall
    setPendingUninstall(null)
    if (!target) return
    try {
      await uninstallPlugin(target.id)
      message.success(`已卸载「${target.name}」`)
    } catch (e) {
      message.error(`卸载失败：${errText(e)}`)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-3">
        <Input
          size='small'
          placeholder="搜索插件…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {pluginList.length === 0 ? (
              <>
                还没有安装插件。
                <br />
                点击上方「安装插件」从文件或目录安装。
              </>
            ) : (
              <>没有匹配「{search}」的插件。</>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((p) => {
              const active = p.id === activePluginId
              const view = plugins.find((v) => v.pluginId === p.id)
              return (
                <div
                  key={p.id}
                  onClick={() => {
                    selectPlugin(p.id)
                    openPluginsTab()
                  }}
                  className={cn(
                    // relative：右下角「打开 / 卸载」浮层要定位在本行内
                    'group relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5',
                    active
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                    !p.enabled && 'opacity-60'
                  )}
                >
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-[13px] leading-none">
                    {p.icon ?? '🔌'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="truncate text-[13px] font-medium">{p.name}</span>
                      {p.error && <AlertCircle className="size-3 shrink-0 text-destructive" />}
                    </div>
                    <div className="truncate text-xs text-muted-foreground/80">
                      {p.description || `v${p.version}`}
                    </div>
                    <div className="truncate text-xs text-muted-foreground/60">
                      v{p.version}
                      {!p.enabled && ' · 已禁用'}
                      {p.error && ' · 加载失败'}
                    </div>
                  </div>

                  {/*
                    右侧一列：常驻的启停开关。「打开 / 卸载」原来排在开关正下方，
                    现在改成绝对定位浮层（见下）—— 它留在列里会把右列撑得比开关宽，
                    而这一列全程吃名字的宽度。
                  */}
                  <div className="mt-0.5 flex shrink-0 flex-col items-end gap-0.5">
                    <span className="flex h-5 items-center">
                      <Switch
                        size="small"
                        checked={p.enabled}
                        onClick={(_, e) => e.stopPropagation()}
                        onChange={(v) => void toggleEnabled(p, v)}
                        aria-label="启用/禁用"
                      />
                    </span>
                  </div>

                  {/*
                    「打开 / 卸载」绝对定位在右下角、hover 整行才浮现。
                    右列宽度原本取「开关 / 按钮排」的较大者：两个 20px 按钮把列撑到 44px，
                    比开关宽出 16px，名字全程被这 16px 提前截断。
                    改成浮层后右列只剩开关宽度，名字平时吃满、hover 时才让位。
                    这一行有三行文字，浮层只盖住最下面一行的右端（版本 / 已禁用那行）。
                  */}
                  <SidebarRowActions
                    align="bottom"
                    hoverClass="group-hover:pointer-events-auto group-hover:opacity-100"
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<ExternalLink className="size-3.5" />}
                      className="h-5 w-5 p-0 opacity-0 transition-opacity group-hover:opacity-100"
                      title="打开插件界面"
                      disabled={!p.enabled || !view}
                      onClick={(e) => {
                        e.stopPropagation()
                        openPlugin(p)
                      }}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<Trash2 className="size-3.5 text-destructive" />}
                      className="h-5 w-5 p-0 opacity-0 transition-opacity group-hover:opacity-100"
                      title="卸载插件"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingUninstall(p)
                      }}
                    />
                  </SidebarRowActions>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 卸载确认 */}
      <Modal
        open={pendingUninstall !== null}
        onCancel={() => setPendingUninstall(null)}
        title={`卸载插件「${pendingUninstall?.name}」？`}
        okText="卸载"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmUninstall()}
        centered
        width={440}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          该操作会删除插件在本地用户数据中的全部文件（{pendingUninstall?.id}），且不可恢复。
        </p>
      </Modal>
    </div>
  )
}
