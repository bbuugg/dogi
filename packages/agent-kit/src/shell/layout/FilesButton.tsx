/**
 * 状态栏的「文件管理」入口（与「应用日志」并排，日志那颗的左边）。
 *
 * 为什么放状态栏：文件管理器浏览的是**服务端那台机器的整盘**，与当前项目 / 会话 / 主机
 * 都无关 —— 它跟「应用日志」一样是**全局、低频、哪儿都能点到**的入口带（见
 * `StatusBar.tsx` 文件头）。点开就在主区域开一条 `files:list` 标签，可以和对话、
 * 终端并排分屏（与主机日志 / 定时任务同一套）。
 */
import { FolderTree } from 'lucide-react'
import { IconTip } from '@fizz/agent-kit/shared/components/IconTip'
import { openFilesTab } from '@fizz/agent-kit/shared/lib/tool-tabs'
import { STATUS_ITEM_CLASS } from '@fizz/agent-kit/shared/lib/status-bar'
import { useT } from '@fizz/agent-kit/shared/lib/language'

export function FilesButton() {
  const t = useT()
  return (
    <IconTip label={t("文件管理")} side="top">
      <button
        type="button"
        className={STATUS_ITEM_CLASS}
        aria-label={t("文件管理")}
        onClick={() => openFilesTab()}
      >
        <FolderTree className="size-4" />
      </button>
    </IconTip>
  )
}
