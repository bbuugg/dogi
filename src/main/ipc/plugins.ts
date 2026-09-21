import { ipcMain } from 'electron'
import { pluginHost } from '../services/plugins/host'

/**
 * 插件 IPC：清单、启用 / 卸载 / 安装 / 重载，以及插件沙箱的各项能力桥。
 *
 * `plugin:*` 是插件运行时的宿主侧能力（渲染代码、调用、HTTP、键值存储），
 * 宿主把它注入给插件，插件自己不碰 Electron API。
 */
export function registerPluginsIpc(): void {
  ipcMain.handle('plugins:list', () => pluginHost.listManifests())
  // 启用/禁用（持久化）、卸载、从文件安装：均返回最新插件列表供渲染端刷新
  ipcMain.handle('plugins:setEnabled', (_e, id: string, enabled: boolean) =>
    pluginHost.setEnabled(id, enabled)
  )
  ipcMain.handle('plugins:uninstall', (_e, id: string) => pluginHost.uninstall(id))
  ipcMain.handle('plugins:install', (_e, sourcePath: string) => pluginHost.install(sourcePath))
  // 重新加载插件（不传 id 表示全部），返回最新插件列表
  ipcMain.handle('plugins:reload', (_e, id?: string) => pluginHost.reload(id))

  ipcMain.handle('plugin:rendererCode', (_e, id: string) => pluginHost.getRendererCode(id))
  ipcMain.handle('plugin:invoke', (_e, pluginId: string, name: string, args: unknown[]) =>
    pluginHost.invoke(pluginId, name, args ?? [])
  )
  ipcMain.handle('plugin:http', (_e, pluginId: string, req) => pluginHost.http(pluginId, req))
  ipcMain.handle('plugin:storageGet', (_e, pluginId: string, key: string) =>
    pluginHost.storageGet(pluginId, key)
  )
  ipcMain.handle('plugin:storageSet', (_e, pluginId: string, key: string, value) => {
    pluginHost.storageSet(pluginId, key, value)
  })
}
