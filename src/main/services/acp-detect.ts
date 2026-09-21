import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DetectedAcpAgent } from '@shared/types'

const execFileAsync = promisify(execFile)

/** 已知支持 ACP 的 CLI 及建议启动参数 */
const ACP_CANDIDATES: Array<{ name: string; command: string; args: string[] }> = [
  { name: 'Codex CLI', command: 'codex-acp', args: [] },
  { name: 'Codex CLI', command: 'codex', args: ['--acp'] },
  { name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
  { name: 'Claude Code', command: 'claude-agent-acp', args: [] },
  { name: 'GitHub Copilot CLI', command: 'copilot', args: ['--acp'] },
  { name: 'OpenCode', command: 'opencode', args: ['acp'] }
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
      path
    })
  }
  return found
}
