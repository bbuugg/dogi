import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Square,
  Trash2
} from 'lucide-react'
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Switch,
  Tag,
  message
} from 'antd'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type { SshTunnel, SshTunnelRuntime, SshTunnelStatus, SshTunnelType } from '@shared/types'

/** 运行态展示元数据：状态点颜色 + 文本 */
const STATUS_META: Record<SshTunnelStatus, { label: string; dot: string }> = {
  stopped: { label: '已停止', dot: 'bg-muted-foreground/40' },
  starting: { label: '启动中', dot: 'bg-amber-500 animate-pulse' },
  running: { label: '运行中', dot: 'bg-emerald-500' },
  error: { label: '出错', dot: 'bg-red-500' }
}

/** 隧道类型展示元数据：行内标签文本 + 颜色 */
const TYPE_META: Record<SshTunnelType, { label: string; color: string }> = {
  local: { label: '本地转发', color: 'blue' },
  remote: { label: '远程转发', color: 'orange' },
  dynamic: { label: 'SOCKS5 动态', color: 'purple' }
}

/** 绑定到非回环地址的告警判定（localhost / 127.x / ::1 视为回环） */
function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
}

/** 隧道配置的可读摘要：转发类显示「监听 → 目标」，动态代理只显示 SOCKS5 */
function tunnelSummary(t: SshTunnel): string {
  const bind = `${t.bindHost}:${t.bindPort}`
  if (t.type === 'dynamic') return `${bind} → SOCKS5`
  const target = `${t.targetHost}:${t.targetPort}`
  // 远程转发的目标是本机端口，显式标注避免与「远端解析」的本地转发混淆
  return t.type === 'remote' ? `${bind} → 本机 ${target}` : `${bind} → ${target}`
}

/**
 * 「隧道」管理页（主区域单例标签）：SSH 端口转发（-L 本地转发 / -R 远程转发 / -D SOCKS5 动态代理）。
 *
 * 每条隧道由主进程独立建立 SSH 连接（走主机自己的跳板链），与应用内的终端会话互不影响；
 * 运行态由主进程全量推送（store 的 tunnelRuntime），启动失败落在状态里而不抛错，
 * 这里只负责展示与操作（启动 / 停止 / 编辑 / 删除），配置变更经 IPC 落盘。
 */
export function TunnelsPanel() {
  const tunnels = useAppStore((s) => s.tunnels)
  const tunnelRuntime = useAppStore((s) => s.tunnelRuntime)
  const profiles = useAppStore((s) => s.profiles)
  const refreshTunnels = useAppStore((s) => s.refreshTunnels)
  const removeTunnel = useAppStore((s) => s.removeTunnel)
  const startTunnel = useAppStore((s) => s.startTunnel)
  const stopTunnel = useAppStore((s) => s.stopTunnel)
  const tunnelSeed = useAppStore((s) => s.tunnelSeed)
  const consumeTunnelSeed = useAppStore((s) => s.consumeTunnelSeed)
  const openLogsTab = useAppStore((s) => s.openLogsTab)

  /** 新建 / 编辑弹窗状态；seedProfileId 为右键「隧道…」预选的主机 */
  const [dialog, setDialog] = useState<{
    open: boolean
    editing: SshTunnel | null
    seedProfileId: string | null
  }>({ open: false, editing: null, seedProfileId: null })
  const [refreshing, setRefreshing] = useState(false)

  // 面板挂载时兜底拉一次（bootstrap 已拉过；标签可能晚于数据加载被打开）
  useEffect(() => {
    void refreshTunnels()
  }, [refreshTunnels])

  // 右键「隧道…」：打开新建弹窗并预选主机，随后立即消费种子（下次打开不再带旧预选）
  useEffect(() => {
    if (!tunnelSeed) return
    setDialog({ open: true, editing: null, seedProfileId: tunnelSeed })
    consumeTunnelSeed()
  }, [tunnelSeed, consumeTunnelSeed])

  const closeDialog = (): void =>
    setDialog({ open: false, editing: null, seedProfileId: null })

  const openNew = (): void => setDialog({ open: true, editing: null, seedProfileId: null })

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshTunnels()
    } finally {
      setRefreshing(false)
    }
  }

  const runningCount = tunnels.filter((t) => tunnelRuntime[t.id]?.status === 'running').length

  // 按承载主机分组（数组顺序即配置顺序；主机被删后配置仍保留，显示为「已删除的主机」）
  const groups = new Map<string, SshTunnel[]>()
  for (const t of tunnels) {
    const list = groups.get(t.profileId) ?? []
    list.push(t)
    groups.set(t.profileId, list)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具条 */}
      <div className="flex items-center justify-between px-5 py-3">
        <div>
          <h1 className="text-base font-semibold">SSH 隧道</h1>
          <p className="text-xs text-muted-foreground">
            共 {tunnels.length} 条 · 运行中 {runningCount} 条 · 本地转发（-L）· 远程转发（-R）· SOCKS5 动态代理（-D）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="text" icon={<ScrollText className="size-4" />} onClick={() => openLogsTab()}>
            日志
          </Button>
          <Button
            type="text"
            icon={<RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            刷新
          </Button>
          <Button variant="filled" icon={<Plus className="size-4" />} onClick={openNew}>
            新建隧道
          </Button>
        </div>
      </div>

      {/* 隧道列表 */}
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-6">
        {tunnels.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <Network className="size-12 opacity-30" />
            <div className="text-sm">还没有隧道</div>
            <div className="text-xs text-muted-foreground/70">
              把远端内网服务映射到本地端口、把本机服务映射到服务器端口，或在本机开一个 SOCKS5 动态代理
            </div>
            <Button icon={<Plus className="size-4" />} onClick={openNew}>
              新建隧道
            </Button>
          </div>
        ) : (
          [...groups.entries()].map(([profileId, list]) => {
            const profile = profiles.find((p) => p.id === profileId)
            return (
              <div key={profileId}>
                <div className="flex items-baseline gap-2 px-1 pt-4 pb-1.5">
                  <span className="text-xs font-semibold">
                    {profile?.name ?? '已删除的主机'}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {profile ? `${profile.username}@${profile.host}:${profile.port}` : profileId}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {list.map((t) => (
                    <TunnelRow
                      key={t.id}
                      tunnel={t}
                      runtime={tunnelRuntime[t.id]}
                      onEdit={() => setDialog({ open: true, editing: t, seedProfileId: null })}
                      onStart={() => void startTunnel(t.id)}
                      onStop={() => void stopTunnel(t.id)}
                      onRemove={() => void removeTunnel(t.id)}
                    />
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>

      <TunnelDialog
        open={dialog.open}
        editing={dialog.editing}
        seedProfileId={dialog.seedProfileId}
        onClose={closeDialog}
      />
    </div>
  )
}

/** 单条隧道行：状态点 + 摘要 + 类型 / 自启标签 + 连接数 + 启停 / 编辑 / 删除 */
function TunnelRow({
  tunnel,
  runtime,
  onEdit,
  onStart,
  onStop,
  onRemove
}: {
  tunnel: SshTunnel
  runtime?: SshTunnelRuntime
  onEdit: () => void
  onStart: () => void
  onStop: () => void
  onRemove: () => void
}) {
  const status = runtime?.status ?? 'stopped'
  const meta = STATUS_META[status]
  const starting = status === 'starting'

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          className={cn('size-2 shrink-0 rounded-full', meta.dot)}
          title={meta.label}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            {tunnel.label && (
              <span className="truncate text-sm font-medium">{tunnel.label}</span>
            )}
            <span className="truncate font-mono text-xs text-muted-foreground">
              {tunnelSummary(tunnel)}
            </span>
          </div>
        </div>
        <Tag className="mr-0 shrink-0" color={TYPE_META[tunnel.type].color}>
          {TYPE_META[tunnel.type].label}
        </Tag>
        {tunnel.autoStart && (
          <Tag className="mr-0 shrink-0" color="cyan">
            自动启动
          </Tag>
        )}
        {status === 'running' && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {runtime?.conns ?? 0} 连接
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">{meta.label}</span>
        {status === 'running' ? (
          <Button
            type="text"
            size="small"
            icon={<Square className="size-3.5" />}
            title="停止"
            onClick={onStop}
          />
        ) : (
          <Button
            type="text"
            size="small"
            icon={<Play className="size-3.5" />}
            title="启动"
            disabled={starting}
            onClick={onStart}
          />
        )}
        <Button
          type="text"
          size="small"
          icon={<Pencil className="size-3.5" />}
          title="编辑"
          onClick={onEdit}
        />
        <Popconfirm
          title="删除隧道？"
          description={
            tunnel.label
              ? `「${tunnel.label}」将从列表中移除，该操作不可撤销。`
              : '该隧道将从列表中移除，该操作不可撤销。'
          }
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={onRemove}
        >
          <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} title="删除" />
        </Popconfirm>
      </div>
      {status === 'error' && runtime?.error && (
        <div className="mt-1 flex items-start gap-1.5 pl-4 text-xs text-red-500">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-all">{runtime.error}</span>
        </div>
      )}
    </div>
  )
}

/** 隧道表单值（保存载荷在 handleSave 里组装） */
interface FormValues {
  profileId: string
  type: SshTunnelType
  bindHost: string
  bindPort: number | null
  targetHost: string
  targetPort: number | null
  autoStart: boolean
  label: string
}

const emptyForm: FormValues = {
  profileId: '',
  type: 'local',
  bindHost: '127.0.0.1',
  bindPort: null,
  targetHost: '',
  targetPort: null,
  autoStart: false,
  label: ''
}

/**
 * 新建 / 编辑隧道弹窗：主机（仅远程主机）、类型、监听地址 / 端口、
 * 目标地址 / 端口（仅转发类）、自动启动、备注。
 * 「绑定到非回环地址」时按类型给出告警：转发与 SOCKS5 都没有认证，
 * 远程转发还受服务端 GatewayPorts 约束。
 */
function TunnelDialog({
  open,
  editing,
  seedProfileId,
  onClose
}: {
  open: boolean
  editing: SshTunnel | null
  seedProfileId: string | null
  onClose: () => void
}) {
  const profiles = useAppStore((s) => s.profiles)
  const saveTunnel = useAppStore((s) => s.saveTunnel)
  const [form] = Form.useForm<FormValues>()
  const [saving, setSaving] = useState(false)

  const type = Form.useWatch('type', form)
  const bindHost = Form.useWatch('bindHost', form)

  // 打开时回填（编辑 / 带预选主机的新建 / 空白新建）
  useEffect(() => {
    if (!open) return
    form.setFieldsValue(
      editing
        ? {
            profileId: editing.profileId,
            type: editing.type,
            bindHost: editing.bindHost,
            bindPort: editing.bindPort,
            targetHost: editing.targetHost ?? '',
            targetPort: editing.targetPort ?? null,
            autoStart: Boolean(editing.autoStart),
            label: editing.label ?? ''
          }
        : { ...emptyForm, profileId: seedProfileId ?? '' }
    )
  }, [open, editing, seedProfileId, form])

  const sshProfiles = profiles.filter((p) => p.kind === 'ssh')

  const handleSave = async (): Promise<void> => {
    let values: FormValues
    try {
      values = await form.validateFields()
    } catch {
      // 校验失败：表单已标红，不再打扰
      return
    }
    setSaving(true)
    try {
      const now = Date.now()
      await saveTunnel({
        id: editing?.id ?? '',
        profileId: values.profileId,
        type: values.type,
        bindHost: values.bindHost.trim() || '127.0.0.1',
        bindPort: values.bindPort!,
        // 仅 SOCKS5 没有目标侧：显式传 undefined（存储层合并时清掉旧目标）
        targetHost: values.type === 'dynamic' ? undefined : values.targetHost.trim(),
        targetPort: values.type === 'dynamic' ? undefined : values.targetPort!,
        label: values.label?.trim() || undefined,
        autoStart: Boolean(values.autoStart),
        createdAt: editing?.createdAt ?? now,
        updatedAt: now
      })
      message.success(
        editing
          ? '隧道已更新（运行中的隧道已自动重启）'
          : '隧道已创建，点「启动」即可建立转发'
      )
      onClose()
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const remote = type === 'remote'
  const needsTarget = type !== 'dynamic'

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={editing ? '编辑隧道' : '新建隧道'}
      centered
      width={480}
      destroyOnHidden
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="primary" loading={saving} onClick={() => void handleSave()}>
            保存
          </Button>
        </div>
      }
    >
      <Form form={form} layout="vertical" className="pt-1">
        <Form.Item
          name="profileId"
          label="主机"
          rules={[{ required: true, message: '请选择承载连接的主机' }]}
        >
          <Select
            placeholder="选择主机（凭据复用其配置，含跳板机）"
            options={sshProfiles.map((p) => ({
              value: p.id,
              label: `${p.name}（${p.username}@${p.host}:${p.port}）`
            }))}
          />
        </Form.Item>

        <Form.Item name="type" label="类型">
          <Segmented
            options={[
              { label: '本地转发（-L）', value: 'local' },
              { label: '远程转发（-R）', value: 'remote' },
              { label: 'SOCKS5 动态（-D）', value: 'dynamic' }
            ]}
          />
        </Form.Item>

        <div className="flex gap-3">
          <Form.Item
            name="bindHost"
            label={remote ? '服务器绑定地址' : '本地绑定地址'}
            className="flex-1"
            rules={[{ required: true, message: '请输入绑定地址' }]}
          >
            <Input placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item
            name="bindPort"
            label={remote ? '服务器绑定端口' : '本地绑定端口'}
            className="flex-1"
            rules={[{ required: true, message: '请输入绑定端口' }]}
          >
            <InputNumber min={1} max={65535} className="w-full" placeholder="如 8080" />
          </Form.Item>
        </div>

        {/* 非回环地址告警：都没有认证；远程转发还受服务端 GatewayPorts 约束 */}
        {bindHost && !isLoopback(bindHost) && (
          <div className="-mt-2 mb-4 flex items-start gap-1.5 text-xs text-amber-600">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {remote
                ? '服务器 sshd 默认只允许绑定回环地址，绑定非回环地址需要服务端开启 GatewayPorts；开启后服务器所在网络的其他主机无需凭据即可使用该转发，请确认环境可信'
                : `绑定到非回环地址后，同一网络内的其他主机无需凭据即可使用该${type === 'dynamic' ? '代理' : '转发'}，请确认环境可信`}
            </span>
          </div>
        )}

        {needsTarget && (
          <div className="flex gap-3">
            <Form.Item
              name="targetHost"
              label={remote ? '本机目标地址' : '目标地址'}
              className="flex-1"
              rules={[{ required: true, message: '请输入目标地址' }]}
            >
              <Input
                placeholder={remote ? '本机可达即可，如 localhost' : '由远端解析，如 db.internal'}
              />
            </Form.Item>
            <Form.Item
              name="targetPort"
              label={remote ? '本机目标端口' : '目标端口'}
              className="flex-1"
              rules={[{ required: true, message: '请输入目标端口' }]}
            >
              <InputNumber min={1} max={65535} className="w-full" placeholder="如 5432" />
            </Form.Item>
          </div>
        )}

        <Form.Item
          name="autoStart"
          label="自动启动"
          valuePropName="checked"
          extra="应用启动后自动建立该隧道"
          className="mb-0"
        >
          <Switch />
        </Form.Item>

        <Form.Item name="label" label="备注" className="mb-0">
          <Input placeholder="可选，如「内网 MySQL」" maxLength={40} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
