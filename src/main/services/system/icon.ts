/**
 * 应用图标路径解析（窗口 / 托盘 / 系统通知共用）。
 *
 * 打包后由 electron-builder 的 extraResources 把 app-icon.png 放到安装目录的
 * resources/ 下；开发时取项目 resources 目录。兼容 extraResources 的旧写法
 * （多嵌套一层 resources/）作为兜底，并始终返回第一个存在的路径 ——
 * 图标缺失会让 `new Tray()` 直接抛错、通知也没有图标。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export function resolveIconPath(): string {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'app-icon.png'),
        join(process.resourcesPath, 'resources', 'app-icon.png')
      ]
    : [join(app.getAppPath(), 'resources', 'app-icon.png')]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}
