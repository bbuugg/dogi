import { useMemo, useState } from 'react'
import { AlertCircle, ExternalLink, Trash2, Upload } from 'lucide-react'
import { Button, Input, Modal, Switch, message } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from '@/lib/utils'
import type { PluginInfo } from '@shared/plugin'

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
  const installPlugin = useAppStore((s) => s.installPlugin)

  const [search, setSearch] = useState('')
  const [installing, setInstalling] = useState(false)
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

  const installFromFile = async () => {
    setInstalling(true)
    try {
      const res = await window.api.dialog.open({
        title: '选择插件目录或压缩包',
        properties: ['openFile', 'openDirectory'],
        filters: [{ name: '插件', extensions: ['zip', 'json'] }]
      })
      if (res.canceled || res.filePaths.length === 0) return
      const before = new Set(useAppStore.getState().pluginList.map((p) => p.id))
      await installPlugin(res.filePaths[0])
      const added = useAppStore.getState().pluginList.find((p) => !before.has(p.id))
      if (added) {
        // 安装后直接选中新插件，右侧详情立即可见
        selectPlugin(added.id)
        message.success(`插件「${added.name}」安装成功（${added.id}）`)
      } else {
        message.success('插件安装成功')
      }
    } catch (e) {
      message.error(`安装失败：${errText(e)}`)
    } finally {
      setInstalling(false)
    }
  }

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
      <div className="px-3 py-2">
        <Button
          type="primary"
          block
          icon={<Upload className="size-4" />}
          onClick={() => void installFromFile()}
          loading={installing}
        >
          安装插件
        </Button>
      </div>

      <div className="px-3 pb-2">
        <Input
          placeholder="搜索插件…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          size="small"
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
                    'group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5',
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
                    <div className="truncate text-[11px] text-muted-foreground/80">
                      {p.description || `v${p.version}`}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground/60">
                      v{p.version}
                      {!p.enabled && ' · 已禁用'}
                      {p.error && ' · 加载失败'}
                    </div>
                  </div>

                  {/*
                    右侧一列：上排是常驻的启停开关，下排（开关正下方）是「打开 / 卸载」。
                    下排用 invisible 占位而不是不渲染 —— 位置始终留着，悬浮显形时行高、列宽都不变。
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
                    <div className="invisible flex h-5 items-center gap-0.5 group-hover:visible">
                      <Button
                        type="text"
                        size="small"
                        icon={<ExternalLink className="size-3.5" />}
                        className="h-5 w-5 p-0"
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
                        className="h-5 w-5 p-0"
                        title="卸载插件"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPendingUninstall(p)
                        }}
                      />
                    </div>
                  </div>
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
