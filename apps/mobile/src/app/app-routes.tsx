/**
 * 主区域：只有**一套面板**（多标签）。
 *
 * 原来是 Next 的页面（`(agent)/{chat,flow}/[[...id]]/page.tsx`），SPA 化之后收敛成
 * 这一处；前端路由已整体移除（地址栏恒为 `/`）。
 *
 * ⚠️ 这里**不再做「视图选择」**：流程功能已整个删除，`view-state` 那套
 * `'chat' | 'flow'` 状态一并消失（别再为了「以后可能加视图」把它加回来）。
 * 选中态（当前会话）由 `panel-store` 持有，本组件不碰，也不反向写任何东西。
 */
import { PanelView } from '@/app/layout/PanelView'

export function AppRoutes() {
  // 本工程是**单标签**（`main.tsx` 调 `setSingleTabMode`）：一个会话 / 工具 = 一张标签，
  // 打开新的就把当前的换掉（见 `PanelView` 文件头）。
  //
  // ⚠️ 容器型项目的「容器状态」门**不在这里**，它挂在每个标签的内容层（`ContainerTabGate`，
  // 见 `PanelView` 的 `PanelContentLayer`）。套在这一层会把**标签条一起顶掉** —— 容器一停
  // 整块主区域只剩一张卡片，用户看不到也切不了别的标签（用户报过）。
  return <PanelView />
}
