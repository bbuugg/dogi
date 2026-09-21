import { cn } from 'cn'

/**
 * 分段切换按钮（接口请求页的请求区 / 响应区 / WebSocket 日志区共用）。
 *
 * 抽成公共组件的理由：以前请求侧用 antd `Tabs`、响应侧是手写按钮，样式对不上
 * （内边距、选中底色、字号都不一样）。现在**只有这一个实现**，改一处所有页面一起变 ——
 * 新增的 WebSocket 调试页也直接用它，不再另写一套。
 */
export function TabButtons<T extends string>({
  tabs,
  value,
  onChange
}: {
  tabs: ReadonlyArray<{ key: T; label: string }>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {tabs.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={cn(
            'rounded px-2 py-0.5 transition-colors',
            value === it.key
              ? 'bg-secondary font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
