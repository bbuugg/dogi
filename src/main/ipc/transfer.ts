import { dialog, ipcMain } from 'electron'
import { transferService } from '../services/transfer'
import type {
  TransferExportResult,
  TransferImportResult,
  TransferKind,
  TransferPickResult
} from '@shared/types'
import type { IpcContext } from './shared'

/**
 * 导入 / 导出 IPC：主机 / 笔记 / 接口请求 打成 zip 或从 zip 导回。
 *
 * 文件对话框（保存 / 打开）在这里触发 —— 服务层不碰 UI，也拿不到窗口；
 * 解析出的整包数据留在主进程（bundleId 句柄），渲染端只拿摘要，避免大段笔记正文来回传。
 */
export function registerTransferIpc(ctx: IpcContext): void {
  // 导出：选路径 → 打包写入
  ipcMain.handle(
    'transfer:export',
    async (_e, kinds: TransferKind[]): Promise<TransferExportResult> => {
      const window = ctx.win()
      if (!window || window.isDestroyed()) return { ok: false, error: '窗口不可用' }
      const stamp = new Date().toISOString().slice(0, 10)
      const result = await dialog.showSaveDialog(window, {
        title: '导出数据',
        defaultPath: `dogi-export-${stamp}.zip`,
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      try {
        const counts = await transferService.exportToFile(result.filePath, kinds)
        return { ok: true, path: result.filePath, counts }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  // 导入第一步：选 zip → 解析出「有哪些可导入项」
  ipcMain.handle('transfer:pick', async (): Promise<TransferPickResult> => {
    const window = ctx.win()
    if (!window || window.isDestroyed()) return { ok: false, error: '窗口不可用' }
    const result = await dialog.showOpenDialog(window, {
      title: '选择要导入的数据包',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    try {
      const { bundleId, entries } = await transferService.parseFile(result.filePaths[0])
      return { ok: true, bundleId, entries }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 导入第二步：把勾选的类型写回库
  ipcMain.handle(
    'transfer:import',
    (_e, bundleId: string, kinds: TransferKind[]): TransferImportResult => {
      try {
        const { added, updated } = transferService.apply(bundleId, kinds)
        return { ok: true, added, updated }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  /** 取消导入：丢掉暂存的解析结果 */
  ipcMain.handle('transfer:cancel', (_e, bundleId: string) => {
    transferService.drop(bundleId)
  })
}
