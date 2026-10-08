/**
 * 「从 Git 克隆一个新工作区」弹窗（移植自 fishwork 的 `GitCloneDialog.tsx` + `clone.ts` 的 UI 侧）。
 *
 * 与「选择已有目录」并列为新建工作区的第二条入口：填地址 → 自动推目录名 → 选目标父目录 →
 * 克隆成功后**自动建工作区**并打开它。
 *
 * 安全边界在主进程（`services/git.ts` 的 `assertSafeRepoUrl` + `clone -- <url> <dir>`）：
 * 弹窗只负责收集输入与展示进度，**不自己判断地址合法性**（渲染端校验等于两道都要维护）。
 *
 * 刻意不做的事：
 * - **不代跑安装 / 不代填凭据**：私钥与凭据交互仍由用户自己的 git 环境负责（见 4.30 的纪律）。
 * - **不覆盖已有目录**：目标存在就直接报错（主进程拦），不做「合并进去」的选项。
 */
import { useEffect, useState } from 'react'
import { Button, Input, Modal, Progress, message } from 'antd'
import { Folder as FolderIcon } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'

/** 从仓库地址推目录名（与主进程 `repoNameFromUrl` 同口径，这里只是回填输入框，用户可改） */
function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  return cleaned.split(/[/:]/).filter(Boolean).pop() ?? ''
}

/** 打开时给个能直接用的默认值：目标父目录给用户主目录（拿不到就留空让用户自己选） */
async function defaultParent(): Promise<string> {
  try {
    const info = await window.api.app.info()
    return info.homeDir ?? ''
  } catch {
    return ''
  }
}

export function GitCloneDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const saveAgentWorkspace = useAppStore((s) => s.saveAgentWorkspace)
  const selectAgentWorkspace = useAppStore((s) => s.selectAgentWorkspace)
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState('')
  const [dirName, setDirName] = useState('')
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  /** 已完成的阶段（0–100）：git clone 只吐 stderr，粒度只能粗分成这几段 */
  const [progress, setProgress] = useState(0)

  // 打开时给个能直接用的默认值：URL 推目录名、目标父目录给用户主目录
  useEffect(() => {
    if (!open) return
    setUrl('')
    setDirName('')
    setProgress(0)
    setBusy(false)
    let cancelled = false
    void defaultParent().then((p) => {
      if (!cancelled) setParent(p)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const pickParent = async (): Promise<void> => {
    if (picking) return
    setPicking(true)
    try {
      const { canceled, filePaths } = await window.api.dialog.open({ properties: ['openDirectory'] })
      if (!canceled && filePaths[0]) setParent(filePaths[0])
    } catch (err) {
      message.error(`选择目录失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPicking(false)
    }
  }

  const canSubmit = url.trim().length > 0 && parent.trim().length > 0 && dirName.trim().length > 0

  const submit = async (): Promise<void> => {
    if (!canSubmit || busy) return
    setBusy(true)
    setProgress(8)
    // 克隆可能几分钟；进度条只表示「在跑」——git 的进度写 stderr 且格式不保证，
    // 硬解析出来的数字反而会骗人（见 4.30 的网络动作纪律）
    const timer = setInterval(() => setProgress((p) => Math.min(p + 3, 92)), 700)
    try {
      const dest = joinPath(parent.trim(), dirName.trim())
      const cloned = await window.api.git.clone(url.trim(), dest)
      clearInterval(timer)
      setProgress(100)
      // 克隆出来的目录名就是工作区名（用户可以在侧边栏改）
      const name = dirName.trim()
      await saveAgentWorkspace({ name, path: cloned })
      const list = await window.api.agent.listWorkspaces()
      selectAgentWorkspace(list.find((w) => w.path === cloned)?.id ?? '')
      message.success(`已克隆并添加工作区「${name}」`)
      onClose()
    } catch (err) {
      clearInterval(timer)
      setProgress(0)
      message.error(`克隆失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={busy ? undefined : onClose}
      title="从 Git 克隆新工作区"
      onOk={() => void submit()}
      okText="克隆并添加"
      confirmLoading={busy}
      okButtonProps={{ disabled: !canSubmit }}
      destroyOnHidden
    >
      <div className="flex flex-col gap-3 pt-1">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">仓库地址</span>
          <Input
            placeholder="https://github.com/owner/repo.git 或 git@github.com:owner/repo.git"
            value={url}
            disabled={busy}
            onChange={(e) => {
              setUrl(e.target.value)
              // 目录名跟着地址走，但**不覆盖用户已经改过的**（只在还是推出来的那个名字时跟）
              const guess = repoNameFromUrl(e.target.value)
              if (guess) setDirName((prev) => (prev === '' || prev === guess ? guess : prev))
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">克隆到</span>
          <div className="flex items-center gap-1.5">
            <Input
              placeholder="目标父目录的绝对路径"
              value={parent}
              disabled={busy}
              onChange={(e) => setParent(e.target.value)}
            />
            <Button icon={<FolderIcon className="size-3.5" />} disabled={busy} onClick={() => void pickParent()}>
              选择
            </Button>
          </div>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">目录名（同时作为工作区名）</span>
          <Input value={dirName} disabled={busy} onChange={(e) => setDirName(e.target.value)} />
        </label>
        {busy && <Progress percent={progress} size="small" status="active" />}
        <p className="text-xs text-muted-foreground/70">
          目标目录必须不存在；克隆到已有目录不会提示合并。
          私有仓库的凭据走你自己的 git（SSH agent / credential helper），这里不代填。
        </p>
      </div>
    </Modal>
  )
}

/** 拼路径：父目录结尾没有分隔符时补一个（Windows 与 POSIX 的分隔符都兼容） */
function joinPath(parent: string, name: string): string {
  return /[\\/]$/.test(parent) ? `${parent}${name}` : `${parent}/${name}`
}
