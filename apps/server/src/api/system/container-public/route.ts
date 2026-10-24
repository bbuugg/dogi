/**
 * 容器型项目的**公网访问域名**：GET / POST `/api/system/container-public`。
 *
 * - GET  → `{ domains, wildcards, target, enabled }`
 * - POST → body `{ domains?: string[] }`（缺字段 = 保留原样；
 *   传空数组 = 清空 = 关闭公网访问）
 *
 * ## 为什么字段不叫 `settings`
 *
 * 设置页要显示的是「**现在实际生效**的东西」，不是盘上那串原值：
 * - `domains`：设置页里填的域名清单（可多个，空数组 = 关闭）；
 * - `wildcards`：`*.domain` 列表，DNS 里要加的那几条；
 * - `target`：解析目标建议（`FIZZ_PUBLIC_IP` 或本机第一个非回环 IPv4，可能没有）；
 * - `enabled`：**现在能不能真用**（配了域名 + 公网入口端口确实在监听）。
 *
 * ## 存盘后不需要重启
 *
 * 公网入口是独立监听器，`Host` → 项目 slug 的域名匹配是**每个请求现读**的
 * （见 `container-projects/public-gateway.ts`），所以改完立刻生效。
 * 前端快照里那份 `domains` 也是现读的（`containerProjectsSnapshot`），存盘后推一次刷新就同步。
 *
 * 鉴权由根 `app.ts` 的中间件统一兜底（`/api/*` 全走 JWT）。
 */
import {
  normalizePublicDomain,
  wildcardOf,
  type ContainerPublicSettings
} from '@fizz/contracts'
import { domain } from '@/lib/server/state'
import { parseJsonBody } from '@/app/api/_lib/auth'
import {
  publicDomainNames,
  publicGatewayEnabled
} from '@/lib/server/container-projects/lifecycle'
import { suggestedPublicTarget } from '@/lib/server/container-projects/public-gateway'

function view(): {
  domains: string[]
  wildcards: string[]
  target: string | null
  enabled: boolean
} {
  const domains = publicDomainNames()
  return {
    domains,
    wildcards: domains.map(wildcardOf),
    target: suggestedPublicTarget() ?? null,
    enabled: publicGatewayEnabled()
  }
}

export async function GET(): Promise<Response> {
  return Response.json(view())
}

export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody<{ domains?: unknown }>(request)
  const patch: Partial<ContainerPublicSettings> = {}
  if (body && 'domains' in body) {
    if (!Array.isArray(body.domains)) {
      return Response.json({ error: 'domains 必须是字符串数组' }, { status: 400 })
    }
    /*
     * 逐项校验：填了内容但归一化后为空 = 形状不对（少了点 / 带路径 / 带了别的东西）。
     * 这里必须**报错**而不是静默丢掉：静默会让用户看到「保存成功」却发现某个域名没生效，
     * 实际是输入不合法（归一化在 `normalizeContainerPublicSettings`）。
     * 空串 / 纯空白项直接忽略（用户清空某一行时不该报错）。
     */
    for (const item of body.domains) {
      if (typeof item !== 'string') {
        return Response.json({ error: '每个域名都必须是字符串' }, { status: 400 })
      }
      const raw = item.trim()
      if (raw && !normalizePublicDomain(raw)) {
        return Response.json(
          { error: `域名不合法：${raw}（只填主域，如 example.com，不要带 http://、路径或端口）` },
          { status: 400 }
        )
      }
    }
    patch.domains = body.domains as string[]
  }
  domain.saveContainerPublicSettings(patch)
  return Response.json(view())
}
