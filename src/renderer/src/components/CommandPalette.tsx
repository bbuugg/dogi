import { useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Boxes,
  ChevronLeft,
  Globe,
  ListPlus,
  Plug,
  Search,
  Server,
  Settings,
  SquareTerminal,
  StickyNote,
  TerminalSquare
} from 'lucide-react'
import { cn } from 'cn'
import { Button, Input, Modal, type InputRef } from 'antd'
import { useAppStore } from '@/stores/app-store'
import { scriptToTerminalInput } from '@/lib/script'
import type { ScriptEntry } from '@shared/types'
import {
  API_ACTIVITY_ID,
  NOTES_ACTIVITY_ID,
  PLUGINS_ACTIVITY_ID,
  SCRIPTS_ACTIVITY_ID
} from '@/activity-ids'

/**
 * 命令面板层级：命令列表（根）/ 脚本列表 / 主机列表 / 插件列表。
 * 新增功能只需往 rootItems 里加一条命令；需要二级列表时再加一个 mode + 一组条目。
 */
type PaletteMode = 'root' | 'scripts' | 'hosts' | 'plugins'

interface PaletteItem {
  id: string
  /** 分组标题（同组连续展示时只显示一次） */
  group: string
  title: string
  /** 副标题：脚本描述/首行、主机地址等 */
  description?: string
  /** 右侧补充说明（快捷键等） */
  hint?: string
  /** 参与搜索的额外关键字 */
  keywords?: string
  icon: LucideIcon
  run: () => void
}

const MODE_LABEL: Record<Exclude<PaletteMode, 'root'>, string> = {
  scripts: '运行脚本',
  hosts: '连接主机',
  plugins: '打开插件'
}

const MODE_PLACEHOLDER: Record<PaletteMode, string> = {
  root: '输入命令名称…',
  scripts: '搜索脚本…',
  hosts: '搜索主机…',
  plugins: '搜索插件…'
}

/**
 * 命令面板（Ctrl+Shift+P）：所有功能的统一入口，脚本只是其中一个功能。
 * 选中带二级列表的命令（如「运行脚本」）后进入对应列表，Esc 返回命令列表。
 */
export function CommandPalette() {
  const open = useAppStore((s) => s.ui.commandPaletteOpen)
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen)
  const scripts = useAppStore((s) => s.scripts)
  const refreshScripts = useAppStore((s) => s.refreshScripts)
  const profiles = useAppStore((s) => s.profiles)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const createLocalSession = useAppStore((s) => s.createLocalSession)
  const connectHost = useAppStore((s) => s.connectHost)
  const selectActivity = useAppStore((s) => s.selectActivity)
  const createApiRequest = useAppStore((s) => s.createApiRequest)
  const openApiTab = useAppStore((s) => s.openApiTab)
  /** 插件列表（含启用状态）与已加载的插件视图实例（只有启用且加载成功的插件才有视图） */
  const pluginList = useAppStore((s) => s.pluginList)
  const plugins = useAppStore((s) => s.plugins)
  const refreshPluginList = useAppStore((s) => s.refreshPluginList)
  const openPluginTab = useAppStore((s) => s.openPluginTab)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const setRunScriptDialog = useAppStore((s) => s.setRunScriptDialog)

  const [mode, setMode] = useState<PaletteMode>('root')
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<InputRef>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 打开时回到命令列表并刷新数据（脚本/主机/插件可能在管理页中被改动过）
  useEffect(() => {
    if (!open) return
    setMode('root')
    setQuery('')
    setActiveIndex(0)
    void refreshScripts()
    void refreshProfiles()
    void refreshPluginList()
    // 等待 Dialog 渲染后再聚焦输入框
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, refreshScripts, refreshProfiles, refreshPluginList])

  const close = () => setOpen(false)

  const goMode = (next: PaletteMode) => {
    setMode(next)
    setQuery('')
    setActiveIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  /**
   * 执行脚本：当前有终端时直接写入该终端执行（逐行写入，末行回车）；
   * 没有终端时弹出运行脚本对话框，选择主机后连上去执行。
   */
  const runScript = (entry: ScriptEntry) => {
    if (!activeSessionId) {
      close()
      setRunScriptDialog(true, entry.id)
      return
    }
    void window.api.terminal.write(activeSessionId, scriptToTerminalInput(entry.content))
    close()
  }

  const rootItems: PaletteItem[] = [
    {
      id: 'script.run',
      group: '脚本',
      title: '运行脚本',
      description: '在当前终端执行已保存的脚本',
      keywords: 'script run shell 执行 运行',
      icon: TerminalSquare,
      run: () => goMode('scripts')
    },
    {
      id: 'script.manage',
      group: '脚本',
      title: '管理脚本',
      description: '新增 / 编辑 / 删除脚本',
      keywords: 'script manage edit 管理 编辑',
      icon: ListPlus,
      run: () => {
        close()
        selectActivity(SCRIPTS_ACTIVITY_ID)
      }
    },
    {
      id: 'terminal.new',
      group: '终端',
      title: '新建本地终端',
      hint: 'Ctrl+Alt+T',
      keywords: 'terminal local new 终端 新建 命令',
      icon: SquareTerminal,
      run: () => {
        close()
        void createLocalSession()
      }
    },
    {
      id: 'host.connect',
      group: '终端',
      title: '连接主机',
      description: '选择已保存的主机',
      keywords: 'ssh connect host 主机 连接',
      icon: Server,
      run: () => goMode('hosts')
    },
    {
      id: 'host.add',
      group: '终端',
      title: '添加主机',
      keywords: 'ssh add new host 添加 新建 主机',
      icon: Plug,
      run: () => {
        close()
        setSshDialog(true, null)
      }
    },
    {
      id: 'plugin.open',
      group: '界面',
      title: '打开插件',
      description: '选择要打开的插件界面',
      keywords: 'plugin open view 插件 打开 视图 扩展',
      icon: Boxes,
      run: () => goMode('plugins')
    },
    {
      id: 'plugin.manage',
      group: '界面',
      title: '插件管理',
      description: '安装 / 启用 / 卸载插件',
      keywords: 'plugin manage 插件 管理 扩展',
      icon: Boxes,
      run: () => {
        close()
        selectActivity(PLUGINS_ACTIVITY_ID)
      }
    },
    {
      id: 'notes.open',
      group: '界面',
      title: '打开笔记',
      description: '浏览 / 编辑本地笔记',
      keywords: 'note notes markdown 笔记 便签',
      icon: StickyNote,
      run: () => {
        close()
        selectActivity(NOTES_ACTIVITY_ID)
      }
    },
    {
      id: 'api.open',
      group: '界面',
      title: '打开接口请求',
      description: '调试 HTTP 接口（类 Postman）',
      keywords: 'api http request postman 接口 请求 调试 rest',
      icon: Globe,
      run: () => {
        close()
        selectActivity(API_ACTIVITY_ID)
      }
    },
    {
      id: 'api.new',
      group: '界面',
      title: '新建接口请求',
      description: '创建一条空请求并在新标签中打开',
      keywords: 'api http new request 接口 请求 新建',
      icon: Globe,
      run: () => {
        close()
        void createApiRequest().then((id) => {
          if (id) openApiTab(id)
        })
      }
    },
    {
      id: 'settings.open',
      group: '界面',
      title: '打开设置',
      hint: 'Ctrl+Alt+S',
      keywords: 'settings preference 设置 偏好',
      icon: Settings,
      run: () => {
        close()
        setSettingsOpen(true)
      }
    },
    {
      id: 'settings.ai',
      group: '界面',
      title: '设置：AI 模型',
      keywords: 'settings ai model 模型 设置',
      icon: Settings,
      run: () => {
        close()
        setSettingsOpen(true, 'ai')
      }
    },
    {
      id: 'settings.terminal',
      group: '界面',
      title: '设置：终端',
      keywords: 'settings terminal 终端 字体 主题 设置',
      icon: Settings,
      run: () => {
        close()
        setSettingsOpen(true, 'terminal')
      }
    },
    {
      id: 'settings.prefs',
      group: '界面',
      title: '设置：偏好',
      keywords: 'settings preference theme 偏好 主题 设置',
      icon: Settings,
      run: () => {
        close()
        setSettingsOpen(true, 'prefs')
      }
    }
  ]

  const scriptItems: PaletteItem[] = scripts.map((s) => ({
    id: `script.${s.id}`,
    group: '脚本',
    title: s.name,
    description: s.description || s.content.split('\n')[0] || '',
    keywords: s.content,
    icon: TerminalSquare,
    run: () => runScript(s)
  }))

  const hostItems: PaletteItem[] = profiles.map((p) => ({
    id: `host.${p.id}`,
    group: '主机',
    title: p.name,
    description:
      p.kind === 'local' ? p.command ?? '本地终端' : `${p.username}@${p.host}:${p.port}`,
    keywords: p.kind === 'local' ? p.command ?? '' : `${p.host} ${p.username}`,
    icon: p.kind === 'local' ? TerminalSquare : Server,
    run: () => {
      close()
      void connectHost(p)
    }
  }))

  /**
   * 可打开的插件：只列出「已启用且视图已加载」的插件 —— 禁用 / 加载失败的插件
   * 没有可渲染的视图，列出来点了也没反应，不如不显示（管理入口见底部「插件管理」）。
   */
  const pluginItems: PaletteItem[] = pluginList.flatMap((p) => {
    const view = plugins.find((v) => v.pluginId === p.id)
    if (!p.enabled || !view) return []
    return [
      {
        id: `plugin.${p.id}`,
        group: '插件',
        title: p.name,
        description: p.description || `v${p.version}`,
        keywords: `${p.id} ${p.author ?? ''} plugin 插件 扩展`,
        icon: Boxes,
        run: () => {
          close()
          openPluginTab(view.viewId)
        }
      }
    ]
  })

  const itemsByMode: Record<PaletteMode, PaletteItem[]> = {
    root: rootItems,
    scripts: scriptItems,
    hosts: hostItems,
    plugins: pluginItems
  }
  const items = itemsByMode[mode]

  const q = query.trim().toLowerCase()
  const filtered = q
    ? items.filter((it) =>
        `${it.group} ${it.title} ${it.description ?? ''} ${it.hint ?? ''} ${it.keywords ?? ''}`
          .toLowerCase()
          .includes(q)
      )
    : items

  // 搜索/切层后把高亮重置到首项
  useEffect(() => {
    setActiveIndex(0)
  }, [query, mode])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      filtered[activeIndex]?.run()
    } else if (e.key === 'Escape' && mode !== 'root') {
      // 二级列表里 Esc 返回命令列表（根层不拦截，交给 Modal 关闭）
      e.preventDefault()
      e.stopPropagation()
      goMode('root')
    }
  }

  const emptyText =
    mode === 'root'
      ? '没有匹配的命令。'
      : mode === 'scripts'
        ? scripts.length === 0
          ? '还没有脚本，先去「管理脚本」添加。'
          : '没有匹配的脚本。'
        : mode === 'plugins'
          ? pluginItems.length === 0
            ? '没有可打开的插件，先去「插件管理」安装并启用插件。'
            : '没有匹配的插件。'
          : profiles.length === 0
            ? '还没有保存的主机，先在侧边栏添加主机。'
            : '没有匹配的主机。'

  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      // 不需要右上角关闭按钮，Esc / 点击遮罩关闭即可
      closable={false}
      centered
      width={480}
      destroyOnHidden
      // 弹窗自带内边距会让内部分隔线贴不到边，这里收掉由内容自己控制
      styles={{ container: { padding: 10 }, body: { padding: 0 } }}
    >
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 transition-colors focus-within:border-primary">
          {mode === 'root' ? (
            <Search className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <button
              type="button"
              title="返回命令列表"
              aria-label="返回命令列表"
              className="-ml-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              onClick={() => goMode('root')}
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          <Input
            ref={inputRef}
            variant="borderless"
            value={query}
            placeholder={MODE_PLACEHOLDER[mode]}
            className="h-9 px-0"
            // antd 6 的 borderless 变体在 :focus-visible 时会给输入框自己画一圈 outline
            // （文本输入框点击即命中 focus-visible），看起来像内层小框单独长了边框。
            // 这里的视觉容器是外层圆角框，聚焦反馈交给外层的 focus-within，内层去掉 outline。
            style={{ outline: 'none' }}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {mode !== 'root' && (
            <span className="shrink-0 text-[10px] text-muted-foreground">{MODE_LABEL[mode]}</span>
          )}
        </div>

        {mode === 'scripts' && !activeSessionId && (
          <div className="rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600">
            当前没有终端：选择脚本后将让你选择主机执行。
          </div>
        )}

        <div ref={listRef} className="no-scrollbar max-h-80 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">{emptyText}</div>
          ) : (
            filtered.map((item, i) => {
              const Icon = item.icon
              const showGroup = i === 0 || filtered[i - 1].group !== item.group
              return (
                <div key={item.id}>
                  {showGroup && (
                    <div className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground">
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    data-idx={i}
                    onMouseMove={() => setActiveIndex(i)}
                    onClick={() => item.run()}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left',
                      i === activeIndex ? 'bg-primary/15' : 'hover:bg-secondary'
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{item.title}</div>
                      {item.description && (
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {item.description}
                        </div>
                      )}
                    </div>
                    {item.hint && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">{item.hint}</span>
                    )}
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border pt-2 px-2 text-xs text-muted-foreground">
          <span>
            {mode === 'root' ? '↑↓ 选择 · Enter 执行 · Esc 关闭' : '↑↓ 选择 · Enter 执行 · Esc 返回'}
          </span>
          {mode === 'scripts' && (
            <Button
              type="text"
              size="small"
              icon={<ListPlus className="size-4" />}
              className="h-7"
              onClick={() => {
                close()
                selectActivity(SCRIPTS_ACTIVITY_ID)
              }}
            >
              管理脚本
            </Button>
          )}
          {mode === 'plugins' && (
            <Button
              type="text"
              size="small"
              icon={<Boxes className="size-4" />}
              className="h-7"
              onClick={() => {
                close()
                selectActivity(PLUGINS_ACTIVITY_ID)
              }}
            >
              插件管理
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
