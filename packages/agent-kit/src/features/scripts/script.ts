/**
 * 脚本内容转成终端输入：每行以回车键入，末尾再补一次回车以执行最后一行。
 * 终端是逐行执行的，因此不能整段一次性写入（多行会被当成一条命令）。
 *
 * 实现已抽到 `shared/lib/terminal-input.ts`（工作区快捷功能的命令也用它，两份共用一份）——
 * 照搬 dogi 的同名函数：先把 CRLF 收敛成 LF，再把每个 LF 换成裸回车 `\r`，末尾补一个 `\r`。
 */
import { toTerminalInput } from '@fizz/agent-kit/shared/lib/terminal-input'

export function scriptToTerminalInput(content: string): string {
  return toTerminalInput(content)
}
