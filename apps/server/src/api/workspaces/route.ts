import type { WorkspaceInput } from '@fizz/contracts/agent-api'
import { domain } from '@/lib/server/state'
import { describeError, jsonError, parseJsonBody } from '@/app/api/_lib/auth'

export async function GET() {
  return Response.json(domain.listWorkspaces())
}

export async function POST(request: Request) {
  const input = await parseJsonBody<WorkspaceInput>(request)
  if (!input) return jsonError(400, '请求体不是合法 JSON')
  try {
    return Response.json(await domain.addWorkspace(input))
  } catch (err) {
    const { status, message } = describeError(err)
    return jsonError(status, message)
  }
}
