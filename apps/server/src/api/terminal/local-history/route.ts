/**
 * **宿主本机终端**（「主机与终端」里配的那条）的命令历史：**不挂项目**，全局一份，读写
 * `<FIZZ_DATA_DIR>/local-terminal-history.json`（见 `lib/server/terminal/history.ts`）。
 *
 * - GET    → `{ entries }`（最新在前）
 * - POST   body `{ cmd }` → 记录一条（终端回车时上报；去重置顶、超限丢尾部）
 * - DELETE `?cmd=<命令文本>` → 删单条；不带 `cmd` → 清空
 *
 * 三份历史互不相干（项目 / SSH / 宿主本机）：「主机与终端」是独立功能，它开出来的终端
 * 与任何项目都无关，所以既不能落项目 `.fizz/`，也不能和 SSH 那份混着预测。
 */
import { describeError, jsonError } from '@/app/api/_lib/auth'
import {
  addLocalTerminalHistory,
  clearLocalTerminalHistory,
  listLocalTerminalHistory,
  removeLocalTerminalHistory
} from '@/lib/server/terminal/history'
import type { TerminalHistoryData } from '@fizz/contracts/agent-api'

async function respond(): Promise<Response> {
  try {
    const data: TerminalHistoryData = { entries: await listLocalTerminalHistory() }
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
    await addLocalTerminalHistory(input.cmd)
    return respond()
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}

export async function DELETE(request: Request) {
  try {
    const cmd = new URL(request.url).searchParams.get('cmd')
    if (cmd) await removeLocalTerminalHistory(cmd)
    else await clearLocalTerminalHistory()
    return respond()
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
