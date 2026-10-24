/**
 * 「多行文本 → 终端输入」的唯一实现（运行脚本、工作区快捷功能的命令共用一份）。
 *
 * ⚠️ 行分隔符必须是**裸回车 CR（`\r`）**，不能是 LF（`\n`）：
 * PowerShell 的 PSReadLine 把 LF 绑成「在当前行**上方**插入一行」，
 * 于是一段 `a\nb\nc` 会被堆成 `c / b / a` 再执行 —— 顺序**整个反过来**。
 *
 * 实测（向 ConPTY 写同一段内容，只改分隔符）：
 * - `echo AAA\necho BBB\necho CCC\r` → 回显 `echo CCC` / `>> echo BBB` / `>> echo AAA`，
 *   执行顺序 **CCC、BBB、AAA**（反的）；
 * - `echo AAA\recho BBB\recho CCC\r` → 顺序 **AAA、BBB、CCC**（正确）。
 *
 * 所以这里先把 CRLF 收敛成 LF（Windows 上编辑过的文本常带 `\r\n`，不收敛会被拆成两个回车、
 * 多出一次空回车），再把每个 LF 换成裸回车 CR，末尾补一个 CR 让**最后一行**也回车执行
 * （否则最后一条命令会停在提示符里不跑）。
 */
export function toTerminalInput(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\n/g, '\r') + '\r'
}
