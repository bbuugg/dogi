/**
 * 终端 WebSocket 端点：`/api/terminal`（本机 PTY）。
 *
 * 为什么不进 Hono 路由：对话是单向流所以走 SSE（Hono 里现成），终端必须双向
 * （键盘输入要往回写），当前装的 @hono/node-server 没有 WS 适配子路径，
 * 直接用 `ws` 的 noServer 模式吃 `upgrade` 事件最省事 —— Hono 本体照旧只管 HTTP。
 *
 * ⚠️ 这里**不自己挂 `server.on('upgrade')`**：服务端有多个 WS 端点（终端、节点日志…），
 * 各自挂监听器会同时收到同一个升级请求，把「不是自己路径」的连接 destroy 掉，
 * 结果谁也连不上。统一由 `../ws.ts` 的 `attachWebSockets()` 分流后再调
 * `handleTerminalUpgrade()`。
 *
 * 协议分发、心跳、清场都在 `./channel.ts`（两条终端通道共用一份，见那里的注释）；
 * 这个文件只负责「本机 PTY 会话怎么建」：shell / args / cwd / 容器型项目。
 */
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { domain } from '../state'
import { containerNameOf } from '../container-projects/root'
import { handleTerminalChannel, type TerminalChannelSession } from './channel'
import { openTerminalSession } from './pty'

/**
 * 解析 `?args=`（JSON 字符串数组）。只认「字符串数组」这一种形状，
 * 坏 JSON / 非数组 / 混进非字符串项一律当没传 —— 一个坏参数不该让开终端整个失败。
 */
function parseArgsParam(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return undefined
    const args = parsed.filter((a): a is string => typeof a === 'string')
    return args.length ? args : undefined
  } catch {
    return undefined
  }
}

export function handleTerminalUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  auth = true
): void {
  const cols = Number(url.searchParams.get('cols') ?? 80)
  const rows = Number(url.searchParams.get('rows') ?? 24)
  // shell 是 ShellProfile.id（清单见 /api/terminal/shells）；不传 = 平台默认。
  // 认不出来的 id 由 resolveShell 回落到默认，不在这里判 —— 用户存的选择可能已经卸了
  const shellId = url.searchParams.get('shell') ?? undefined
  // 额外启动参数：`args` 是 JSON 数组字符串；坏值一律当没传（不因为一个参数坏掉就不给开终端）
  const args = parseArgsParam(url.searchParams.get('args'))
  // 启动后自动执行的一条命令
  const autoCommand = url.searchParams.get('auto') ?? undefined
  const cwd = url.searchParams.get('cwd') ?? ''
  /**
   * 容器型项目的终端：`?container=<工作区 id>`（可选 `&containerShell=<容器内 shell>`）。
   * 命中时 `pty.ts` 把 spawn 换成 `docker exec -i -t <容器名> <shellPath> -l` ——
   * 宿主侧的 `shell` / `args` / `cwd` 都不再参与（容器里是 Linux，挂载点固定 `/workspace`）。
   *
   * ⚠️ 这里收的是**工作区 id**、不是容器名，两个理由：① 容器名 `fizz-proj-<slug>` 这条约定
   * 只在服务端有一份（前端不复制）；② 客户端能指定任意容器名 = 能 `docker exec` 进任意容器
   * （含流程节点容器），收窄成「只能进自己登记的容器型项目容器」。
   */
  const containerWorkspaceId = url.searchParams.get('container') ?? undefined
  const containerShell = url.searchParams.get('containerShell') ?? undefined

  handleTerminalChannel({
    req,
    socket,
    head,
    url,
    auth,
    logScope: 'terminal',
    failureTitle: '终端启动失败',
    failureContext: () => (cwd ? `工作目录: ${cwd}` : ''),
    create: (sink): TerminalChannelSession => {
      let container: { name: string; shellPath?: string } | undefined
      if (containerWorkspaceId) {
        const cfg = domain.getWorkspace(containerWorkspaceId)?.container
        // 不是容器型项目 / 项目不存在：**不能静默退回本机终端**（那会在宿主上开个 shell，
        // 而用户以为自己在容器里）。抛给 `channel.ts` 统一关闭，close reason 里带原因。
        if (!cfg) {
          throw new Error(
            `这个工作区不是容器型项目，无法在容器内开终端（工作区 ${containerWorkspaceId}）`
          )
        }
        container = {
          name: containerNameOf(cfg.slug),
          ...(containerShell ? { shellPath: containerShell } : {})
        }
      }
      return openTerminalSession(
        {
          cwd,
          cols: Number.isFinite(cols) ? cols : 80,
          rows: Number.isFinite(rows) ? rows : 24,
          shellId,
          ...(args ? { args } : {}),
          ...(autoCommand ? { autoCommand } : {}),
          ...(container ? { container } : {})
        },
        sink
      )
    }
  })
}
