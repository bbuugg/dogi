/**
 * 扩展的后台（MV3 service worker，**纯 JS、不过 vite** —— 放在 `public/` 里原样拷进产物）。
 *
 * 它只做三件事：
 *
 * 1. **点图标 = 开侧栏**（`sidePanel` 的 `openPanelOnActionClick`）。这是主入口：对话是
 *    「边看网页边聊」的场景，弹出式 popup 一失焦就关掉，流式回答会直接断在半路。
 * 2. 图标右键 / 侧栏里呆不下时，给一条「在新标签页打开」——同一个 `index.html`，只是铺满
 *    整个标签页，适合长会话（终端、文件面板那些也更宽）。
 * 3. 老浏览器（< 114，没有 `sidePanel`）兜底：点图标直接开标签页，而不是什么都不发生。
 *
 * ⚠️ SW 会被随时回收、下次事件再拉起来，所以这段代码要**幂等**：`contextMenus.create`
 * 只在 `onInstalled` 里建（重复建同名 id 会抛错），别的都是现算。
 */
const PAGE = 'index.html'

/** 点图标就展开侧栏（没有 sidePanel 的浏览器会直接抛，忽略即可 —— 那时走 onClicked 兜底） */
function openPanelOnActionClick() {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {})
}

openPanelOnActionClick()

chrome.runtime.onInstalled.addListener(() => {
  openPanelOnActionClick()
  chrome.contextMenus.create({
    id: 'fizz-open-tab',
    title: '在新标签页打开 Fizz',
    contexts: ['action']
  })
})

/**
 * 这套「点图标」的兜底：设了 `openPanelOnActionClick` 之后 Chrome **不会**再发
 * `action.onClicked`，所以这条只有两种情况会响 —— 浏览器太老没侧栏，或用户装了扩展但
 * 侧栏 API 被策略禁掉。两种都该给一个能用的界面。
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL(PAGE) })
})

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'fizz-open-tab') {
    chrome.tabs.create({ url: chrome.runtime.getURL(PAGE) })
  }
})
