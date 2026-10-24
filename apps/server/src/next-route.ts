/**
 * Next.js Route Handler → Hono 的适配层。
 *
 * `apps/server/src/api/**` 是从 Next 版（`app/api/**`）**整棵搬过来**的：
 * 每个 `route.ts` 导出的还是 `export async function GET(request, ctx)` 那套形状，
 * 业务代码一行没改。这里负责把它接到 Hono 上：
 *
 * - **URL 由目录结构推导**（`api/workspaces/[id]/files/read/route.ts` →
 *   `/api/workspaces/:id/files/read`），不需要维护一张手写的路由表；
 * - 真正的注册在 `app.ts` 里用 Vite 的 `import.meta.glob` **编译期**收集全部模块，
 *   所以新增一个 `route.ts` 不需要改任何装配代码；
 * - `ctx.params` 保持 Next 15+ 的 **Promise** 形状（`Promise<Record<string,string>>`），
 *   路由里 `const { id } = await ctx.params` 原样可用。
 *
 * 为什么不逐个改写成 `app.get('/x', (c) => …)`：87 个路由，每个都要把
 * `Response.json` / `ctx.params` / 各处 `Request` 用法重排一遍，收益只是「更像 Hono」，
 * 风险却是逐处手改引入回归。适配一层，业务零改动。
 */
import type { Hono } from 'hono'

/** 路径参数（Hono 与 Next 都是 `Record<string, string>`） */
export type RouteParams = Record<string, string>

/** 路由处理函数的第二个参数（与 Next 15+ 对齐：`params` 是 Promise） */
export interface RouteContext {
  params: Promise<RouteParams>
}

export type RouteHandler = (request: Request, context: RouteContext) => Response | Promise<Response>

/** 一个 `route.ts` 模块的导出形状 */
export interface RouteModule {
  GET?: RouteHandler
  POST?: RouteHandler
  PUT?: RouteHandler
  PATCH?: RouteHandler
  DELETE?: RouteHandler
  HEAD?: RouteHandler
  OPTIONS?: RouteHandler
}

/** 注册时按这个顺序探测模块导出了哪些方法 */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

/**
 * 把模块 key 变成 Hono 的路径模板。
 *
 * - `./api/auth/login/route.ts`          → `/api/auth/login`
 * - `./api/workspaces/[id]/route.ts`     → `/api/workspaces/:id`
 * - `./api/screenshots/[name]/route.ts`  → `/api/screenshots/:name`
 * - `./api/[...notfound]/route.ts`       → `/api/*`（Hono 的 catch-all）
 */
export function routePathFromModuleKey(key: string): string {
  const relative = key.replace(/^\.\//, '').replace(/\/route\.ts$/, '')
  const segments = relative.split('/').map((segment) => {
    // `[...name]`：Hono 里对应的写法就是 `*`（匹配剩余全部段）
    if (/^\[\.\.\..+\]$/.test(segment)) return '*'
    // `[name]`：动态段
    const param = /^\[(.+)\]$/.exec(segment)
    if (param) return `:${param[1]}`
    return segment
  })
  return `/${segments.join('/')}`
}

/**
 * 把一条路径按「具体 → 泛化」排序，**catch-all 永远排最后**。
 *
 * Hono 的路由器本身会给静态段更高优先级，这里排序只是再加一道保险：
 * 万一哪天真出现同层级的歧义，也不至于让 `/api/*` 把具体路由吞掉。
 */
export function compareRoutePaths(a: string, b: string): number {
  const aCatchAll = a.endsWith('*')
  const bCatchAll = b.endsWith('*')
  if (aCatchAll !== bCatchAll) return aCatchAll ? 1 : -1
  // 静态段多的排前面（`:id` 算「不具体」）
  const score = (p: string): number => p.split('/').filter((s) => s && !s.startsWith(':')).length
  return score(b) - score(a)
}

/**
 * 把一个 Next 风格的路由模块挂到 Hono 上。
 *
 * `request` 直接给 Hono 收到的那份底层 `Request`（`c.req.raw`）—— body 没被读过，
 * 路由里 `await request.json()` 照常可用。
 */
export function mountRouteModule(app: Hono, moduleKey: string, mod: RouteModule): void {
  const path = routePathFromModuleKey(moduleKey)
  for (const method of METHODS) {
    const handler = mod[method]
    if (typeof handler !== 'function') continue
    app.on(method, path, (c) => handler(c.req.raw, { params: Promise.resolve(c.req.param()) }))
  }
}
