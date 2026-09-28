import type { BrowserToolMode, McpServerConfig } from '@shared/types'
import { Button, Popover, Segmented, Switch, Tag, message } from 'antd'
import { Plug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/app-store'

/**
 * Agent 输入框工具条上的 MCP 配置入口（**Popover**，与模型选择下拉同一种交互，
 * 不再是打断式的 Modal）：用开关逐项启用 / 停用 MCP server。
 * - **浏览器工具**走偏好设置 `browserToolMode`（三态：关 / 应用内浏览器 / 系统浏览器）——
 *   一个开关管「AI 有没有浏览器能力」，一个二选一管「用哪套引擎」；
 * - 用户在设置里添加的 MCP server 走各自的 enabled 字段。
 * 改动即时持久化，下一轮对话即生效（server 端在保存时已失效旧连接）。
 */
export function McpConfigPopover() {
  const [open, setOpen] = useState(false)
  const [servers, setServers] = useState<Array<McpServerConfig & { error?: string }>>([])
  const [loading, setLoading] = useState(false)
  const preferences = useAppStore((s) => s.preferences)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
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

  const toggleServer = async (server: McpServerConfig & { error?: string }, v: boolean) => {
    try {
      await window.api.mcp.save({ ...server, enabled: v })
      setServers((list) => list.map((s) => (s.id === server.id ? { ...s, enabled: v } : s)))
    } catch {
      message.error('保存失败')
    }
  }

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
            开启的 MCP server 会将其工具自动提供给 AI 使用（stdio 类型）。
          </p>
          {/* 浏览器工具：一个开关（有没有）+ 一个二选一（用哪套引擎）。
              两套工具同名，只能二选一，所以是三态而不是两个开关 */}
          <div className="rounded-md border border-border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-medium">浏览器工具</div>
                <div className="text-[10px] leading-4 text-muted-foreground">
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
                <div className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                  {browserToolMode === 'in-app'
                    ? '无窗口运行，画面镜像到右侧「浏览器」标签（不弹本机窗口）'
                    : '由内置 Playwright MCP 驱动，会拉起本机的 Edge / Chrome 窗口'}
                </div>
              </>
            )}
          </div>

          {loading ? (
            <p className="rounded-md py-6 text-center text-xs text-muted-foreground">加载中…</p>
          ) : servers.length === 0 ? (
            <p className="rounded-md py-6 text-center text-xs text-muted-foreground">
              还没有自定义 MCP 服务，点下方「在设置中添加 / 编辑」新建
            </p>
          ) : (
            servers.map((server) => (
              <div
                key={server.id}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{server.name}</span>
                    {server.enabled ? (
                      <Tag color="default" className="m-0 h-4 border-0 bg-secondary px-1.5 text-[9px] leading-4">
                        启用
                      </Tag>
                    ) : (
                      <Tag variant="outlined" className="m-0 h-4 px-1.5 text-[9px] leading-4">
                        停用
                      </Tag>
                    )}
                    {server.error ? (
                      <Tag color="error" className="m-0 h-4 px-1.5 text-[9px] leading-4">
                        连接异常
                      </Tag>
                    ) : null}
                  </div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {server.command} {(server.args ?? []).join(' ')}
                  </div>
                </div>
                <Switch
                  checked={server.enabled !== false}
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
