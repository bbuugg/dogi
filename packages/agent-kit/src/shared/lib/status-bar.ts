/**
 * 底部状态栏条目的统一样式：**状态栏右侧注入的节点都用它**，保证一条底栏里高度 /
 * 文字 / 悬停底色一致（对齐 dogi 的 `STATUS_ITEM_CLASS`）。
 *
 * `h-full` 让悬停底色铺满整条底栏（`h-8`），而不是缩成一个小圆角块。
 *
 * 放在 `shared/lib/` 而不是从 `app/layout/StatusBar.tsx` 导出：后者已经被
 * `app/` 自己使用，而注入项（如 `SystemMonitorBadge`）在 `shared/` ——
 * 反过来让 `shared/` 去 import `app/` 会把分层倒过来。所以这条「状态栏的样式契约」
 * 落在这里，两侧都从这儿取。
 */
export const STATUS_ITEM_CLASS =
  'flex h-full items-center gap-1.5 rounded px-1.5 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground'