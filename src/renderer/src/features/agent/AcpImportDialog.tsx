import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Modal,
  Select,
  Spin,
  Tag,
  message
} from 'antd'
import { RefreshCw, Settings2 } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import type { AcpSessionInfo, AgentWorkspace } from '@shared/types'

/**
 * 「导入会话」弹窗。
 *
 * 只做三件事：**选一个已登记的 ACP agent → 拉取它侧的会话列表（`session/list`）→ 勾选导入**。
 *
 * agent 的登记 / 删除 / 模型勾选都在 **设置 → ACP agent**（footer 的「ACP 设置」直达，
 * 打开后定位到那个分组）。之前这里还带「检测已安装 / 手动添加 / 新建会话」，登记入口
 * 两边各一份、心智负担重，已收敛到设置页；要新建 ACP 会话走侧边栏的「新建会话」
 * （选一个 ACP agent 的模型发出首条消息即成，见 4.3）。
 *
 * 导入后每个会话在应用里只是一条**绑定记录**（acpAgentId + acpSessionId）：
 * 消息由 agent 自己管理，打开会话时用 `session/load` 回放历史。
 */
export function AcpImportDialog({
  workspace,
  open,
  onClose
}: {
  /** 导入到哪个工作区（会话的工作目录就是它） */
  workspace: AgentWorkspace
  open: boolean
  onClose: () => void
}) {
  const aiSettings = useAppStore((s) => s.aiSettings)
  const agentConversations = useAppStore((s) => s.agentConversations)
  const importAcpConversations = useAppStore((s) => s.importAcpConversations)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const acpAgents = aiSettings.acpAgents ?? []

  /** 当前选中的 ACP agent（拉取 / 导入都作用于它） */
  const [agentId, setAgentId] = useState<string | undefined>(undefined)
  const [sessions, setSessions] = useState<AcpSessionInfo[] | null>(null)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [importing, setImporting] = useState(false)

  // 打开时重置：每次都从「选 agent」开始，避免带上上次的勾选
  useEffect(() => {
    if (!open) return
    setAgentId(undefined)
    setSessions(null)
    setPicked([])
  }, [open])

  const selectedAgent = acpAgents.find((a) => a.id === agentId)

  /** 该 agent 在这个工作区里已经导入过的 agent 侧会话 id（列表里标「已导入」） */
  const importedIds = new Set(
    agentConversations
      .filter((c) => c.workspaceId === workspace.id && c.acpAgentId === agentId)
      .map((c) => c.acpSessionId)
      .filter((v): v is string => Boolean(v))
  )

  /** 拉取该 agent 侧的会话列表（`session/list`），按当前工作区目录过滤 */
  const pullSessions = async (): Promise<void> => {
    if (!selectedAgent) return
    setLoadingSessions(true)
    try {
      const list = await window.api.agent.acp.listSessions({
        acpAgentId: selectedAgent.id,
        cwd: workspace.path
      })
      setSessions(list)
      setPicked([])
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
      setSessions([])
    } finally {
      setLoadingSessions(false)
    }
  }

  const doImport = async (): Promise<void> => {
    if (!selectedAgent || !sessions) return
    const chosen = sessions.filter((s) => picked.includes(s.sessionId))
    if (chosen.length === 0) return
    setImporting(true)
    try {
      await importAcpConversations({
        workspaceId: workspace.id,
        acpAgentId: selectedAgent.id,
        sessions: chosen
      })
      message.success(`已导入 ${chosen.length} 个会话`)
      onClose()
    } catch (err) {
      message.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`导入会话 · ${workspace.name}`}
      centered
      width={620}
      destroyOnHidden
      footer={
        <div className="flex items-center justify-between">
          <Button
            size="small"
            type="text"
            icon={<Settings2 className="size-3.5" />}
            onClick={() => setSettingsOpen(true, 'acp')}
          >
            ACP 设置
          </Button>
          <div className="flex items-center gap-2">
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              loading={importing}
              disabled={picked.length === 0}
              onClick={() => void doImport()}
            >
              导入选中（{picked.length}）
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {acpAgents.length === 0 && (
          <Alert
            type="info"
            showIcon
            message="还没有登记 ACP agent"
            description="点左下角「ACP 设置」，检测已安装或手动添加后回来导入。"
          />
        )}

        {/* ---- 1. 选择 ACP agent ---- */}
        <Select
          placeholder="选择 ACP agent"
          value={agentId}
          onChange={(v) => {
            setAgentId(v)
            setSessions(null)
            setPicked([])
          }}
          options={acpAgents.map((a) => ({ value: a.id, label: `${a.name}（${a.command}）` }))}
          style={{ width: '100%' }}
          notFoundContent="还没有登记 ACP agent，点下方「ACP 设置」添加"
        />

        {/* ---- 2. 拉取会话 ---- */}
        {selectedAgent && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground">会话</span>
              <Button
                size="small"
                type="text"
                className="px-1"
                icon={<RefreshCw className="size-3.5" />}
                loading={loadingSessions}
                onClick={() => void pullSessions()}
              >
                拉取会话
              </Button>
              {sessions && sessions.length > 0 && (
                <span className="text-[11px] text-muted-foreground">共 {sessions.length} 个</span>
              )}
            </div>
            {loadingSessions ? (
              <div className="flex justify-center py-6">
                <Spin size="small" />
              </div>
            ) : sessions === null ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                点「拉取会话」列出该 agent 已有的会话（`session/list`）
              </p>
            ) : sessions.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span className="text-xs text-muted-foreground">该 agent 没有可导入的会话</span>
                }
              />
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-md border border-border">
                {sessions.map((s) => {
                  const already = importedIds.has(s.sessionId)
                  return (
                    <label
                      key={s.sessionId}
                      className="flex cursor-pointer items-start gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0 hover:bg-foreground/5"
                    >
                      <Checkbox
                        className="mt-0.5"
                        disabled={already}
                        checked={already || picked.includes(s.sessionId)}
                        onChange={(e) =>
                          setPicked((cur) =>
                            e.target.checked
                              ? [...cur, s.sessionId]
                              : cur.filter((x) => x !== s.sessionId)
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 truncate text-xs">
                            {s.title || s.sessionId}
                          </span>
                          {already && (
                            <Tag className="m-0 shrink-0 text-xs" color="default">
                              已导入
                            </Tag>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                          {s.cwd || '（未报告目录）'}
                          {s.updatedAt ? ` · ${s.updatedAt}` : ''}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            {sessions && sessions.some((s) => s.cwd && s.cwd !== workspace.path) && (
              <Alert
                type="warning"
                showIcon
                message="部分会话的工作目录与当前工作区不同"
                description="导入后该会话仍由 ACP agent 在自己的目录里操作，工作区文件树 / 内置工具看不到那些改动。"
              />
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
