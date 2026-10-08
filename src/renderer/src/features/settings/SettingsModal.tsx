import {
  Bot,
  Cpu,
  Keyboard,
  Loader2,
  MessageSquareText,
  Palette,
  Plug,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Modal, message } from 'antd'
import { cn } from 'cn'
import type { AppUpdateStatus } from '@shared/types'
import { normalizeSettingsTab, useAppStore, type SettingsTab } from '@/stores/app-store'
import { PrefSettings } from './PrefSettings'
import { TerminalSettings } from './TerminalSettings'
import { ShortcutSettings } from './ShortcutSettings'
import { ModelSettings } from './ModelSettings'
import { AcpAgentSettings } from './AcpAgentSettings'
import { McpSettings } from './McpSettings'
import { SkillsSettings } from './SkillsSettings'
import { SystemPromptSettings } from './SystemPromptSettings'
import { TimeoutSettings } from './TimeoutSettings'

/** GitHub 标志（lucide-react 已移除品牌图标，这里内联官方 mark） */
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={cn(className)}
    >
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  )
}

/** 分组菜单：按「用户想干什么」分组，不按内部模块（参考 fishwork 设置） */
const GROUPS: Array<{
  title: string
  items: Array<{ value: SettingsTab; label: string; icon: LucideIcon }>
}> = [
    {
      title: '基础',
      items: [
        { value: 'prefs', label: '偏好', icon: Palette },
        { value: 'shortcuts', label: '快捷键', icon: Keyboard }
      ]
    },
    {
      title: '终端',
      items: [{ value: 'terminal', label: '终端', icon: TerminalSquare }]
    },
    {
      title: 'AI',
      items: [
        { value: 'models', label: '模型配置', icon: Cpu },
        { value: 'acp', label: 'ACP agent', icon: Bot },
        { value: 'mcp', label: 'MCP 服务', icon: Plug },
        { value: 'skills', label: '技能', icon: Sparkles },
        { value: 'timeouts', label: '运行', icon: SlidersHorizontal },
        { value: 'prompt', label: '系统提示词', icon: MessageSquareText }
      ]
    }
  ]

/**
 * 设置弹窗：主窗口内的 antd Modal，**不是**独立窗口。
 *
 * 与主界面同进程、同一个 store，所以改完立即生效，不再需要「独立窗口 + 跨窗口广播
 * 回填」那套同步。样式沿用原独立窗口：左侧分组菜单（含版本号 / 仓库链接）+ 右侧内容区。
 * 打开时展示哪个分组由 `ui.settingsTab` 决定（命令面板与各处「设置：XX」入口传入）。
 */
export function SettingsModal() {
  const open = useAppStore((s) => s.ui.settingsOpen)
  const settingsTab = useAppStore((s) => s.ui.settingsTab)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const [tab, setTab] = useState<SettingsTab>(() => normalizeSettingsTab(settingsTab))

  // 每次打开都按入口重置分组（与旧独立窗口「每次新开都是入口那一页」一致）
  useEffect(() => {
    if (open) setTab(normalizeSettingsTab(settingsTab))
  }, [open, settingsTab])

  // 左下角版本号（来自 app.getVersion）+ 自动更新状态
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<AppUpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    if (!open) return
    void window.api.app.info().then((info) => setVersion(`v${info.version}`))
    void window.api.updater.status().then(setUpdate)
    return window.api.updater.onStatus(setUpdate)
  }, [open])

  /**
   * 手动检查更新。**结果一律如实说**：已是最新 / 新版本已在下载 / 下载完成可安装 /
   * 开发态不支持 —— 检查失败由主进程静默吞掉（断网是常态，不该弹红条）。
   */
  const checkUpdate = async (): Promise<void> => {
    if (!update?.supported) {
      message.info('当前是开发版本，检查更新只在打包后的应用里可用')
      return
    }
    // 已经下好了：这一步是「装」，不是「查」——装 = 重启，弹窗问一句
    if (update.state === 'downloaded') {
      Modal.confirm({
        title: `安装 ${update.latest ?? ''}？`,
        content: '应用会重启完成安装，正在进行的会话会先落盘再退出。',
        okText: '重启安装',
        cancelText: '稍后',
        centered: true,
        onOk: async () => {
          await window.api.updater.install()
        }
      })
      return
    }
    // 有新版本待下载：点一下就开始后台下载（可随时取消）
    if (update.state === 'available') {
      await window.api.updater.download()
      return
    }
    // 正在下载：点一下取消
    if (update.state === 'downloading') {
      await window.api.updater.cancel()
      return
    }
    setChecking(true)
    try {
      const next = await window.api.updater.check()
      setUpdate(next)
      if (next.state === 'up-to-date') message.success('已是最新版本')
      else if (next.state === 'available') message.info(`发现新版本 ${next.latest ?? ''}，点击开始下载`)
      else if (next.state === 'downloading') message.info(`正在后台下载 ${next.latest ?? ''}`)
      else if (next.state === 'downloaded')
        message.success(`${next.latest ?? ''} 已就绪，重启即可安装`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={() => setSettingsOpen(false)}
      title={<span className="text-xs font-semibold">设置</span>}
      centered
      width={880}
      footer={null}
      mask={{ closable: false }}
      // 点遮罩 / 按 Esc 都不关：避免编辑到一半被误关（与旧独立窗口只能点关闭一致）
      keyboard={false}
      destroyOnHidden
      styles={{
        container: { overflow: "hidden", padding: 0, background: 'var(--sidebar)' },
        header: { padding: '4px 12px', marginBottom: 0, borderBottom: 'none' },
        body: { padding: 0 },
        close: { top: 4 }
      }}
    >
      <div
        className="flex overflow-hidden bg-sidebar p-2"
        style={{ height: 'min(504px, calc(100vh - 180px))' }}
      >
        {/* 左侧分组菜单 */}
        <nav className="no-scrollbar flex w-48 shrink-0 flex-col overflow-y-auto p-2">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="px-2 pb-1 text-xs font-medium text-muted-foreground/70">
                {group.title}
              </div>
              <div className="space-y-1">
                {group.items.map(({ value, label, icon: Icon }) => {
                  const active = tab === value
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTab(value)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                        active
                          ? 'bg-primary/20 text-foreground'
                          : 'text-muted-foreground hover:bg-primary/10 hover:text-foreground'
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}

          {/* 左下角：版本号（点它 = 检查更新）+ 仓库链接 */}
          <div className="mt-auto flex items-center justify-between px-1 pt-4">
            <button
              type="button"
              onClick={() => void checkUpdate()}
              disabled={checking}
              title={
                update?.supported === false
                  ? '开发版本不支持检查更新'
                  : update?.state === 'downloaded'
                    ? `点击安装 ${update.latest ?? ''}`
                    : update?.state === 'available'
                      ? `发现新版本 ${update.latest ?? ''}，点击下载`
                      : update?.state === 'downloading'
                        ? '正在下载，点击取消'
                        : '点击检查更新'
              }
              className="flex items-center gap-1 rounded px-0.5 font-mono text-[11px] text-muted-foreground/70 transition-colors hover:bg-primary/10 hover:text-foreground disabled:opacity-60"
            >
              {version || '—'}
              {update?.state === 'downloaded' ? (
                <span className="size-1.5 rounded-full bg-emerald-500" aria-label="有可用更新" />
              ) : update?.state === 'downloading' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : update?.state === 'available' ? (
                <span className="size-1.5 rounded-full bg-red-500" aria-label="有可用更新" />
              ) : null}
            </button>
            <a
              href="https://github.com/bbuugg/dogi"
              target="_blank"
              rel="noreferrer noopener"
              title="在 GitHub 上查看项目"
              onClick={(e) => {
                e.preventDefault()
                void window.api.app.openExternal('https://github.com/bbuugg/dogi')
              }}
              className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
            >
              <GithubIcon className="size-4" />
            </a>
          </div>
        </nav>

        {/* 右侧内容 */}
        <div className="no-scrollbar min-w-0 flex-1 overflow-y-auto rounded-xl bg-background px-4 py-3">
          {tab === 'prefs' && <PrefSettings />}
          {tab === 'shortcuts' && <ShortcutSettings />}
          {tab === 'terminal' && <TerminalSettings />}
          {tab === 'models' && <ModelSettings />}
          {tab === 'acp' && <AcpAgentSettings />}
          {tab === 'mcp' && <McpSettings />}
          {tab === 'skills' && <SkillsSettings />}
          {tab === 'timeouts' && <TimeoutSettings />}
          {tab === 'prompt' && <SystemPromptSettings />}
        </div>
      </div>
    </Modal>
  )
}
