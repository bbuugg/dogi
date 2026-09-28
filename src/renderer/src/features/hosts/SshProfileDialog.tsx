import { useEffect, useMemo, useState } from 'react'
import type { ComponentProps, ReactElement } from 'react'
import type {
  HostKind,
  MoshClientStatus,
  ShellProfile,
  SshAuthType,
  SshProfile
} from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import {
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Switch,
  Tooltip,
  message
} from 'antd'
import { cn } from 'cn'

/** 从 antd Form.Item 的 rules 推导规则类型，避免深路径导入 */
type FormRule = NonNullable<ComponentProps<typeof Form.Item>['rules']> extends Array<infer R>
  ? R
  : never

/** 认证方式下拉项 */
const AUTH_TYPE_OPTIONS = [
  { value: 'password', label: '密码' },
  { value: 'privateKey', label: '私钥' }
]

interface FormValues {
  name: string
  groupId: string
  kind: HostKind
  host: string
  port: number
  username: string
  authType: SshAuthType
  password: string
  privateKey: string
  passphrase: string
  useMosh: boolean
  jumpProfileId: string
  keepaliveInterval: number | null
  shellId: string
  autoCommand: string
}

function toForm(profile: SshProfile | null | undefined): Partial<FormValues> {
  if (!profile) {
    return {
      name: '',
      groupId: '',
      kind: 'ssh',
      host: '',
      port: 22,
      username: 'root',
      authType: 'password',
      password: '',
      privateKey: '',
      passphrase: '',
      useMosh: false,
      jumpProfileId: '',
      keepaliveInterval: null,
      shellId: '',
      autoCommand: ''
    }
  }
  return {
    name: profile.name,
    groupId: profile.groupId ?? '',
    kind: profile.kind ?? 'ssh',
    host: profile.host,
    port: profile.port ?? 22,
    username: profile.username,
    authType: profile.authType,
    password: '',
    privateKey: '',
    passphrase: '',
    useMosh: profile.useMosh ?? false,
    jumpProfileId: profile.jumpProfileId ?? '',
    keepaliveInterval: profile.keepaliveInterval ?? null,
    shellId: '',
    autoCommand: profile.autoCommand ?? ''
  }
}

/** 仅在 ssh 主机下才必填 */
function sshRequired(msg: string, form: ReturnType<typeof Form.useForm>[0]): FormRule {
  return {
    validator: (_rule: unknown, value: unknown) =>
      form.getFieldValue('kind') === 'ssh' && !String(value ?? '').trim()
        ? Promise.reject(new Error(msg))
        : Promise.resolve()
  }
}

/**
 * 从 startId 沿 jumpProfileId 链路走一圈，判断是否会绕到 targetId。
 * 用于把「选了必然成环的跳板机」从候选中剔除；自带环保护（脏数据不炸）。
 */
function chainReaches(profiles: SshProfile[], startId: string, targetId: string): boolean {
  const seen = new Set<string>()
  let id: string | undefined = startId
  while (id && !seen.has(id)) {
    if (id === targetId) return true
    seen.add(id)
    id = profiles.find((p) => p.id === id)?.jumpProfileId
  }
  return false
}

/** 编辑中的主机可选的跳板机：其它 ssh 主机且自身链路不会绕回当前主机 */
function jumpCandidates(profiles: SshProfile[], selfId: string | undefined): SshProfile[] {
  return profiles.filter(
    (p) =>
      p.kind === 'ssh' && (!selfId || (p.id !== selfId && !chainReaches(profiles, p.id, selfId)))
  )
}

function Field({
  name,
  rules,
  children
}: {
  name: string
  rules?: FormRule[]
  children: ReactElement
}) {
  return (
    <Form.Item name={name} rules={rules} validateTrigger="onChange" style={{ marginBottom: 0 }}>
      {children}
    </Form.Item>
  )
}

export function SshProfileDialog() {
  const sshDialog = useAppStore((s) => s.ui.sshDialog)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const connectHost = useAppStore((s) => s.connectHost)
  const sshGroups = useAppStore((s) => s.sshGroups)
  const profiles = useAppStore((s) => s.profiles)
  const knownHosts = useAppStore((s) => s.knownHosts)
  const resetHostKey = useAppStore((s) => s.resetHostKey)

  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  /** 「测试连接」进行中（与保存互不干扰） */
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 检测到的本地 shell（启动环境下拉选项） */
  const [shells, setShells] = useState<ShellProfile[]>([])
  /** 勾选 Mosh 后的本地客户端探测结果（null = 未勾选 / 尚未探测完） */
  const [moshStatus, setMoshStatus] = useState<MoshClientStatus | null>(null)
  // 关闭时 store 会把 editing 清空，但弹窗关闭动画期间组件仍挂载；
  // 沿用最近一次的 editing，避免 footer 在动画中闪现「保存并连接」按钮
  const [lastEditing, setLastEditing] = useState<SshProfile | null>(null)
  const editing = (sshDialog.open ? sshDialog.editing : lastEditing) ?? null
  const isEdit = Boolean(editing?.id)

  const kind = Form.useWatch('kind', form)
  const authType = Form.useWatch('authType', form)
  const useMosh = Form.useWatch('useMosh', form)
  const jumpProfileId = Form.useWatch('jumpProfileId', form)
  const formHost = Form.useWatch('host', form)
  const formPort = Form.useWatch('port', form)

  /** 当前表单地址的指纹记录（展示指纹行 / 重置入口；改地址后自动跟随） */
  const knownHost = useMemo(() => {
    const host = (formHost ?? '').trim()
    if (!host) return undefined
    const port = Number(formPort) || 22
    return knownHosts.find((k) => k.host === host && k.port === port)
  }, [knownHosts, formHost, formPort])

  /** 可作为跳板机的主机：其它 ssh 主机，且其链路不会绕回当前主机（防成环） */
  const jumpOptions = useMemo(
    () => [
      { value: '', label: '直接连接' },
      ...jumpCandidates(profiles, editing?.id).map((p) => ({
        value: p.id,
        label: `${p.name}（${p.username}@${p.host}）`
      }))
    ],
    [profiles, editing?.id]
  )

  useEffect(() => {
    if (sshDialog.open) {
      setLastEditing(sshDialog.editing ?? null)
      const next = toForm(editing)
      // 从某个分组里点「+」新建时，预设分组
      if (!next.name && sshDialog.groupId) next.groupId = sshDialog.groupId
      form.setFieldsValue(next)
      setError(null)
      // 按需刷新本地 shell 列表（供「选择检测到的环境」下拉），并回填 / 预选启动环境
      void window.api.terminal.listShells().then((r) => {
        setShells(r.shells)
        const matched =
          editing?.kind === 'local'
            ? r.shells.find((s) => s.command === editing.command)
            : undefined
        let shellId = form.getFieldValue('shellId') as string
        if (matched) shellId = matched.id
        else if (!isEdit && form.getFieldValue('kind') === 'local') shellId = r.defaultId
        form.setFieldValue('shellId', shellId)
      })
    }
  }, [sshDialog.open, sshDialog.groupId, editing, form])

  // 勾选 Mosh 后探测本地 mosh-client：只提示不拦截（装好后下次勾选 / 保存即生效）
  useEffect(() => {
    if (!sshDialog.open || kind !== 'ssh' || !useMosh) {
      setMoshStatus(null)
      return
    }
    let alive = true
    void window.api.terminal.moshStatus(true).then((status) => {
      if (alive) setMoshStatus(status)
    })
    return () => {
      alive = false
    }
  }, [sshDialog.open, kind, useMosh])

  /** 表单值 → 保存 / 测试共用的主机配置载荷（留空的凭据传 undefined，主进程保留旧值） */
  const buildPayload = (values: FormValues): SshProfile => {
    const now = Date.now()
    // 本地启动环境：由选中的检测 shell 决定可执行文件与参数
    const localShell = shells.find((s) => s.id === values.shellId)
    const autoCommand =
      values.kind === 'local' ? values.autoCommand?.trim() || undefined : undefined
    const isSsh = values.kind === 'ssh'
    return {
      id: editing?.id ?? '',
      kind: values.kind,
      groupId: values.groupId || undefined,
      // 颜色不在表单里维护，编辑时原样带回，避免保存时被清掉
      color: editing?.color,
      name: values.name.trim(),
      // ssh 专用字段；本地主机不填写（类型上必填，置空标记）
      host: isSsh ? values.host.trim() : '',
      port: isSsh ? Number(values.port) || 22 : 0,
      username: isSsh ? values.username.trim() : '',
      authType: isSsh ? values.authType : (editing?.authType ?? 'password'),
      // 留空传 undefined：主进程保留旧密码 / 密钥 / 口令
      password: !isSsh || values.password === '' ? undefined : values.password,
      privateKey:
        !isSsh || !values.privateKey ? undefined : values.privateKey.replace(/\r\n/g, '\n'),
      passphrase: !isSsh || values.passphrase === '' ? undefined : values.passphrase,
      useMosh: isSsh ? values.useMosh : undefined,
      // 跳板机 / 保活：显式传 undefined 表示清空（回到直连 / 默认 15 秒）
      jumpProfileId: isSsh && values.jumpProfileId ? values.jumpProfileId : undefined,
      keepaliveInterval:
        isSsh && typeof values.keepaliveInterval === 'number' ? values.keepaliveInterval : undefined,
      command: values.kind === 'local' ? localShell?.command : undefined,
      args: values.kind === 'local' ? localShell?.args : undefined,
      autoCommand,
      createdAt: editing?.createdAt ?? now,
      updatedAt: now
    }
  }

  const handleSave = async (connectAfter: boolean) => {
    try {
      // 触发 antd 校验：不合法时自动红框 + 提示，并 reject 中断保存
      await form.validateFields()
    } catch {
      return
    }
    // validateFields 只返回已挂载字段；折叠的高级区（跳板 / 保活）与未选中的认证分支不会挂载，
    // 这里取全量快照，保证未展开的配置也随保存带上、不被误清空
    const values = form.getFieldsValue(true) as FormValues
    setSaving(true)
    setError(null)
    try {
      const payload = buildPayload(values)
      await window.api.ssh.save(payload)
      await refreshProfiles()
      setSshDialog(false, null)
      message.success(isEdit ? '主机已更新' : '主机已添加')
      if (connectAfter) {
        const profiles = await window.api.ssh.list()
        const saved = profiles.find((p) => p.name === payload.name && p.kind === payload.kind)
        if (saved) {
          void connectHost(saved).catch((e) => {
            message.error(`连接失败：${e instanceof Error ? e.message : String(e)}`)
          })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      message.error(`保存失败：${msg}`)
    } finally {
      setSaving(false)
    }
  }

  /** 从文件导入私钥（CRLF 归一化成 LF，保存时再次归一化是幂等的） */
  const handleImportKey = async (): Promise<void> => {
    try {
      const file = await window.api.ssh.readKeyFile()
      if (!file) return
      form.setFieldValue('privateKey', file.content.replace(/\r\n/g, '\n'))
      message.success(`已从文件导入：${file.path}`)
    } catch (err) {
      message.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 测试连接：与保存同一份载荷（留空的凭据由主进程用已存值补全） */
  const handleTest = async (): Promise<void> => {
    try {
      // 与保存同一套校验；同样用全量快照，未挂载字段（高级区）也如实带上
      await form.validateFields()
    } catch {
      return
    }
    const values = form.getFieldsValue(true) as FormValues
    setTesting(true)
    try {
      const { ms } = await window.api.ssh.test(buildPayload(values))
      message.success(`连接成功（${ms} ms）`)
    } catch (err) {
      message.error(`连接失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  /** 重置当前表单地址的主机指纹（下次连接重新 TOFU 记录） */
  const handleResetHostKey = async (): Promise<void> => {
    if (!knownHost) return
    await resetHostKey(knownHost.host, knownHost.port)
    message.success('主机指纹已重置，下次连接将重新记录')
  }

  const launchOptions = shells.map((s) => ({ value: s.id, label: s.name }))
  const portRules: FormRule[] = [
    { required: true, message: '请填写端口' },
    { type: 'number', min: 1, max: 65535, message: '端口号需为 1 - 65535 之间的整数' }
  ]
  /** 跳板机 / Mosh 互斥时各自的禁用原因（悬停时解释） */
  const jumpDisabledReason = useMosh
    ? '已启用 Mosh：mosh 走 UDP，无法经 SSH 隧道，需先关闭 Mosh'
    : null
  const moshDisabledReason =
    jumpProfileId && !useMosh
      ? '已选择跳板机：mosh 走 UDP，无法经 SSH 隧道，需先清除跳板机'
      : null

  return (
    <Modal
      open={sshDialog.open}
      onCancel={() => setSshDialog(false, null)}
      title={isEdit ? '编辑主机' : '新建主机'}
      centered
      width={520}
      destroyOnHidden
      footer={
        <div className="flex items-center gap-2">
          {kind === 'ssh' && (
            <Button
              className="mr-auto"
              loading={testing}
              disabled={saving}
              onClick={() => void handleTest()}
            >
              测试连接
            </Button>
          )}
          <Button onClick={() => setSshDialog(false, null)}>取消</Button>
          <Button loading={saving} onClick={() => void handleSave(false)}>
            保存
          </Button>
          {!isEdit && (
            <Button type="primary" loading={saving} onClick={() => void handleSave(true)}>
              保存并连接
            </Button>
          )}
        </div>
      }
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <div className="grid gap-3 py-1">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-3 grid gap-1.5">
              <span className="text-xs font-medium text-foreground">主机类型</span>
              <Field name="kind">
                <Segmented
                  options={[
                    { label: '远程 SSH', value: 'ssh' },
                    { label: '本地终端', value: 'local' }
                  ]}
                  block
                />
              </Field>
            </div>
            <div className="col-span-2 grid gap-1.5">
              <label htmlFor="ssh-name" className="text-xs font-medium text-foreground">名称</label>
              <Field name="name" rules={[{ required: true, message: '请填写名称' }]}>
                <Input
                  id="ssh-name"
                  placeholder={kind === 'ssh' ? '如：生产环境 Web 服务器' : '如：Git Bash'}
                />
              </Field>
            </div>
            <div className="col-span-1 grid gap-1.5">
              <span className="text-xs font-medium text-foreground">分组</span>
              <Field name="groupId">
                <Select
                  placeholder="未分组"
                  style={{ width: '100%' }}
                  options={[
                    { value: '', label: '未分组' },
                    ...sshGroups.map((g) => ({ value: g.id, label: g.name }))
                  ]}
                />
              </Field>
            </div>
          </div>

          {kind === 'ssh' ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 grid gap-1.5">
                  <label htmlFor="ssh-host" className="text-xs font-medium text-foreground">主机地址</label>
                  <Field name="host" rules={[sshRequired('请填写主机地址', form)]}>
                    <Input id="ssh-host" placeholder="ip 或域名" />
                  </Field>
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor="ssh-port" className="text-xs font-medium text-foreground">端口</label>
                  <Field name="port" rules={portRules}>
                    <InputNumber id="ssh-port" style={{ width: '100%' }} />
                  </Field>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1 grid gap-1.5">
                  <label htmlFor="ssh-user" className="text-xs font-medium text-foreground">用户名</label>
                  <Field name="username" rules={[sshRequired('请填写用户名', form)]}>
                    <Input id="ssh-user" />
                  </Field>
                </div>
                <div className="col-span-2 grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">认证方式</span>
                  <Field name="authType">
                    <Select options={AUTH_TYPE_OPTIONS} style={{ width: '100%' }} />
                  </Field>
                </div>
              </div>

              {authType === 'password' ? (
                <div className="grid gap-1.5">
                  <label htmlFor="ssh-password" className="text-xs font-medium text-foreground">密码</label>
                  <Field name="password">
                    <Input
                      id="ssh-password"
                      type="password"
                      placeholder={
                        isEdit && editing?.hasPassword ? '已保存（留空保持不变）' : '登录密码'
                      }
                    />
                  </Field>
                </div>
              ) : (
                <>
                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor="ssh-key" className="text-xs font-medium text-foreground">
                        私钥（PEM / OpenSSH 格式）
                      </label>
                      <Button
                        type="link"
                        size="small"
                        className="h-auto p-0 text-xs"
                        onClick={() => void handleImportKey()}
                      >
                        从文件导入
                      </Button>
                    </div>
                    <Field
                      name="privateKey"
                      rules={[
                        {
                          validator: (_r: unknown, value: unknown) =>
                            form.getFieldValue('kind') === 'ssh' &&
                            form.getFieldValue('authType') === 'privateKey' &&
                            !(isEdit && editing?.hasPrivateKey) &&
                            !String(value ?? '').trim()
                              ? Promise.reject(new Error('请粘贴私钥内容'))
                              : Promise.resolve()
                        }
                      ]}
                    >
                      <Input.TextArea
                        id="ssh-key"
                        rows={5}
                        className="no-scrollbar font-mono text-xs"
                        placeholder={
                          isEdit && editing?.hasPrivateKey
                            ? '已保存（留空保持不变）'
                            : '-----BEGIN OPENSSH PRIVATE KEY-----'
                        }
                      />
                    </Field>
                  </div>
                  <div className="grid gap-1.5">
                    <label htmlFor="ssh-passphrase" className="text-xs font-medium text-foreground">
                      私钥口令（可选）
                    </label>
                    <Field name="passphrase">
                      <Input
                        id="ssh-passphrase"
                        type="password"
                        placeholder={
                          isEdit && editing?.hasPassphrase ? '已保存（留空保持不变）' : ''
                        }
                      />
                    </Field>
                  </div>
                </>
              )}

              <div className="rounded-md border border-border/60 bg-secondary/20 p-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground">使用 Mosh（UDP 抗断线）</div>
                    <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                      断网 / 切网后会话自动恢复；远端需装 mosh-server，本地需 mosh-client（Windows 自动回退 WSL）
                    </div>
                  </div>
                  <Tooltip title={moshDisabledReason ?? undefined}>
                    <div>
                      <Field name="useMosh">
                        <Switch disabled={Boolean(moshDisabledReason)} />
                      </Field>
                    </div>
                  </Tooltip>
                </div>
                {useMosh && moshStatus && (
                  <p
                    className={cn(
                      'mt-2 break-all border-t border-border/60 pt-2 text-[11px] leading-4',
                      moshStatus.kind === 'none'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground'
                    )}
                  >
                    {moshStatus.kind === 'native'
                      ? `本地 mosh-client：${moshStatus.path}`
                      : moshStatus.kind === 'wsl'
                        ? `本地 mosh-client：WSL（${moshStatus.path}）`
                        : moshStatus.hint}
                  </p>
                )}
              </div>

              <Collapse
                ghost
                size="small"
                items={[
                  {
                    key: 'advanced',
                    label: '高级',
                    children: (
                      <div className="grid gap-3 pb-1">
                        <div className="grid gap-1.5">
                          <label className="text-xs font-medium text-foreground">跳板机</label>
                          <Tooltip title={jumpDisabledReason ?? undefined}>
                            <div>
                              <Field name="jumpProfileId">
                                <Select
                                  placeholder="直接连接（不使用跳板机）"
                                  style={{ width: '100%' }}
                                  options={jumpOptions}
                                  disabled={Boolean(useMosh)}
                                />
                              </Field>
                            </div>
                          </Tooltip>
                          <p className="text-[11px] leading-4 text-muted-foreground">
                            先连接跳板机，再由它转发到目标主机（等价 ssh -J），支持多级串联
                          </p>
                        </div>
                        <div className="grid gap-1.5">
                          <label className="text-xs font-medium text-foreground">
                            保活间隔（秒）
                          </label>
                          <Field
                            name="keepaliveInterval"
                            rules={[
                              {
                                type: 'number',
                                min: 5,
                                max: 300,
                                message: '保活间隔需为 5 - 300 秒'
                              }
                            ]}
                          >
                            <InputNumber
                              style={{ width: '100%' }}
                              min={5}
                              max={300}
                              placeholder="默认 15"
                            />
                          </Field>
                          <p className="text-[11px] leading-4 text-muted-foreground">
                            空闲时定期发送心跳，防止 NAT / 防火墙静默断链
                          </p>
                        </div>
                        {knownHost && (
                          <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-secondary/20 p-2.5">
                            <div className="min-w-0">
                              <div className="text-xs font-medium text-foreground">
                                主机指纹（SHA256）
                              </div>
                              <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-muted-foreground">
                                {knownHost.fingerprint}
                              </div>
                            </div>
                            <Button size="small" onClick={() => void handleResetHostKey()}>
                              重置
                            </Button>
                          </div>
                        )}
                      </div>
                    )
                  }
                ]}
              />
            </>
          ) : (
            <>
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">启动环境</span>
                <Field
                  name="shellId"
                  rules={[
                    {
                      validator: (_r: unknown, value: unknown) =>
                        form.getFieldValue('kind') === 'local' &&
                        !shells.some((s) => s.id === value)
                          ? Promise.reject(new Error('请选择启动环境'))
                          : Promise.resolve()
                    }
                  ]}
                >
                  <Select placeholder="选择启动环境" options={launchOptions} style={{ width: '100%' }} />
                </Field>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="local-auto-command" className="text-xs font-medium text-foreground">
                  自动执行命令（可选）
                </label>
                <Field name="autoCommand">
                  <Input
                    id="local-auto-command"
                    placeholder="终端启动后自动执行的命令，如 cd ~/project && ls"
                  />
                </Field>
              </div>
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </Form>
    </Modal>
  )
}
