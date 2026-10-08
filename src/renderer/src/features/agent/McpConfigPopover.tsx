import type { BrowserToolMode, McpServerConfig } from '@shared/types'
import { MCP_TRANSPORT_LABELS, mcpServerSummary, mcpTransportOf } from '@shared/mcp'
import { Button, Popover, Segmented, Switch, Tag, message } from 'antd'
import { Plug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/app-store'

/**
 * Agent 输入框工具条上的 MCP 配置入口（**Popover**，与模型选择下拉同一种交互，
 * 不再是打断式的 Modal）。
 *
 * ## 两类开关，归属不同（别混）
 *
 * - **浏览器工具**：偏好设置 `browserToolMode`（三态：关 / 应用内浏览器 / 系统浏览器）——
 *   一个开关管「AI 有没有浏览器能力」，一个二选一管「用哪套引擎」。**全局**。
 * - **自定义 MCP server**：这里是**会话级**的勾选（写 `conversation.mcpServerIds`），
 *   不是全局启用开关（那个在设置里）。理由：MCP server 一多，工具清单会明显撑大
 *   系统提示词、也容易把模型带偏；而「这条会话只需要文件系统」是**按会话**的需求，
 *   让用户为了一个会话去全局停用、聊完再开回来是不现实的。
 *
 * 勾选状态：`mcpServerIds === undefined` 视为「全选」（老会话 / 没动过开关的会话），
 * 一旦勾选有变化就落成显式清单（全不勾 = `[]`，表示一个都不用）。
 */
export function McpConfigPopover({ conversationId }: { conversationId?: string | null }) {
  const [open, setOpen] = useState(false)
  const [servers, setServers] = useState<Array<McpServerConfig & { error?: string }>>([])
  const [loading, setLoading] = useState(false)
  const preferences = useAppStore((s) => s.preferences)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const setAgentConversationMcpServers = useAppStore((s) => s.setAgentConversationMcpServers)
  /** 当前会话的允许清单（undefined = 不限制）。订阅单个字段，避免流式期间每帧重渲染 */
  const mcpServerIds = useAppStore((s) =>
    conversationId ? s.agentConversations.find((c) => c.id === conversationId)?.mcpServerIds : undefined
  )
  const browserToolMode = (preferences.browserToolMode ?? 'in-app') as BrowserToolMode
  /** 关掉开关时记住「关之前用的是哪套」，重新打开能回到它 */
  const [lastOnMode, setLastOnMode] = useState<BrowserToolMode>(
    browserToolMode === 'off' ? 'in-app' : browserToolMode
  )
  useEffect(() => {
    if (browserToolMode !== 'off') setLastOnMode(browserToolMode)
  }, [browserToolMode])

  const load = async () => {
    setLoading(true)
    try {
      setServers(
        (await window.api.mcp.list()) as Array<McpServerConfig & { error?: string }>
      )
    } catch {
      // 忽略加载失败
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load()
  }, [open])

  /** 保存浏览器工具来源（三态）；关掉时不动 lastOnMode，方便一键开回来 */
  const saveBrowserToolMode = async (next: BrowserToolMode) => {
    try {
      await window.api.prefs.save({ browserToolMode: next })
    } catch {
      message.error('保存失败')
    }
  }

  /**
   * 勾选 / 取消勾选某个 server（**只影响这条会话**）。
   *
   * 落盘的是**显式清单**：以「当前生效的那份」为基准增删，再整体写回 ——
   * 这样从 `undefined`（全选）切到显式清单时，其余项的状态不会被意外丢掉。
   */
  const toggleServer = async (server: McpServerConfig & { error?: string }, checked: boolean) => {
    if (!conversationId) {
      message.warning('请先选中一个会话')
      return
    }
    // 当前生效的集合：没设过就是「所有全局启用的」
    const current = new Set(
      mcpServerIds ?? servers.filter((s) => s.enabled !== false).map((s) => s.id)
    )
    if (checked) current.add(server.id)
    else current.delete(server.id)
    try {
      await setAgentConversationMcpServers(conversationId, [...current])
    } catch {
      message.error('保存失败')
    }
  }

  /** 某个 server 在这条会话里是否生效 */
  const isChecked = (server: McpServerConfig & { error?: string }): boolean =>
    mcpServerIds === undefined ? server.enabled !== false : mcpServerIds.includes(server.id)

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topRight"
      // 输入框在页面底部：向上弹出，箭头默认即可
      title="MCP 工具配置"
      content={
        <div className="w-[420px] space-y-2">
          <p className="text-xs text-muted-foreground">
            勾选决定**这条会话**能用哪些 MCP server（在设置里全局启用的那些）。
            取消勾选只影响当前会话，不改全局开关。
          </p>
          {/* 浏览器工具：一个开关（有没有）+ 一个二选一（用哪套引擎）。
              两套工具同名，只能二选一，所以是三态而不是两个开关 */}
          <div className="rounded-md border border-border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-medium">浏览器工具</div>
                <div className="text-xs leading-4 text-muted-foreground">
                  关闭后 AI 拿不到任何浏览器工具（面板仍可手动使用）
                </div>
              </div>
              <Switch
                checked={browserToolMode !== 'off'}
                onChange={(v) => void saveBrowserToolMode(v ? lastOnMode : 'off')}
              />
            </div>
            {browserToolMode !== 'off' && (
              <>
                <Segmented
                  size="small"
                  block
                  className="mt-2"
                  value={browserToolMode}
                  onChange={(v) => void saveBrowserToolMode(v as BrowserToolMode)}
                  options={[
                    { label: '应用内浏览器', value: 'in-app' },
                    { label: '系统浏览器', value: 'system' }
                  ]}
                />
                <div className="mt-1.5 text-xs leading-4 text-muted-foreground">
                  {browserToolMode === 'in-app'
                    ? '无窗口运行，画面镜像到右侧「浏览器」标签（不弹本机窗口）'
                    : '由内置 Playwright MCP 驱动，会拉起本机的 Edge / Chrome 窗口'}
                </div>
              </>
            )}
          </div>

          {loading ? (
            <p className="rounded-md py-6 text-center text-xs text-muted-foreground">加载中…</p>
          ) : servers.filter((s) => s.enabled !== false).length === 0 ? (
            <p className="rounded-md py-6 text-center text-xs text-muted-foreground">
              还没有启用中的 MCP 服务，点下方「在设置中添加 / 编辑」新建
            </p>
          ) : (
            // 只列**全局启用**的：全局停用的在这里勾也勾不亮（主进程取交集时会被滤掉），
            // 摆出来只会让人以为勾上就生效
            servers
              .filter((s) => s.enabled !== false)
              .map((server) => (
                <div
                  key={server.id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{server.name}</span>
                      <Tag variant="outlined" className="m-0 h-4 px-1.5 text-[9px] leading-4">
                        {MCP_TRANSPORT_LABELS[mcpTransportOf(server)]}
                      </Tag>
                      {server.error ? (
                        <Tag color="error" className="m-0 h-4 px-1.5 text-[9px] leading-4">
                          连接异常
                        </Tag>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {mcpServerSummary(server)}
                    </div>
                  </div>
                  <Switch
                    checked={isChecked(server)}
                    onChange={(v) => void toggleServer(server, v)}
                  />
                </div>
              ))
          )}

          <div className="flex justify-end pt-0.5">
            <Button
              size="small"
              type="text"
              onClick={() => {
                setOpen(false)
                setSettingsOpen(true, 'mcp')
              }}
            >
              在设置中添加 / 编辑
            </Button>
          </div>
        </div>
      }
    >
      <Button
        type="text"
        size="small"
        icon={<Plug className="size-4" />}
        title="MCP 工具配置"
        className="shrink-0 text-muted-foreground"
      />
    </Popover>
  )
}
