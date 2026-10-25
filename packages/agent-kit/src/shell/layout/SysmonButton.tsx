/**
 * 状态栏的「系统监控」入口（文件管理那颗的左边）。
 *
 * 为什么放状态栏：它看的是**服务端那台机器**（CPU / 内存 / 磁盘 / 每个进程），与当前
 * 项目 / 会话 / SSH 主机都无关 —— 和「文件管理」「应用日志」一样是**全局、低频、哪儿
 * 都能点到**的入口带（见 `StatusBar.tsx` 文件头）。点开就在主区域开一条 `sysmon:list`
 * 标签，可以和对话、终端并排分屏。
 *
 * ⚠️ 状态栏**右端**还有一颗监控徽标（`SystemMonitorBadge`），两者不是一个东西：
 * 那颗是「扫一眼 CPU / 内存」，走常驻采样器；这颗是「进去看每个进程、杀进程」。
 * 放在一左一右也是刻意的 —— 挨在一起会让人以为它们是同一个入口的两种形态。
 */
import { Gauge } from 'lucide-react'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { openSysmonTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { STATUS_ITEM_CLASS } from '@fizz/agent-kit/shared/lib/status-bar'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function SysmonButton() {
  const t = useT()
  return (
    <IconTip label={t('系统监控')} side="top">
      <button
        type="button"
        className={STATUS_ITEM_CLASS}
        aria-label={t('系统监控')}
        onClick={() => openSysmonTab()}
      >
        <Gauge className="size-4" />
      </button>
    </IconTip>
  )
}
