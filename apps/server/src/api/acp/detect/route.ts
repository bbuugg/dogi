/**
 * 扫 PATH 上已装的 ACP agent（只读探测，给设置页「一键添加」用）。
 * GET /api/acp/detect
 */
import { spawn } from 'node:child_process'
import type { DetectedAcpAgent } from '@fizz/contracts/agent-api'

const ACP_CANDIDATES: Array<Omit<DetectedAcpAgent, 'path'>> = [
  { name: 'Codex CLI', command: 'codex-acp', args: [] },
  { name: 'Codex', command: 'codex', args: ['--acp'] },
  { name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
  { name: 'Claude Agent', command: 'claude-agent-acp', args: [] },
  { name: 'Copilot', command: 'copilot', args: ['--acp'] },
  { name: 'opencode', command: 'opencode', args: ['acp'] },
  { name: 'Pi', command: 'pi-acp', args: [] }
]

function probePath(command: string): Promise<string | null> {
  const isWin = process.platform === 'win32'
  return new Promise((resolve) => {
    const child = spawn(isWin ? 'where' : 'which', [command], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      const first = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      resolve(code === 0 && first ? first : null)
    })
  })
}

export async function GET() {
  const found: DetectedAcpAgent[] = []
  for (const candidate of ACP_CANDIDATES) {
    const path = await probePath(candidate.command)
    if (path) found.push({ ...candidate, path })
  }
  return Response.json(found)
}
