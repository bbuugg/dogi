/**
 * git 不可用时的「安装教程」弹窗。
 *
 * 触发点：侧栏「项目」分组标题右侧的红色告警图标（服务端探测到 git 不可用）。
 * 注意探测的是**服务端**机器（git 操作、建 worktree 都在服务端跑），
 * 所以教程里强调「在运行 Fizz 的那台机器上装」。
 */
import { ExternalLink } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@fizz/ui/dialog'
import { openExternal } from '@fizz/agent-client/web-host'
import type { GitStatus } from '@fizz/git'

const INSTALL_LINK = 'https://git-scm.com/downloads'

export function GitInstallDialog({
  open,
  onOpenChange,
  status
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 服务端探测结果（可能是 null，未探到时按不可用处理） */
  status: GitStatus | null
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>服务端未检测到 git</DialogTitle>
          <DialogDescription>
            {status?.error
              ? `${status.error}。`
              : 'Fizz 的源代码管理与 worktree 依赖服务端机器上的 git。'}
            请在<strong>运行 Fizz 的那台机器</strong>上安装 git，再重启服务。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            按你的服务端系统选一种安装方式（装完记得重启 Fizz 服务）：
          </p>
          <div className="space-y-2 rounded-md border border-border p-3">
            <div>
              <div className="font-medium">Windows</div>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  下载 Git for Windows 安装包（默认勾选「添加到 PATH」即可）：
                  <br />
                  <span className="font-mono text-xs">https://git-scm.com/download/win</span>
                </li>
                <li>
                  或用包管理器：<span className="font-mono text-xs">winget install Git.Git</span>
                </li>
              </ul>
            </div>
            <div>
              <div className="font-medium">macOS</div>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  <span className="font-mono text-xs">brew install git</span>
                </li>
                <li>
                  或装 Xcode 命令行工具：<span className="font-mono text-xs">xcode-select --install</span>
                </li>
              </ul>
            </div>
            <div>
              <div className="font-medium">Linux</div>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  Debian/Ubuntu：<span className="font-mono text-xs">sudo apt install git</span>
                </li>
                <li>
                  Fedora：<span className="font-mono text-xs">sudo dnf install git</span>
                </li>
                <li>
                  Arch：<span className="font-mono text-xs">sudo pacman -S git</span>
                </li>
              </ul>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            安装后可在终端执行 <span className="font-mono">git --version</span> 验证。
          </p>
        </div>

        <DialogFooter className="pt-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void openExternal(INSTALL_LINK)
            }}
          >
            <ExternalLink className="size-3.5" />
            打开 git 官网下载
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
