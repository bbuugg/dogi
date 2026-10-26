/**
 * 扩展的入口：**外壳整棵来自手机版**（`apps/mobile/src/app`），这里只做启动。
 *
 * 启动顺序与手机版逐条对齐（照抄是有意的 —— 这几步每一处先后颠倒都踩过坑）：
 *
 * 1. `./bootstrap` 必须**第一个 import**：宿主注入要早于 agent-kit store 的模块求值；
 * 2. `setSingleTabMode(true)` 在任何 `openTab` 之前：侧栏就 400px 宽，多标签在这里
 *    没有意义。一个会话 / 工具 = 当前视图，开新的就把旧的换掉（与手机版同一语义）；
 * 3. 服务端地址必须在 `hydrateConnection()` **之前**注入：`hydrateConnection` 读的是
 *    `host.loadConnection()`，覆盖值是在那一步补进 `Connection.serverBase` 的；晚一步
 *    的话 store 会先按同源建好 api 并缓存（而 `chrome-extension://` 这个 origin 上
 *    根本没有 `/api`），登录页会永远连不上；
 * 4. 语言 / 配色主题在 render 前落上：`bootstrapColorTheme` 只挂在设置页里，没有它首屏
 *    是默认配色，进设置才「跳」一下。
 */
import './bootstrap'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getAgentHost, setServerBase } from '@fizz/agent-client/host'
import { normalizeServerBase } from '@fizz/agent-client/api'
import { bootstrapLanguage, hydrateConnection } from '@fizz/agent-kit'
import { setSingleTabMode } from '@fizz/agent-kit/shared/lib/panel-store'
import { bootstrapColorTheme } from '@fizz/agent-kit/shared/hooks/useColorTheme'
// ⚠️ `@/...` 指向**手机版**的 src（见 vite.config.ts / tsconfig.json 的别名说明）
import { App } from '@/app/App'
import { loadServerUrl } from './server-url'
import './index.css'

/**
 * 手机版外壳是**单标签**（见 `apps/mobile/src/main.tsx`）：侧栏的宽度也不适合并排摆标签。
 * 必须在任何 `openTab` 之前定下语义，否则第一帧会先按多标签建出旧标签。
 */
setSingleTabMode(true)

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')

/**
 * 服务端地址：扩展页的 origin 是 `chrome-extension://<id>`，相对路径的 `/api`、SSE、WS
 * 一条都到不了服务端，所以**必须是绝对地址**。按优先级取：
 *
 * 1. `?server=http://host:port`：调试用，这一次打开生效；
 * 2. localStorage 里的 `fizz.ext.serverUrl`（登录页填写，见 `server-url.ts`）；
 * 3. 已保存连接里的 `serverBase`：老记录兜底。
 *
 * 都没有 = 未配置，登录页会要求先填（`ConnectGate` 里那条「扩展页必须填」的判断）。
 */
const queryServer = normalizeServerBase(new URLSearchParams(location.search).get('server'))
const storedServer = normalizeServerBase(getAgentHost().loadConnection()?.serverBase)
const serverBase = queryServer ?? loadServerUrl() ?? storedServer
if (serverBase) setServerBase(serverBase)

hydrateConnection()
bootstrapLanguage()
bootstrapColorTheme()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
