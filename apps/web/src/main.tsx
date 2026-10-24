import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setAgentHost, setServerBase } from '@fizz/agent-client/host'
import { normalizeServerBase } from '@fizz/agent-client/api'
import { bootstrapLanguage, hydrateConnection } from '@fizz/agent-kit'
import { bootstrapColorTheme } from '@fizz/agent-kit/shared/hooks/useColorTheme'
import { ClientRoot } from '@fizz/agent-kit/shell/client-root'
import { webHost } from './host'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')

/**
 * 宿主**必须在 render 之前注入**：UI 内部靠它拿请求实现 / 连接信息 / 服务端终端
 * （见 `@fizz/agent-client` 的 `host.ts`）。
 *
 * ⚠️ 这里**不再注入路由适配器**：前端路由已整体移除，地址栏恒为 `/`。
 * 桌面端那个 `?window=settings` 是**查询参数**、由各自宿主的入口直接读
 * `location.search`，与前端路由无关。
 */
setAgentHost(webHost)

/**
 * 服务端地址（**跨源**形态的可配置入口）。
 *
 * 优先级：`?server=http://host:port`（这一次打开生效，方便试连） > `VITE_FIZZ_SERVER_URL`
 * （构建期常量，独立 vite 工程 / Capacitor 本地 `www` 用） > 不设 = **同源**。
 *
 * 为什么 web 端也要这个：页面一旦不由 server 托管（本地 `www`、独立 dev server、手机壳的
 * `https://localhost`），相对路径的 `/api`、SSE、WS 全都打到页面自己的 origin 上，
 * 表现是「登录页都上不去」。填了绝对地址，`@fizz/agent-client` 会把所有出口接到它上面。
 *
 * ⚠️ 必须在 **`hydrateConnection()` 之前**注入：`hydrateConnection` 读的是
 * `host.loadConnection()`，而覆盖值就是由它在读取时补进 `serverBase` 的；晚一步注入的话
 * 已存连接里没有地址，store 会先按同源建好 api（并缓存），登录/对话全打到页面自己的 origin。
 */
const serverBase =
  normalizeServerBase(new URLSearchParams(location.search).get('server')) ??
  normalizeServerBase(import.meta.env.VITE_FIZZ_SERVER_URL)
if (serverBase) setServerBase(serverBase)

// web 的连接本来就来自 localStorage（store 创建时已读到覆盖后的 serverBase），
// 这次调用是空操作；两个入口都调，避免「desktop 忘了补」这类不对称再次发生。
hydrateConnection()

/**
 * 配色主题同样要在首帧前落上：`useColorTheme` 只挂在设置 → 外观里，没有它的话首屏是默认配色、
 * 进了设置才「跳」成用户选的那套。这里顺带订阅 `storage`，别的标签页 / 窗口改了就跟着变。
 */
bootstrapLanguage()
bootstrapColorTheme()

createRoot(container).render(
  <StrictMode>
    <ClientRoot />
  </StrictMode>
)
