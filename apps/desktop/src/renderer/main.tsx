import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setAgentHost } from '@fizz/agent-client/host'
import { applyThemeClass, bootstrapLanguage, hydrateConnection, resolveTheme } from '@fizz/agent-kit'
import { bootstrapColorTheme } from '@fizz/agent-kit/shared/hooks/useColorTheme'
import { useAgentStore } from '@fizz/agent-kit/shared/lib/stores/agent-store'
import { SettingsTitleBar, TitleBar } from './TitleBar'
import { ClientRoot } from './app/client-root'
import { ConversationWindow } from './app/ConversationWindow'
import { SettingsWindow } from './app/SettingsWindow'
import { resolveWindowKind } from './app/window-kind'
import { openDeepLink } from './app/layout/use-deep-link'
import { desktopHost } from './host'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')

/**
 * 宿主**必须在 render 之前注入**：UI 内部靠它拿请求实现 / 连接信息 / 本机终端
 * （见 `@fizz/agent-client` 的 `host.ts`）。
 *
 * ⚠️ 这里**不再注入路由适配器**：前端路由已整体移除。下面那个 `?window=settings`
 * 是**查询参数**、不是路由 —— 主进程用 `loadFile(file, { query })` 传，这里直接读
 * `location.search`，与前端路由无关，别把它一起删了。
 */
setAgentHost(desktopHost)
/**
 * store 在 `@fizz/agent-kit` 模块求值时就建好了（那一刻宿主还没注入，连接读不到），
 * 而 desktop 的连接是「恒存在」的 —— 在这里补一次，否则 `AppShell` 的登录守卫
 * 会先 `return null`（`AppGate` 那道门禁在 desktop 上是关的），首屏空一帧。
 */
hydrateConnection()

/**
 * 首帧之前就把主题类名落上：`index.html` 里写死的是 `class="dark"`，浅色主题的用户
 * 否则会先闪一下深色再被 React 的 effect 纠正（两个窗口都走这里）。
 */
applyThemeClass(resolveTheme(desktopHost.loadTheme()))

/**
 * 一个渲染端服务三种窗口（主进程用查询参数区分，见 main/index.ts 的 loadRenderer）：
 * - 默认：主界面（自绘标题栏 + ClientRoot）；
 * - `?window=settings`：独立设置窗口（自绘标题栏「设置 + 关闭」+ 设置面板）；
 * - `?window=conversation[&conversationId=…]`：会话浮窗（单窗口，可在窗内切换）。
 * 判定收在 `resolveWindowKind`（纯函数、带单测）。
 *
 * ⚠️ 必须在 `bootstrapLanguage()` / `bootstrapColorTheme()` **之前**算出来：下面渲染分支要按它选根节点
 * （设置窗口那份带 `data-fizz-opaque`）。
 */
const windowKind = resolveWindowKind(location.search)

bootstrapLanguage()

/**
 * 配色主题（`<html data-theme>`）同理：三种窗口都要在首帧前落上。
 * 设置窗口是**独立 BrowserWindow**，在那边换主题时主窗口只收得到 `storage` ——
 * `useColorTheme` 又只活在设置面板里，所以监听必须挂在窗口这一层（见 bootstrapColorTheme）。
 *
 * ⚠️ 背景媒体（图 / 视频）**三种窗口一视同仁**，这里不关它。以前对设置窗口调过
 * `setBackgroundMediaEnabled(false)`，理由是「整块不透明、看不见」—— 但那只对**面板**成立：
 * 根节点的 `bg-sidebar` 不在 `[data-fizz-opaque]` 的覆盖范围内（那条规则只换
 * `--background` / `--surface-1` / `--surface-2`，**不换 `--sidebar`**），所以面板之外的
 * 标题栏 / 左栏 / 留白本来就是半透明、图片背景一直透得出来。视频层要过 JS 开关才挂，
 * 于是出现「配图片能看到背景、配视频看不到」的割裂（用户报的就是这个）。
 * 两条路必须一致 —— 要让设置窗口彻底不透，得同时补 `--sidebar` 与这里的开关，别只关一半。
 */
bootstrapColorTheme()

/**
 * 浮窗的 store 必须在 **render 之前** 种好：
 * `AppProvider` 挂着 `useAgentApp()`，它的「自动恢复上次会话」effect 在
 * activeConversationId 为空时会自己开一条会话 —— 它的**首次闭包**里 activeConversationId
 * 就是这里种下的值（种子）/ `blankIntent`（草稿），于是不会再抢。
 * 见 spec Global Constraints「Seed the store before render」。
 */
if (windowKind.kind === 'conversation') {
  const store = useAgentStore.getState()
  if (windowKind.initialConversationId) void store.openConversation(windowKind.initialConversationId)
  else void store.openConversation(null) // 草稿：置 blankIntent，挡住自动恢复
}

/**
 * 主窗口：首帧之前把「从浮窗跳过来」的会话接上（浮窗右上角「在主窗口打开」）。
 *
 * 主进程要存着这条深链的唯一理由就是这一刻：主窗口可能在托盘里（页面还活着，后续的
 * 靠 `useDeepLink` 的订阅接住），也可能刚被重建、页面还在加载（事件先存着）。
 * 这里**同步**取一次再渲染，首帧直接就是目标会话，不会先显示上一个再跳过去。
 */
if (windowKind.kind === 'main') openDeepLink(desktopHost.takePendingDeepLink?.() ?? '')

createRoot(container).render(
  <StrictMode>
    {windowKind.kind === 'conversation' ? (
      <ConversationWindow initialConversationId={windowKind.initialConversationId} />
    ) : windowKind.kind === 'settings' ? (
      /*
        设置窗口：**面板不透明、窗口底色照旧透背景**。

        `data-fizz-opaque` 挂在根节点上，但它只覆盖 `--background` / `--surface-1` /
        `--surface-2`（规则由 useColorTheme 的 buildStyle 生成），**不覆盖 `--sidebar`** ——
        所以根节点的 `bg-sidebar` 仍是有背景媒体时那份半透明遮罩，标题栏 / 左栏 / 面板四周
        的留白会透出主题背景（图片与视频都一样，见上面 `bootstrapColorTheme()` 那段注释）。
        右侧面板自己画 `bg-background`，在 opaque 子树里被换回**不透明**底色 ——
        滑块 / 输入框永远读得清，这才是 `data-fizz-opaque` 真正要保护的那块。

        别把 `data-fizz-opaque` 去掉换半透明：面板会透出下层、字底发花；也别指望它能让整窗
        不透（`--sidebar` 不在覆盖范围里）。
      */
      <div data-fizz-opaque="" className="flex h-full flex-col overflow-hidden bg-sidebar">
        <SettingsTitleBar />
        <div className="min-h-0 flex-1 overflow-hidden">
          <SettingsWindow initialTab={windowKind.initialTab} />
        </div>
      </div>
    ) : (
      /*
        主窗口根**不画底色**（`bg-transparent`）。

        ⚠️ 这里曾经是 `bg-sidebar`：配了背景图 / 视频的主题下，`--sidebar` 是半透明遮罩
        （默认 alpha 0.72），于是整窗先蒙一层，`ClientRoot` → `AppShell` 的根再蒙一层
        —— 侧栏区域两层叠成 0.92，背景图几乎看不见。web 宿主没有这层外壳（`main.tsx`
        直接渲染 `ClientRoot`），所以同一套主题在浏览器里正常、在桌面端侧栏「多一层蒙版」。
        底色归 `AppShell` 的根画**一次**，这里只管竖向排布。
      */
      <div className="flex h-full flex-col overflow-hidden bg-transparent">
        <TitleBar />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ClientRoot />
        </div>
      </div>
    )}
  </StrictMode>
)
