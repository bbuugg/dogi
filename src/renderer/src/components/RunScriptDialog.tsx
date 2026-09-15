import { useEffect, useRef, useState } from 'react'
import { Loader2, Play, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAppStore } from '@/stores/app-store'

/** 保留当前选择；失效时用偏好值，再不行回退首项 */
function pickId(current: string, ids: string[], preferred?: string): string {
  if (current && ids.includes(current)) return current
  if (preferred && ids.includes(preferred)) return preferred
  return ids[0] ?? ''
}

/**
 * 运行脚本对话框（全局单例，由 ui.runScriptDialog 驱动）：
 * 选择脚本 + 选择主机，确认后连接该主机并在其上执行脚本
 * （脚本以终端输入的方式写入，执行过程在终端里可见）。
 */
export function RunScriptDialog() {
  const { open, scriptId } = useAppStore((s) => s.ui.runScriptDialog)
  const setRunScriptDialog = useAppStore((s) => s.setRunScriptDialog)
  const scripts = useAppStore((s) => s.scripts)
  const profiles = useAppStore((s) => s.profiles)
  const runScriptOnHost = useAppStore((s) => s.runScriptOnHost)
  const setSshDialog = useAppStore((s) => s.setSshDialog)

  const onOpenChange = (next: boolean): void => setRunScriptDialog(next, next ? scriptId : undefined)

  const [selectedScript, setSelectedScript] = useState('')
  const [selectedProfile, setSelectedProfile] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 预设脚本每次打开只应用一次，之后用户可自由改选 */
  const presetApplied = useRef(false)

  useEffect(() => {
    if (!open) {
      presetApplied.current = false
      return
    }
    const preferred = presetApplied.current ? undefined : scriptId
    presetApplied.current = true
    setError(null)
    setSelectedScript((cur) => pickId(cur, scripts.map((s) => s.id), preferred))
    setSelectedProfile((cur) => pickId(cur, profiles.map((p) => p.id)))
  }, [open, scriptId, scripts, profiles])

  const script = scripts.find((s) => s.id === selectedScript)
  const profile = profiles.find((p) => p.id === selectedProfile)
  const canRun = Boolean(script && profile) && !running

  const handleRun = async () => {
    if (!script || !profile) return
    setRunning(true)
    setError(null)
    try {
      const ok = await runScriptOnHost(profile, script)
      if (!ok) {
        setError('连接超时或主机未就绪，脚本未执行。')
        return
      }
      setRunScriptDialog(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>运行脚本</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label>脚本</Label>
            {scripts.length === 0 ? (
              <p className="text-xs text-muted-foreground">还没有脚本，请先在脚本管理页新增。</p>
            ) : (
              <Select value={selectedScript} onValueChange={setSelectedScript}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择脚本" />
                </SelectTrigger>
                <SelectContent>
                  {scripts.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>主机</Label>
            {profiles.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                还没有主机，请先添加 SSH 连接。
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      onOpenChange(false)
                      setSshDialog(true, null)
                    }}
                  >
                    <Plus className="size-4" /> 添加 SSH 连接
                  </Button>
                </div>
              </div>
            ) : (
              <Select value={selectedProfile} onValueChange={setSelectedProfile}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择主机" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}（{p.username}@{p.host}:{p.port}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {script && (
            <div className="grid gap-1.5">
              <Label>将执行</Label>
              <pre className="max-h-32 overflow-auto rounded-md border border-border/60 bg-secondary/40 p-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
                {script.content}
              </pre>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={running} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!canRun} onClick={() => void handleRun()}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {running ? '连接中…' : '连接并运行'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
