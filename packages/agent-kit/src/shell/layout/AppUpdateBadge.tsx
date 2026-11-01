/**
 * 状态栏右侧的更新指示条（desktop 打包版专属，对齐 dogi 的 StatusBar 更新徽章）。
 *
 * 只在**有事可做**时出现：有新版本待下载、正在下载、已下载待重启。其余档位（`idle` /
 * `checking` / `up-to-date`）整块不渲染 —— 状态栏是常驻条，没事时不该占位。
 *
 * ⚠️ **点击只是打开设置**，不直接下载。dogi 那颗徽章是「点了就下」，但这里的指示条
 * 属于状态栏（信息位），把「看一眼有新版本」和「开始下载」压成同一个点击会让人不敢点
 * ——而且下载是个会持续几十秒的后台动作，用户该在设置里看清版本号与进度再决定。
 * 想一步到位的入口在应用内提示（`AppUpdateNotifier` 的 toast 上有「下载」）。
 *
 * ⚠️ 设置里的「有更新时提醒我」关掉时**整块不渲染**（`useUpdateNotifyEnabled`）：
 * 那是用户明确说的「别在这儿提醒我」。下载不会因此停下，进度去设置里看。
 *
 * 进度与状态来自 `shared/lib/app-update.ts`（与设置页那一节共用同一份订阅）。
 */
import { Download, Loader2, RotateCw } from 'lucide-react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { STATUS_ITEM_CLASS } from '@fizz/agent-kit/shared/lib/status-bar'
import {
  useAppUpdateStatus,
  useUpdateNotifyEnabled
} from '@fizz/agent-kit/shared/lib/app-update'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function AppUpdateBadge({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useT()
  const status = useAppUpdateStatus()
  const notifyEnabled = useUpdateNotifyEnabled()
  const state = status?.state ?? 'idle'
  const percent = status?.percent ?? 0
  const latest = status?.latest

  // 非打包态（开发模式 / 当前平台装不了）：整块不渲染，免得给一个点不动的入口
  if (!status?.supported) return null
  // 用户关了「有更新时提醒我」：状态栏这条也不出现（设置页照旧）
  if (!notifyEnabled) return null

  if (state === 'downloading') {
    return (
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label={t("正在下载新版本")}
        title={t("正在下载新版本，点开看进度")}
        className={cn(STATUS_ITEM_CLASS, 'text-foreground')}
      >
        <Loader2 className="size-3 animate-spin" />
        <span className="tabular-nums">{t("下载中 {percent}%", { percent })}</span>
      </button>
    )
  }

  if (state === 'downloaded') {
    return (
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label={t("新版本已下载")}
        title={t("新版本已下载，重启后生效")}
        className={cn(STATUS_ITEM_CLASS, 'text-foreground')}
      >
        <RotateCw className="size-3" />
        {t("重启更新")}
      </button>
    )
  }

  if (state === 'available') {
    return (
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label={t("发现新版本")}
        title={t("发现新版本{v}，不会自动下载，点开查看", { v: latest ? ` v${latest}` : "" })}
        className={cn(STATUS_ITEM_CLASS, 'text-foreground')}
      >
        <Download className="size-3" />
        {t("有新版本")}
      </button>
    )
  }

  return null
}
