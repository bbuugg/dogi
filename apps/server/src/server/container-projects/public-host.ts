/**
 * 公网入口的 **Host 解析**（纯函数、零依赖、可脱离 docker 直接测）。
 *
 * 单独一份而不塞进 `public-gateway.ts`：网关那半是「起监听器 + 反代 + 冷启动」，
 * 没有 docker / 没有端口就没法测；而「Host 字符串 → slug」的判定恰恰是这段路由里
 * 最该被逐例钉死的那一步（认错了 Host = 把工作台或别人的项目暴露出去）。
 */

/**
 * 从 Host 里取子域 slug；认不出返回 `null`。
 *
 * 只认**正好一层**子域（`^<slug>\.<域名>$`）。两条理由（spec §4.7）：
 * - **认不出的 Host 绝不能回落**（回落 = 把管理界面挂在公网域名上，任何人扫到就是入口）；
 * - 多级子域（`a.b.<域名>`）不认 —— 泛域名只该是一层，多认一层就是多一条可枚举面。
 *
 * `host` 可能带端口（`abc.example.com:8080`），先按 `:` 切掉端口；域名与 Host 都做
 * **大小写不敏感**比较（DNS 本来就不敏感）。slug 这里只做**形状**闸
 * （`[a-z0-9]{1,64}`）—— 命中与否最终由「服务端现算的项目索引」决定，正则不必与
 * `slug.ts` 的生成器严格耦合（生成器改长度不该让公网入口跟着失效）。
 */
export function parsePublicHost(host: string, domain: string): string | null {
  const bare = (host.split(':')[0] ?? '').trim().toLowerCase()
  const suffix = `.${domain.trim().toLowerCase().replace(/^\.+/, '')}`
  if (suffix === '.' || !bare.endsWith(suffix)) return null
  const label = bare.slice(0, -suffix.length)
  if (label.length === 0 || label.length > 64) return null
  return /^[a-z0-9]+$/.test(label) ? label : null
}

/**
 * 在**多个**配置域名里逐个别 `parsePublicHost`，命中就返回 `{ slug, domain }`，都不中返回 `null`。
 *
 * 独立公网端口上所有请求都归预览，所以这里既是「是不是预览」的判据、也是「用哪个域名认出来的」
 * 的判据（哪个域名命中不影响后续反代，只影响日志 / 调试）。域名清单每次现读（设置页改完立刻生效），
 * 所以这个函数是**无状态纯函数**，直接传进去即可。
 */
export function matchPublicDomain(
  host: string,
  domains: readonly string[]
): { slug: string; domain: string } | null {
  for (const domain of domains) {
    const slug = parsePublicHost(host, domain)
    if (slug) return { slug, domain }
  }
  return null
}
