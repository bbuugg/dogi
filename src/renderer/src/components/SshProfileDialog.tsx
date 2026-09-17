import { useEffect, useState } from 'react'
import type { SshAuthType, SshProfile } from '@shared/types'
import { useAppStore } from '@/stores/app-store'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface FormState {
  name: string
  host: string
  port: string
  username: string
  authType: SshAuthType
  password: string
  privateKey: string
  passphrase: string
}

const EMPTY_FORM: FormState = {
  name: '',
  host: '',
  port: '22',
  username: 'root',
  authType: 'password',
  password: '',
  privateKey: '',
  passphrase: ''
}

function toForm(profile: SshProfile | null | undefined): FormState {
  if (!profile) return { ...EMPTY_FORM }
  return {
    name: profile.name,
    host: profile.host,
    port: String(profile.port ?? 22),
    username: profile.username,
    authType: profile.authType,
    // 密钥类字段编辑时留空表示保留旧值
    password: '',
    privateKey: '',
    passphrase: ''
  }
}

export function SshProfileDialog() {
  const sshDialog = useAppStore((s) => s.ui.sshDialog)
  const setSshDialog = useAppStore((s) => s.setSshDialog)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const connectSsh = useAppStore((s) => s.connectSsh)

  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 关闭时 store 会把 editing 清空，但 Radix 关闭动画期间组件仍挂载；
  // 沿用最近一次的 editing，避免 footer 在动画中闪现「保存并连接」按钮
  const [lastEditing, setLastEditing] = useState<SshProfile | null>(null)
  const editing = (sshDialog.open ? sshDialog.editing : lastEditing) ?? null
  const isEdit = Boolean(editing?.id)

  useEffect(() => {
    if (sshDialog.open) {
      setLastEditing(sshDialog.editing ?? null)
      setForm(toForm(editing))
      setError(null)
    }
  }, [sshDialog.open, editing])

  const patch = (partial: Partial<FormState>) => setForm((f) => ({ ...f, ...partial }))

  const handleSave = async (connectAfter: boolean) => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setError('请填写名称、主机地址和用户名')
      return
    }
    if (form.authType === 'privateKey' && !isEdit && !form.privateKey.trim()) {
      setError('请粘贴私钥内容')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const now = Date.now()
      const payload: SshProfile = {
        id: editing?.id ?? '',
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        authType: form.authType,
        // 留空传 undefined：主进程保留旧值
        password: form.password === '' ? undefined : form.password,
        privateKey:
          form.privateKey === ''
            ? undefined
            : form.privateKey.replace(/\r\n/g, '\n'),
        passphrase: form.passphrase === '' ? undefined : form.passphrase,
        createdAt: editing?.createdAt ?? now,
        updatedAt: now
      }
      await window.api.ssh.save(payload)
      await refreshProfiles()
      setSshDialog(false, null)
      toast.success(isEdit ? 'SSH 连接已更新' : 'SSH 连接已添加')
      if (connectAfter) {
        const profiles = await window.api.ssh.list()
        const saved = profiles.find((p) => p.name === payload.name && p.host === payload.host)
        if (saved) {
          void connectSsh(saved).catch((e) => {
            toast.error('连接失败', { description: e instanceof Error ? e.message : String(e) })
          })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error('保存失败', { description: msg })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={sshDialog.open} onOpenChange={(open) => setSshDialog(open, null)}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑 SSH 连接' : '新建 SSH 连接'}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-3 grid gap-1.5">
              <Label htmlFor="ssh-name">名称</Label>
              <Input
                id="ssh-name"
                placeholder="如：生产环境 Web 服务器"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div className="col-span-2 grid gap-1.5">
              <Label htmlFor="ssh-host">主机地址</Label>
              <Input
                id="ssh-host"
                placeholder="ip 或域名"
                value={form.host}
                onChange={(e) => patch({ host: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-port">端口</Label>
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
              <Label htmlFor="ssh-user">用户名</Label>
              <Input
                id="ssh-user"
                value={form.username}
                onChange={(e) => patch({ username: e.target.value })}
              />
            </div>
            <div className="col-span-2 grid gap-1.5">
              <Label>认证方式</Label>
              <Select
                value={form.authType}
                onValueChange={(v) => patch({ authType: v as SshAuthType })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">密码</SelectItem>
                  <SelectItem value="privateKey">私钥</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {form.authType === 'password' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-password">密码</Label>
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
                <Label htmlFor="ssh-key">私钥（PEM / OpenSSH 格式）</Label>
                <Textarea
                  id="ssh-key"
                  rows={5}
                  className="font-mono text-xs"
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
                <Label htmlFor="ssh-passphrase">私钥口令（可选）</Label>
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

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => setSshDialog(false, null)}>
            取消
          </Button>
          <Button variant="secondary" disabled={saving} onClick={() => void handleSave(false)}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存
          </Button>
          {!isEdit && (
            <Button disabled={saving} onClick={() => void handleSave(true)}>
              保存并连接
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
