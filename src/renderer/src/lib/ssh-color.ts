import type { SshGroup, SshProfile } from '@shared/types'

/**
 * 连接的生效颜色：连接自身设置优先，否则继承所属分组的颜色。
 * 分组不存在（已删除）或无颜色时返回 undefined，即使用主题默认色。
 */
export function resolveSshColor(
  profile: Pick<SshProfile, 'color' | 'groupId'>,
  groups: readonly SshGroup[]
): string | undefined {
  if (profile.color) return profile.color
  if (!profile.groupId) return undefined
  return groups.find((g) => g.id === profile.groupId)?.color
}

/**
 * 文字着色：把颜色与主题前景色按 oklab 混合。
 * 直接用原色写文字时，浅色（如亮黄）在浅色主题下几乎看不清；混入前景色后
 * 既保留明显色相，又能在明暗两种主题下都保证可读性。
 */
export function tintText(color: string): string {
  return `color-mix(in oklab, ${color} 70%, var(--foreground))`
}
