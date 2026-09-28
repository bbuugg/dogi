import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { normalizeRdpPort, rdpBridge } from '../services/rdp/bridge'
import { storage } from '../services/storage'
import type { RdpBridgeInfo, RdpCredentials } from '@shared/types'

/**
 * ironrdp-wasm 的 wasm 产物随渲染端静态资源发布（scripts/copy-rdp.cjs 拷贝到 public/rdp/，
 * 构建后位于 out/renderer/rdp/）。打包后渲染端跑在 file:// 下，浏览器 fetch 不支持
 * file: 协议，因此由主进程读字节给渲染端（开发态走 Vite 静态服务，不需要这条 IPC）。
 */
const RDP_WASM_PATH = join(import.meta.dirname, '../renderer/rdp/rdp_client_bg.wasm')

/**
 * RDP IPC：远程桌面（嵌入式 WASM 客户端）。远程桌面是独立的主机类型（kind = 'rdp'），
 * host / port / 用户名 / 密码 / 域都是主机配置的一部分。
 *
 * 渲染端生成 connId（一个「远程桌面」标签一个连接）并打开桥；桥只为该主机配置
 * 建立本地 WebSocket 入口（随机 token 路径），WASM 客户端经它连真实 RDP 服务器。
 * 凭据连接时通过 rdp:credentials 从主机配置解密下发（WASM 客户端要在渲染进程
 * 完成 NLA / CredSSP 票据计算，只能这样流转；不随主机列表下发）。
 */
export function registerRdpIpc(): void {
  // 主机地址与 RDP 端口都取自 kind = 'rdp' 的主机配置
  ipcMain.handle(
    'rdp:open',
    (_e, connId: string, profileId: string): Promise<RdpBridgeInfo> =>
      rdpBridge.open(connId, profileId)
  )
  ipcMain.handle('rdp:close', (_e, connId: string) => rdpBridge.close(connId))

  /** 读取 RDP 连接凭据（kind = 'rdp' 的主机配置，密码已在存储层解密） */
  ipcMain.handle('rdp:credentials', (_e, profileId: string): RdpCredentials => {
    const profile = storage.getSshProfile(profileId)
    if (!profile || profile.kind !== 'rdp') throw new Error('主机配置不存在或不是远程桌面类型')
    return {
      username: profile.username,
      password: profile.password ?? '',
      domain: profile.domain ?? '',
      // 与桥的固定目标保持同一口径（非法端口兜底 3389）
      port: normalizeRdpPort(profile.port)
    }
  })

  /** 读取 WASM 字节（打包后 file:// 下 fetch 不可用，渲染端改用这条通道加载模块） */
  ipcMain.handle('rdp:wasm', () => readFile(RDP_WASM_PATH))

  // 退出前关掉所有本地桥，避免进程退出时残留监听端口
  app.on('before-quit', () => rdpBridge.closeAll())
}
