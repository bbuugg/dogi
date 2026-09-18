import { useState } from 'react'
import { useAppStore } from '@/stores/app-store'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Modal } from 'antd'
import { cn } from '@/lib/utils'
import { Boxes, ExternalLink, Package, RefreshCw, RotateCw, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { PluginInfo } from '@shared/plugin'

/** 统一把异常转成可提示的文本 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const PERMISSION_LABEL: Record<string, string> = {
  http: '网络请求',
  storage: '本地存储',
  fs: '文件读写'
}

export function PluginsPage() {
  const pluginList = useAppStore((s) => s.pluginList)
  const plugins = useAppStore((s) => s.plugins)
  const refreshPluginList = useAppStore((s) => s.refreshPluginList)
  const togglePluginEnabled = useAppStore((s) => s.togglePluginEnabled)
  const uninstallPlugin = useAppStore((s) => s.uninstallPlugin)
  const installPlugin = useAppStore((s) => s.installPlugin)
  const reloadPlugins = useAppStore((s) => s.reloadPlugins)
  const setView = useAppStore((s) => s.setView)
  const setPluginView = useAppStore((s) => s.setPluginView)

  const [installing, setInstalling] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [pendingUninstall, setPendingUninstall] = useState<PluginInfo | null>(null)

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
        toast.success(`插件「${added.name}」安装成功`, { description: added.id })
      } else {
        toast.success('插件安装成功')
      }
    } catch (e) {
      toast.error('安装失败', { description: errText(e) })
    } finally {
      setInstalling(false)
    }
  }

  const openPlugin = (info: PluginInfo) => {
    const view = plugins.find((p) => p.pluginId === info.id)
    if (!view) return
    setPluginView(view.viewId)
    setView('plugin')
  }

  const reloadOne = async (info: PluginInfo) => {
    try {
      await reloadPlugins(info.id)
      toast.success(`已重新加载「${info.name}」`)
    } catch (e) {
      toast.error('重新加载失败', { description: errText(e) })
    }
  }

  const reloadAll = async () => {
    setReloading(true)
    try {
      await reloadPlugins()
      toast.success('已重新加载全部插件')
    } catch (e) {
      toast.error('重新加载失败', { description: errText(e) })
    } finally {
      setReloading(false)
    }
  }

  const toggleEnabled = async (info: PluginInfo, enabled: boolean) => {
    try {
      await togglePluginEnabled(info.id, enabled)
      toast.success(enabled ? `已启用「${info.name}」` : `已禁用「${info.name}」`)
    } catch (e) {
      toast.error('操作失败', { description: errText(e) })
    }
  }

  const confirmUninstall = async () => {
    const target = pendingUninstall
    setPendingUninstall(null)
    if (!target) return
    try {
      await uninstallPlugin(target.id)
      toast.success(`已卸载「${target.name}」`)
    } catch (e) {
      toast.error('卸载失败', { description: errText(e) })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具条 */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold">插件管理</h2>
          <p className="text-[11px] text-muted-foreground">
            已安装 {pluginList.length} 个插件 · 启用 {pluginList.filter((p) => p.enabled).length} 个
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void refreshPluginList()} disabled={installing || reloading}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void reloadAll()} disabled={reloading}>
            <RotateCw className={reloading ? 'size-4 animate-spin' : 'size-4'} />
            {reloading ? '重载中…' : '重新加载'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void installFromFile()} disabled={installing}>
            <Upload className="size-4" />
            {installing ? '安装中…' : '从文件安装'}
          </Button>
        </div>
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {pluginList.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <Boxes className="size-12 opacity-30" />
            <div className="text-sm">还没有安装插件</div>
            <Button variant="secondary" size="sm" onClick={() => void installFromFile()} disabled={installing}>
              <Upload className="size-4" />
              从文件安装
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pluginList.map((info) => {
              const hasView = Boolean(info.renderer)
              const canOpen = hasView && info.enabled
              return (
                <div
                  key={info.id}
                  className={cn(
                    'flex flex-col gap-2 rounded-lg border border-border bg-card p-3',
                    !info.enabled && 'opacity-60'
                  )}
                >
                  {/* 顶部：图标 + 名称/版本/作者 + 启用开关 */}
                  <div className="flex items-start gap-2.5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary/60 text-lg">
                      {info.icon ?? <Package className="size-5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{info.name}</span>
                        <Badge variant="outline" className="text-[10px] font-normal">
                          v{info.version}
                        </Badge>
                        {!info.enabled && (
                          <Badge variant="secondary" className="text-[10px] font-normal">
                            已禁用
                          </Badge>
                        )}
                      </div>
                      {info.author && (
                        <div className="truncate text-[11px] text-muted-foreground">by {info.author}</div>
                      )}
                    </div>
                    <Switch
                      checked={info.enabled}
                      onCheckedChange={(v) => void toggleEnabled(info, v)}
                      aria-label="启用/禁用"
                    />
                  </div>

                  {info.description && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{info.description}</p>
                  )}
                  {info.error && (
                    <p className="text-[11px] text-destructive">加载失败：{info.error}</p>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">权限</span>
                    {(info.permissions ?? []).length === 0 ? (
                      <span className="text-[10px] text-muted-foreground">无</span>
                    ) : (
                      info.permissions!.map((perm) => (
                        <Badge key={perm} variant="secondary" className="text-[10px] font-normal">
                          {PERMISSION_LABEL[perm] ?? perm}
                        </Badge>
                      ))
                    )}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">id: {info.id}</div>

                  {/* 底部操作栏 */}
                  <div className="mt-auto flex items-center gap-1 border-t border-border pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => openPlugin(info)}
                      disabled={!canOpen}
                    >
                      <ExternalLink className="size-3.5" />
                      打开
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-7 text-muted-foreground"
                      title="重新加载该插件（改动后无需重启）"
                      onClick={() => void reloadOne(info)}
                    >
                      <RotateCw className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10"
                      onClick={() => setPendingUninstall(info)}
                    >
                      <Trash2 className="size-3.5" />
                      卸载
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

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
