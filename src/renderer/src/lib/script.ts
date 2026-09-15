/**
 * 脚本内容转成终端输入：每行以回车键入，末尾再补一次回车以执行最后一行。
 * 终端是逐行执行的，因此不能整段一次性写入（多行会被当成一条命令）。
 */
export function scriptToTerminalInput(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\n/g, '\r') + '\r'
}
