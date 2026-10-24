import { domain } from '@/lib/server/state'
import { jsonError } from '@/app/api/_lib/auth'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    domain.deleteModel(id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonError(400, message)
  }
  return Response.json(domain.listModels())
}
