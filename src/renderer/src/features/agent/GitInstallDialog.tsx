/**
 * 「这台机器没装 git」的引导弹窗（移植自 fishwork 的 `GitInstallDialog.tsx`）。
 *
 * 为什么需要它：面板的 git 功能全是 spawn 出来的 git，没装时**探测得到**（`gitVersion()`
 * 看退出码），但只显示「这个工作区还不是 git 仓库」会把用户引向错误的结论 ——
 * 真实原因是「你机器上根本没有 git」，那是装一次就好的事，不该让人以为要去 init 仓库。
 * 所以：`isRepo === false` 时先问一次装没装，没装就把这个弹窗顶上来。
 *
 * 只给**安装方式**（各平台一条能直接复制执行的命令）与官网链接，不代跑安装 ——
 * 装 git 是改系统的事，必须是用户自己敲的那一条命令。
 */
import { Button, Modal } from 'antd'

const INSTALL_LINK = 'https://git-scm.com/downloads'

/** 各平台一条能直接复制执行的命令；macOS 的 Homebrew 在前面，Windows 两种都给 */
const COMMANDS: { os: string; items: string[] }[] = [
  {
    os: 'Windows',
    items: [
      '装 Git for Windows（安装向导默认就会把 git 加进 PATH，装完重开 Dogi 即可）：\nhttps://git-scm.com/download/win',
      '或者用 winget：winget install Git.Git'
    ]
  },
  { os: 'macOS', items: ['brew install git'] },
  {
    os: 'Linux',
    items: [
      'Debian / Ubuntu：sudo apt install git',
      'Fedora / RHEL：sudo dnf install git',
      'Arch：sudo pacman -S git'
    ]
  }
]

export function GitInstallDialog({
  open,
  onClose,
  detected
}: {
  open: boolean
  onClose: () => void
  /** 探测结果里的错误串（spawn 的 ENOENT 之类），有就显示出来帮用户判断 */
  detected: string | null
}) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="未检测到 git"
      okText="我已安装，重新检测"
      onOk={onClose}
      cancelButtonProps={{ style: { display: 'none' } }}
      width={520}
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          {detected ? `${detected}。` : ''}
          Dogi 的「源代码管理」面板依赖系统里的 git 可执行文件。
          按下面任意一种方式装好，**重开 Dogi**（或点下面按钮重新检测）就能用了。
        </p>
        {COMMANDS.map((group) => (
          <div key={group.os} className="rounded-md border border-border p-3">
            <div className="mb-1 font-medium">{group.os}</div>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
              {group.items.map((line) => (
                <li key={line} className="whitespace-pre-wrap">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="text-xs text-muted-foreground/70">
          装完在终端里敲 <code className="font-mono">git --version</code> 能出版本号就成了。
        </p>
        <Button
          size="small"
          className="self-start"
          onClick={() => {
            void window.api.app.openExternal(INSTALL_LINK)
          }}
        >
          打开 git 官网下载页
        </Button>
      </div>
    </Modal>
  )
}
