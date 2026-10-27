"use client";

/**
 * 命令面板里「运行脚本」的目标判定。
 *
 * ## 两条入口，两种语义
 *
 * 同样是「跑一个脚本」，从哪发起决定了用户期待什么：
 *
 * - **命令面板**（Ctrl/Cmd+Shift+P → 运行脚本 → 选中某个脚本）：这是「顺手跑一下」，
 *   用户正盯着一台主机的终端，脚本就该**在那条终端里立刻跑**。此时再弹一个「选主机」的
 *   对话框纯属多余 —— 屏幕上的 View 已经把目标说清楚了。
 * - **脚本清单**（主机侧栏 → 脚本 → 卡片上的运行）：这是「我在管这批脚本」，目标主机要
 *   用户自己指定、执行过程要有一块干净的现场，所以照旧弹对话框、照旧**新开一条终端标签**
 *   （= 新建一条连接）。见 `RunScriptDialog.tsx`。
 *
 * 本文件只管前者：**当前视图是不是一条终端**。
 *
 * ## 为什么读 `panel-store` 而不是登记表里的 `activeTabKey`
 *
 * 登记表的 `activeTabKey` 是 `TerminalPanel` 在「可见」时**自报**的，隐藏时**不会清空**
 * （见 `terminal-registry.ts` 的 `setActiveTerminal`）—— 用户从终端切到会话后它还停在那条
 * 终端上。而这个判定的条件是「我现在看着的是不是终端」，必须用面板状态的真值
 * （`panel-store` 的 `activeTabKey()` = 焦点组当前显示的那一格）。
 *
 * ## 落空时**不吞掉**操作
 *
 * 当前视图不是终端（会话 / 设置 / SFTP…）时，退回原来的行为：弹对话框让用户选主机。
 * 这样「命令面板跑脚本」在任何视图下都可用，只是窄了一档。
 */
import { toast } from 'sonner'
import { scriptToTerminalInput } from '@fizz/agent-kit/features/scripts/script'
import { isTouchOnlyInput } from '@fizz/agent-kit/shared/hooks/useVirtualKeyBar'
import { hostIdOfTabKey } from '@fizz/agent-kit/shared/lib/panel-tabs'
import { activeTabKey } from '@fizz/agent-kit/shared/lib/panel-store'
import { openRunScriptDialog } from '@fizz/agent-kit/shared/lib/script-run'
import {
  focusTerminal,
  liveTerminal,
  type TerminalHandle
} from '@fizz/agent-kit/shared/lib/terminal/terminal-registry'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** 就地执行的结果：写进去了 / 退回了对话框 / 写失败 */
export type RunScriptOutcome = 'inline' | 'dialog' | 'error'

/**
 * 命令面板退场后再补一次焦点的时间（毫秒）。
 *
 * `DialogContent` 的退场是 `duration-100`（见 `packages/ui/src/dialog.tsx`），Radix 在动画
 * 结束、内容卸载时才把焦点还给「打开前的元素」。留一帧余量即可，不必更久。
 */
const FOCUS_AFTER_DIALOG_MS = 160

/**
 * 把焦点还给终端 —— 脚本是「写进去执行」的，跑完光标该回到用户手上，接着敲命令不用先点一下。
 *
 * **两拍**是必要的：命令面板是 Radix 对话框，它关闭时会把焦点还给打开前那个元素，而那一步
 * 发生在退场动画之后。立刻落一次只覆盖「打开面板前焦点就在终端里」的情形；用户只是点了下
 * 标签、焦点还在 body 上时，第二拍才作数。
 *
 * **只有手指可用的设备不抢焦点**：手机 / 平板上 focus 到 xterm 的隐藏 textarea 就等于弹出
 * 软键盘，而用户多半是刚把键盘收起来才去开的命令面板；何况这时候要看的是脚本输出。
 * 判据与终端底部那条虚拟键条同源（`(hover: none), (pointer: coarse)`）。
 */
function focusAfterRun(tabKey: string): void {
  if (isTouchOnlyInput()) return
  focusTerminal(tabKey)
  window.setTimeout(() => focusTerminal(tabKey), FOCUS_AFTER_DIALOG_MS)
}

/**
 * 当前视图若是**一条可写的终端**（SSH 或本机终端，容器工作台除外）→ 返回它的句柄。
 *
 * `tabKey` 不传就取面板的当前标签；显式给一个 key 只是为了让判定与「当前标签」解耦
 * （排查时能直接问「这个标签能不能写」）。
 */
export function activeTerminalView(tabKey: string | null = activeTabKey()): TerminalHandle | null {
  return liveTerminal(tabKey)
}

/**
 * 命令面板选中脚本：**当前视图是终端就地执行**，否则退回对话框。
 *
 * 就地执行**不切标签、不开标签、不重连** —— 用户已经在那条终端里，写进去就是「接着用」，
 * 连接、登录态、环境变量、当前目录全都保持原样。
 */
export function runScriptFromPalette(app: AgentApp, scriptId: string): RunScriptOutcome {
  const script = app.scripts.find((s) => s.id === scriptId)
  const view = script ? activeTerminalView() : null
  if (!script || !view) {
    openRunScriptDialog(scriptId)
    return 'dialog'
  }
  try {
    view.write(scriptToTerminalInput(script.content))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    toast.error(`运行失败：${msg}`)
    return 'error'
  }
  // 标签名要给人看：SSH 标签的 `title` 是 `SSH <hostId>`（见 `TerminalPanel` 的登记），
  // 所以优先用主机清单里的名字，取不到（本机终端 / 主机已被删掉）再退回登记表的标题。
  const hostId = hostIdOfTabKey(view.tabKey)
  const hostName = (hostId && app.sshHosts.find((h) => h.id === hostId)?.name) || view.title
  toast.success(`已在「${hostName}」的终端里执行「${script.name}」`)
  focusAfterRun(view.tabKey)
  return 'inline'
}
