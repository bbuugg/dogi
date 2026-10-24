/**
 * 界面语言（全局一份）：GET / POST `/api/system/language`。
 *
 * 与 `/api/system/settings` 分开：那条是监控采样开关，这条是语言。两者都不该因为
 * 对方加字段而改形状。鉴权由根 `app.ts` 的中间件统一兜底。
 */
import type { AppLanguage } from '@fizz/contracts'
import { normalizeLanguage } from '@fizz/contracts'
import { domain } from '@/lib/server/state'
import { setLanguage } from '@fizz/i18n'
import { parseJsonBody } from '@/app/api/_lib/auth'

export async function GET(): Promise<Response> {
  return Response.json({ language: domain.getLanguage() })
}

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<{ language?: AppLanguage }>(request)
  const language = domain.saveLanguage(normalizeLanguage(body?.language))
  // 让同一进程内的工具构建 / 提示词立刻用上新语言（下一轮生效）
  setLanguage(language)
  return Response.json({ language })
}
