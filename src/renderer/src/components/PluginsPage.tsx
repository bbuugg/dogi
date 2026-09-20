import { pluginActivityId } from '@/activity-ids'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
import type { PluginInfo } from '@shared/plugin'
import { Button, Modal, Switch, Tag, message } from 'antd'
import {
  AlertCircle,
  Boxes,
  ExternalLink,
  Package,
  RefreshCw,
  RotateCw,
  Trash2,
  Upload
} from 'lucide-react'
import { useState } from 'react'

/** 统一把异常转成可提示的文本 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const PERMISSION_LABEL: Record<string, string> = {
  http: '网络请求',
  storage: '本地存储',
  fs: '文件读写'
}

/** 渲染端入口的可读描述 */
function rendererLabel(info: PluginInfo): string {
  if (!info.renderer) return '无界面（仅主进程逻辑）'
  return typeof info.renderer === 'string' ? '内置视图（源码加载）' : '独立页面（webview）'
}

/** 详情里的一行「标签 : 值」 */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all text-foreground/90">{children}</span>
    </div>
  )
}

/**
 * 插件详情页（主区域）：展示左侧 PluginsPanel 选中的插件。
 * 选中插件存 store 的 ui.activePluginId；未选中时提示从左侧选择。
 */
export function PluginsPage() {
  const pluginList = useAppStore((s) => s.pluginList)
  const plugins = useAppStore((s) => s.plugins)
  const activePluginId = useAppStore((s) => s.ui.activePluginId)
  const refreshPluginList = useAppStore((s) => s.refreshPluginList)
  const togglePluginEnabled = useAppStore((s) => s.togglePluginEnabled)
  const uninstallPlugin = useAppStore((s) => s.uninstallPlugin)
  const installPlugin = useAppStore((s) => s.installPlugin)
  const reloadPlugins = useAppStore((s) => s.reloadPlugins)
  const selectActivity = useAppStore((s) => s.selectActivity)

  const [installing, setInstalling] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [reloadingOne, setReloadingOne] = useState(false)
  const [pendingUninstall, setPendingUninstall] = useState<PluginInfo | null>(null)

  const info = pluginList.find((p) => p.id === activePluginId) ?? null
  const view = info ? plugins.find((p) => p.pluginId === info.id) : undefined
  const canOpen = Boolean(info?.enabled && view)

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
        useAppStore.getState().selectPlugin(added.id)
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

  const openPlugin = () => {
    if (!info || !view) return
    selectActivity(pluginActivityId(view.viewId))
  }

  const reloadOne = async () => {
    if (!info) return
    setReloadingOne(true)
    try {
      await reloadPlugins(info.id)
      message.success(`已重新加载「${info.name}」`)
    } catch (e) {
      message.error(`重新加载失败：${errText(e)}`)
    } finally {
      setReloadingOne(false)
    }
  }

  const reloadAll = async () => {
    setReloading(true)
    try {
      await reloadPlugins()
      message.success('已重新加载全部插件')
    } catch (e) {
      message.error(`重新加载失败：${errText(e)}`)
    } finally {
      setReloading(false)
    }
  }

  const toggleEnabled = async (enabled: boolean) => {
    if (!info) return
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

  const busy = installing || reloading

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具条 */}
      <div className="flex items-center justify-between px-5 py-3">
        <div>
          <h1 className="text-base font-semibold">插件管理</h1>
          <p className="text-[11px] text-muted-foreground">
            已安装 {pluginList.length} 个插件 · 启用 {pluginList.filter((p) => p.enabled).length} 个
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            icon={<RotateCw className={busy ? 'size-4 animate-spin' : 'size-4'} />}
            loading={busy}
            type="text"
            onClick={() => void reloadAll()}
            disabled={busy}
          >
            重新加载
          </Button>
          <Button
            loading={busy}
            icon={<RefreshCw className="size-4" />}
            type="text"
            onClick={() => void refreshPluginList()}
            disabled={busy}
          >
            刷新
          </Button>
          <Button
            loading={installing}
            icon={<Upload className="size-4" />}
            variant="filled"
            onClick={() => void installFromFile()}
            disabled={installing}
          >
            从文件安装
          </Button>
        </div>
      </div>

      {/* 详情区 */}
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-6">
        {!info ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <Boxes className="size-12 opacity-30" />
            {pluginList.length === 0 ? (
              <>
                <div className="text-sm">还没有安装插件</div>
                <Button
                  variant="filled"
                  size="small"
                  onClick={() => void installFromFile()}
                  disabled={installing}
                >
                  <Upload className="size-4" />
                  从文件安装
                </Button>
              </>
            ) : (
              <>
                <div className="text-sm">从左侧选择一个插件查看详情</div>
                <div className="text-xs text-muted-foreground/70">
                  在列表中可快速启用 / 禁用、打开插件界面
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
            {/* 概览卡片 */}
            <div
              className={cn(
                'flex flex-col gap-3 rounded-lg border border-border/60 bg-card p-4',
                !info.enabled && 'opacity-70'
              )}
            >
              <div className="flex items-start gap-3">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-secondary/60 text-2xl">
                  {info.icon ?? <Package className="size-6" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[15px] font-semibold">{info.name}</span>
                    <Tag className="m-0 text-[10px] font-normal" variant="outlined">
                      v{info.version}
                    </Tag>
                    <Tag
                      className="m-0 border-0 text-[10px] font-normal"
                      color={info.enabled ? 'success' : 'default'}
                    >
                      {info.enabled ? '已启用' : '已禁用'}
                    </Tag>
                    {info.error && (
                      <Tag className="m-0 border-0 text-[10px] font-normal" color="error">
                        加载失败
                      </Tag>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {info.author ? `by ${info.author}` : '未署名'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {info.enabled ? '已启用' : '已禁用'}
                  </span>
                  <Switch checked={info.enabled} onChange={(v) => void toggleEnabled(v)} />
                </div>
              </div>

              {info.description && (
                <p className="text-xs leading-relaxed text-muted-foreground">{info.description}</p>
              )}

              {info.error && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1 text-[11px] break-all text-destructive">
                    加载失败：{info.error}
                  </div>
                </div>
              )}

              {/* 操作栏 */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="primary"
                  icon={<ExternalLink className="size-4" />}
                  onClick={openPlugin}
                  disabled={!canOpen}
                  title={canOpen ? '打开插件界面' : '插件无界面或已被禁用'}
                >
                  打开插件界面
                </Button>
                <Button
                  icon={<RotateCw className="size-4" />}
                  loading={reloadingOne}
                  onClick={() => void reloadOne()}
                  title="重新加载该插件（改动后无需重启）"
                >
                  重新加载
                </Button>
                <Button
                  icon={<Trash2 className="size-4" />}
                  danger
                  className="ml-auto"
                  onClick={() => setPendingUninstall(info)}
                >
                  卸载
                </Button>
              </div>
            </div>

            {/* 详细信息 */}
            <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card p-4">
              <h2 className="text-xs font-semibold text-foreground/90">详细信息</h2>
              <DetailRow label="标识">{info.id}</DetailRow>
              <DetailRow label="版本">v{info.version}</DetailRow>
              <DetailRow label="作者">{info.author ?? '未署名'}</DetailRow>
              <DetailRow label="渲染方式">{rendererLabel(info)}</DetailRow>
              <DetailRow label="主进程入口">{info.main ?? '无'}</DetailRow>
              <DetailRow label="权限">
                {(info.permissions ?? []).length === 0 ? (
                  '无'
                ) : (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {info.permissions!.map((perm) => (
                      <Tag
                        key={perm}
                        className="m-0 border-0 text-[10px] font-normal"
                        color="default"
                      >
                        {PERMISSION_LABEL[perm] ?? perm}
                      </Tag>
                    ))}
                  </span>
                )}
              </DetailRow>
              <DetailRow label="界面状态">
                {!info.renderer
                  ? '该插件不提供界面'
                  : !info.enabled
                    ? '已禁用，侧边栏不显示入口'
                    : view
                      ? '已加载，侧边栏可见入口'
                      : '界面未加载'}
              </DetailRow>
            </div>
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
