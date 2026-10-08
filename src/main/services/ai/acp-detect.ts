import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AcpAgentType, DetectedAcpAgent } from '@shared/types'

const execFileAsync = promisify(execFile)

/**
 * 已知支持 ACP 的 CLI 及建议启动参数。
 *
 * `type` 只在**一眼认得出来**的候选上给（opencode / pi）：探测结果直接带着它进配置，
 * 用户不用再手动选一次「风格」；其余留空 = 通用。它只是界面标识，不影响会话行为
 * （见 `AcpAgentType`）。
 */
const ACP_CANDIDATES: Array<{
  name: string
  command: string
  args: string[]
  type?: AcpAgentType
}> = [
  { name: 'Codex CLI', command: 'codex-acp', args: [] },
  { name: 'Codex CLI', command: 'codex', args: ['--acp'] },
  { name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
  { name: 'Claude Code', command: 'claude-agent-acp', args: [] },
  { name: 'GitHub Copilot CLI', command: 'copilot', args: ['--acp'] },
  { name: 'OpenCode', command: 'opencode', args: ['acp'], type: 'opencode' },
  // pi 本体（`pi`）不带 ACP 模式（它的 --mode 只有 text/json/rpc），ACP 能力由独立的
  // 适配器 `pi-acp` 提供（该适配器自己 spawn `pi --mode rpc`）。所以这里探的是适配器，
  // 不是 `pi` 本身。装法：`npm i -g pi-acp`。
  { name: 'Pi', command: 'pi-acp', args: [], type: 'pi' }
]

const isWindows = process.platform === 'win32'

async function resolveCommand(command: string): Promise<string | null> {
  try {
    const { stdout } = isWindows
      ? await execFileAsync('where.exe', [command], { windowsHide: true })
      : await execFileAsync('which', [command])
    const line = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean)
    return line ?? null
  } catch {
    return null
  }
}

/** 扫描 PATH，返回本机已安装的已知 ACP agent（按候选顺序去重） */
export async function detectInstalledAcpAgents(): Promise<DetectedAcpAgent[]> {
  const found: DetectedAcpAgent[] = []
  const seen = new Set<string>()
  for (const candidate of ACP_CANDIDATES) {
    const path = await resolveCommand(candidate.command)
    if (!path || seen.has(candidate.command)) continue
    seen.add(candidate.command)
    found.push({
      name: candidate.name,
      command: candidate.command,
      args: candidate.args,
      path,
      // 认得出来就带上风格（加进配置时直接落库，见 AcpAgentSettings.addDetected）
      type: candidate.type
    })
  }
  return found
}
