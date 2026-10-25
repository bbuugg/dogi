/**
 * 设置菜单底部那一行：**版本号 + 仓库地址**（对齐 dogi 设置侧栏的左下角）。
 *
 * 为什么不塞进「通用」里的 `AppUpdateSection`：那一块是**操作台**（检查 / 下载 / 安装，
 * 只有 desktop 有），而版本号是「我现在跑的是哪个包」的常驻事实 —— 每个分组都该看得到，
 * 也不该因为宿主没有自动更新能力就消失。
 *
 * ## 右侧那颗点：只在有更新时出现
 *
 * 状态来自 `useAppUpdateStatus()`（模块级一份订阅，与状态栏指示条 `AppUpdateBadge`、
 * 应用内提示 `AppUpdateNotifier` 共用同一份，不各订阅一遍 IPC）：
 *
 * | state | 点位 | 含义 |
 * |---|---|---|
 * | `available` | 红点 | 有新版本，等你点（本项目**不会**自动下载） |
 * | `downloaded` | 绿点 | 下好了，重启即装 |
 * | `downloading` | 转圈 | 后台在下（进度在设置 → 通用 里看） |
 * | 其余（`idle` / `checking` / `up-to-date`） | 不画 | 没事时不占位 |
 *
 * web / mobile 宿主没有 `appUpdate` 桥，`useAppUpdateStatus()` 恒为 `null` ——
 * 那两个端本来就没有「应用内自动更新」，所以只剩版本号，不是缺功能。
 * 手机版**整块不渲染**（`MobileSettingsPanel` 不引它）：一屏本来就紧，版本号在
 * 「通用」里看得到，不必再在菜单底边抢一行高度；web 端沿用 desktop 的两栏菜单，照旧显示。
 *
 * ## 点击行为
 *
 * 点版本号 = **切到「通用」**（软件更新区在那儿），不直接下载 / 重启：
 * 这一行是信息位，而安装要退出应用，得让人看清版本与进度再决定 —— 与
 * `AppUpdateBadge` 的「点击只是打开设置」同一条理由。
 *
 * 仓库那颗走 `openExternal`（desktop 落系统浏览器，web 用 `window.open`），
 * 不要写成 `<a target="_blank">`：桌面端在 `file://` 下点原生链接会被 Electron 拦。
 */
import { Loader2 } from 'lucide-react'
import { cn } from '@fizz/agent-kit/shared/lib/utils'
import { appVersion } from '@fizz/agent-kit/shared/lib/app-version'
import { useAppUpdateStatus } from '@fizz/agent-kit/shared/lib/app-update'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { openExternal } from '@fizz/agent-client/web-host'

/** 项目仓库（与 `git remote` 一致；改仓库时只改这一处） */
const REPO_URL = 'https://github.com/bbuugg/fizz'

/**
 * GitHub 的 mark。
 *
 * lucide 1.x 已经把品牌图标整批移除了（`Github` 不再导出），所以内联一份官方 octicon
 * 的 16×16 路径 —— 只为这一颗去引一个品牌图标包不值得。
 */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.19c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

export function SettingsFooter({
  onOpenGeneral,
  className
}: {
  /** 点版本号切到「通用」（软件更新区在那里） */
  onOpenGeneral: () => void
  className?: string
}) {
  const tr = useT()
  const status = useAppUpdateStatus()
  const version = appVersion()
  const state = status?.state ?? 'idle'
  const latest = status?.latest

  /** 版本号后面那颗点的提示语：说清「现在是什么状态、点了会发生什么」 */
  const versionTitle =
    state === 'available'
      ? tr('发现新版本 v{v}，去「通用」里下载', { v: latest ?? '?' })
      : state === 'downloaded'
        ? tr('已下载 v{v}，去「通用」里重启安装', { v: latest ?? '?' })
        : state === 'downloading'
          ? tr('正在下载新版本 v{v}', { v: latest ?? '?' })
          : tr('查看版本与更新')

  return (
    <div
      className={cn(
        'mt-3 flex shrink-0 items-center justify-between gap-2 px-1 pt-2.5',
        className
      )}
    >
      <button
        type="button"
        onClick={onOpenGeneral}
        title={versionTitle}
        aria-label={versionTitle}
        className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-primary-soft hover:text-foreground"
      >
        <span className="truncate font-mono text-[0.6875rem] leading-4">
          {version ? `v${version}` : '—'}
        </span>
        {/* 点位：红 = 要你动手，绿 = 已备好，转圈 = 后台在下（与 dogi 同一套语义） */}
        {state === 'available' && (
          <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />
        )}
        {state === 'downloaded' && (
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        )}
        {state === 'downloading' && (
          <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
        )}
      </button>

      <button
        type="button"
        onClick={() => void openExternal(REPO_URL)}
        title={tr('在 GitHub 上查看项目')}
        aria-label={tr('在 GitHub 上查看项目')}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary-soft hover:text-foreground"
      >
        <GithubMark className="size-3.5" />
      </button>
    </div>
  )
}
