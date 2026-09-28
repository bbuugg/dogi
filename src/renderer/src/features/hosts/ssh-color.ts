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
