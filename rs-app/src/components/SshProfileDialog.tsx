import { useEffect, useState } from 'react'
import type { HostKind, ShellProfile, SshAuthType, SshProfile } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import { Button, Input, Modal, Segmented, Select, message } from 'antd'

/** 认证方式下拉项 */
const AUTH_TYPE_OPTIONS = [
  { value: 'password', label: '密码' },
  { value: 'privateKey', label: '私钥' }
]

interface FormState {
  name: string
  /** 所属分组 id；空串 = 未分组 */
  groupId: string
  kind: HostKind
  // ---- 仅 ssh ----
  host: string
  port: string
  username: string
  authType: SshAuthType
  password: string
  privateKey: string
  passphrase: string
  // ---- 仅 local ----
  /** 选中的启动环境（检测到的 shell 的 id） */
  shellId: string
  /** 终端启动后自动执行的命令 */
  autoCommand: string
}

const EMPTY_FORM: FormState = {
  name: '',
  groupId: '',
  kind: 'ssh',
  host: '',
  port: '22',
  username: 'root',
  authType: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  shellId: '',
  autoCommand: ''
}

function toForm(profile: SshProfile | null | undefined): FormState {
  if (!profile) return { ...EMPTY_FORM }
  return {
    name: profile.name,
    groupId: profile.groupId ?? '',
    kind: profile.kind ?? 'ssh',
    host: profile.host,
    port: String(profile.port ?? 22),
    username: profile.username,
    authType: profile.authType,
    // 密钥类字段编辑时留空表示保留旧值
    password: '',
    privateKey: '',
    passphrase: '',
    shellId: '',
    autoCommand: profile.autoCommand ?? ''
  }
}

export function SshProfileDialog() {
  const sshDialog = useAppStore((s) => s.ui.sshDialog)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const connectHost = useAppStore((s) => s.connectHost)
  const sshGroups = useAppStore((s) => s.sshGroups)

  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 检测到的本地 shell（启动环境下拉选项） */
  const [shells, setShells] = useState<ShellProfile[]>([])
  // 关闭时 store 会把 editing 清空，但弹窗关闭动画期间组件仍挂载；
  // 沿用最近一次的 editing，避免 footer 在动画中闪现「保存并连接」按钮
  const [lastEditing, setLastEditing] = useState<SshProfile | null>(null)
  const editing = (sshDialog.open ? sshDialog.editing : lastEditing) ?? null
  const isEdit = Boolean(editing?.id)

  useEffect(() => {
    if (sshDialog.open) {
      setLastEditing(sshDialog.editing ?? null)
      const next = toForm(editing)
      // 从某个分组里点「+」新建时，预设分组
      if (!next.name && sshDialog.groupId) next.groupId = sshDialog.groupId
      setForm(next)
      setError(null)
      // 按需刷新本地 shell 列表（供「选择检测到的环境」下拉），并回填 / 预选启动环境
      void window.api.terminal.listShells().then((r) => {
        setShells(r.shells)
        setForm((f) => {
          // 编辑：按保存的命令回填匹配的 shell；新建：默认平台 shell
          const matched = editing?.kind === 'local'
            ? r.shells.find((s) => s.command === editing.command)
            : undefined
          if (matched) return { ...f, shellId: matched.id }
          if (!isEdit && f.kind === 'local') return { ...f, shellId: r.defaultId }
          return f
        })
      })
    }
  }, [sshDialog.open, sshDialog.groupId, editing])

  const patch = (partial: Partial<FormState>) => setForm((f) => ({ ...f, ...partial }))

  const handleSave = async (connectAfter: boolean) => {
    if (!form.name.trim()) {
      setError('请填写名称')
      return
    }
    if (form.kind === 'ssh') {
      if (!form.host.trim() || !form.username.trim()) {
        setError('请填写主机地址和用户名')
        return
      }
      if (form.authType === 'privateKey' && !isEdit && !form.privateKey.trim()) {
        setError('请粘贴私钥内容')
        return
      }
    } else {
      if (!shells.some((s) => s.id === form.shellId)) {
        setError('请选择启动环境')
        return
      }
    }
    setSaving(true)
    setError(null)
    try {
      const now = Date.now()
      // 本地启动环境：由选中的检测 shell 决定可执行文件与参数
      const localShell = shells.find((s) => s.id === form.shellId)
      const localCommand = localShell?.command
      const localArgs = localShell?.args
      const autoCommand =
        form.kind === 'local' ? form.autoCommand.trim() || undefined : undefined

      const payload: SshProfile = {
        id: editing?.id ?? '',
        kind: form.kind,
        groupId: form.groupId || undefined,
        // 颜色不在表单里维护，编辑时原样带回，避免保存时被清掉
        color: editing?.color,
        name: form.name.trim(),
        // ssh 专用字段；本地主机不填写（类型上必填，置空标记）
        host: form.kind === 'ssh' ? form.host.trim() : '',
        port: form.kind === 'ssh' ? Number(form.port) || 22 : 0,
        username: form.kind === 'ssh' ? form.username.trim() : '',
        authType: form.kind === 'ssh' ? form.authType : (editing?.authType ?? 'password'),
        // 留空传 undefined：主进程保留旧值
        password:
          form.kind === 'ssh' && form.password === ''
            ? undefined
            : form.kind === 'ssh'
              ? form.password
              : undefined,
        privateKey:
          form.kind === 'ssh' && form.privateKey === ''
            ? undefined
            : form.kind === 'ssh'
              ? form.privateKey.replace(/\r\n/g, '\n')
              : undefined,
        passphrase:
          form.kind === 'ssh' && form.passphrase === ''
            ? undefined
            : form.kind === 'ssh'
              ? form.passphrase
              : undefined,
        command: form.kind === 'local' ? localCommand : undefined,
        args: form.kind === 'local' ? localArgs : undefined,
        autoCommand: form.kind === 'local' ? autoCommand : undefined,
        createdAt: editing?.createdAt ?? now,
        updatedAt: now
      }
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

  const launchOptions = shells.map((s) => ({ value: s.id, label: s.name }))

  return (
    <Modal
      open={sshDialog.open}
      onCancel={() => setSshDialog(false, null)}
      title={isEdit ? '编辑主机' : '新建主机'}
      centered
      width={520}
      destroyOnHidden
      footer={
        <div className="flex justify-end gap-2">
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
      <div className="grid gap-3 py-1">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-3 grid gap-1.5">
            <span className="text-xs font-medium text-foreground">主机类型</span>
            <Segmented
              value={form.kind}
              onChange={(v) => patch({ kind: v as HostKind })}
              options={[
                { label: '远程 SSH', value: 'ssh' },
                { label: '本地终端', value: 'local' }
              ]}
              block
            />
          </div>
          <div className="col-span-2 grid gap-1.5">
            <label htmlFor="ssh-name" className="text-xs font-medium text-foreground">名称</label>
            <Input
              id="ssh-name"
              placeholder={form.kind === 'ssh' ? '如：生产环境 Web 服务器' : '如：Git Bash'}
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>
          <div className="col-span-1 grid gap-1.5">
            <span className="text-xs font-medium text-foreground">分组</span>
            <Select
              value={form.groupId}
              onChange={(v) => patch({ groupId: v })}
              placeholder="未分组"
              style={{ width: '100%' }}
              options={[
                { value: '', label: '未分组' },
                ...sshGroups.map((g) => ({ value: g.id, label: g.name }))
              ]}
            />
          </div>
        </div>

        {form.kind === 'ssh' ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 grid gap-1.5">
                <label htmlFor="ssh-host" className="text-xs font-medium text-foreground">主机地址</label>
                <Input
                  id="ssh-host"
                  placeholder="ip 或域名"
                  value={form.host}
                  onChange={(e) => patch({ host: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="ssh-port" className="text-xs font-medium text-foreground">端口</label>
                <Input
                  id="ssh-port"
                  type="number"
                  value={form.port}
                  onChange={(e) => patch({ port: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-1 grid gap-1.5">
                <label htmlFor="ssh-user" className="text-xs font-medium text-foreground">用户名</label>
                <Input
                  id="ssh-user"
                  value={form.username}
                  onChange={(e) => patch({ username: e.target.value })}
                />
              </div>
              <div className="col-span-2 grid gap-1.5">
                <span className="text-xs font-medium text-foreground">认证方式</span>
                <Select
                  value={form.authType}
                  onChange={(v) => patch({ authType: v as SshAuthType })}
                  options={AUTH_TYPE_OPTIONS}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            {form.authType === 'password' ? (
              <div className="grid gap-1.5">
                <label htmlFor="ssh-password" className="text-xs font-medium text-foreground">密码</label>
                <Input
                  id="ssh-password"
                  type="password"
                  placeholder={
                    isEdit && editing?.hasPassword ? '已保存（留空保持不变）' : '登录密码'
                  }
                  value={form.password}
                  onChange={(e) => patch({ password: e.target.value })}
                />
              </div>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <label htmlFor="ssh-key" className="text-xs font-medium text-foreground">
                    私钥（PEM / OpenSSH 格式）
                  </label>
                  <Input.TextArea
                    id="ssh-key"
                    rows={5}
                    className="no-scrollbar font-mono text-xs"
                    placeholder={
                      isEdit && editing?.hasPrivateKey
                        ? '已保存（留空保持不变）'
                        : '-----BEGIN OPENSSH PRIVATE KEY-----'
                    }
                    value={form.privateKey}
                    onChange={(e) => patch({ privateKey: e.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor="ssh-passphrase" className="text-xs font-medium text-foreground">
                    私钥口令（可选）
                  </label>
                  <Input
                    id="ssh-passphrase"
                    type="password"
                    placeholder={
                      isEdit && editing?.hasPassphrase ? '已保存（留空保持不变）' : ''
                    }
                    value={form.passphrase}
                    onChange={(e) => patch({ passphrase: e.target.value })}
                  />
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">启动环境</span>
              <Select
                value={form.shellId || undefined}
                placeholder="选择启动环境"
                onChange={(v) => patch({ shellId: v })}
                options={launchOptions}
                style={{ width: '100%' }}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="local-auto-command" className="text-xs font-medium text-foreground">
                自动执行命令（可选）
              </label>
              <Input
                id="local-auto-command"
                placeholder="终端启动后自动执行的命令，如 cd ~/project && ls"
                value={form.autoCommand}
                onChange={(e) => patch({ autoCommand: e.target.value })}
              />
            </div>
          </>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </Modal>
  )
}