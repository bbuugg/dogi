/**
 * SSH 主机终端的命令历史：**不挂项目**，全局一份，读写
 * `<FIZZ_DATA_DIR>/ssh-terminal-history.json`（见 `lib/server/terminal/history.ts`）。
 *
 * - GET    → `{ entries }`（最新在前）
 * - POST   body `{ cmd }` → 记录一条（终端回车时上报；去重置顶、超限丢尾部）
 * - DELETE `?cmd=<命令文本>` → 删单条；不带 `cmd` → 清空
 *
 * 与 `/api/workspaces/:id/terminal-history`（按项目）是两份独立数据：SSH 过去的是另一台
 * 机器，命令与本地项目不是一回事，所有主机终端共享这一份。
 */
import { describeError, jsonError } from '@/app/api/_lib/auth'
import {
  addSshTerminalHistory,
  clearSshTerminalHistory,
  listSshTerminalHistory,
  removeSshTerminalHistory
} from '@/lib/server/terminal/history'
import type { TerminalHistoryData } from '@fizz/contracts/agent-api'

async function respond(): Promise<Response> {
  try {
    const data: TerminalHistoryData = { entries: await listSshTerminalHistory() }
    return Response.json(data)
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function GET() {
  return respond()
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as { cmd?: unknown }
    if (typeof input?.cmd !== 'string') return jsonError(400, '缺少 cmd')
    await addSshTerminalHistory(input.cmd)
    return respond()
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function DELETE(request: Request) {
  try {
    const cmd = new URL(request.url).searchParams.get('cmd')
    if (cmd) await removeSshTerminalHistory(cmd)
    else await clearSshTerminalHistory()
    return respond()
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}