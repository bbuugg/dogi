/**
 * 服务器性能监控的偏好：前后端共用的纯契约（渲染端设置页 + 服务端采样器都读它）。
 *
 * 与 `browser.ts` 同款约束：**不牵任何 Node 代码**，渲染端可从根入口安全引入
 * （否则 import 一次 contracts 就会把 node:os / node:fs 拖进浏览器产物）。
 *
 * ## 为什么这个开关必须落服务端
 *
 * 状态栏右侧那条监控是「服务开着就在采」的：采样器每 ~2s 用 Node 内置 API（`node:os`）
 * 采一帧（`apps/server/src/server/services/system-monitor.ts`）。光在前端把徽标藏起来只能
 * 省掉渲染与请求，**采样本身照旧在跑**。所以这个偏好必须能被服务端读到 —— 关掉时连采样
 * 一起停。
 *
 * 全局一份（落 `CoreData.systemMonitorSettings`，desktop / web 共享）：监控采的是
 * **server 所在机器**的资源，与具体项目无关。
 */
export interface SystemMonitorSettings {
  /** 总闸门：关掉后服务端不采样、状态栏也不显示监控条 */
  enabled: boolean
}

/** 默认开 —— 与「没这个开关之前一直采着」的老行为一致，不做静默的能力变更 */
export const DEFAULT_SYSTEM_MONITOR_SETTINGS: SystemMonitorSettings = { enabled: true }

/** 收敛：手改坏的数据文件 / 老版本缺字段都不该让读接口抛错（同 `normalizeBrowserSettings`）。 */
export function normalizeSystemMonitorSettings(value: unknown): SystemMonitorSettings {
  const raw = value as Partial<SystemMonitorSettings> | undefined
  return {
    enabled:
      typeof raw?.enabled === 'boolean'
        ? raw.enabled
        : DEFAULT_SYSTEM_MONITOR_SETTINGS.enabled
  }
}
