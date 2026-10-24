import type { SshHostConfig } from '@fizz/contracts/types'

/**
 * 一台主机的标准摘要 `user@host:port`。
 *
 * 主机清单行、标签悬停提示、跳板机下拉、删除确认文案四处都用它 —— 分开写迟早会
 * 有一处漏掉端口或用户名，看着像「同一台机器有两副样子」。
 */
export function hostSummary(host: SshHostConfig): string {
  return `${host.username}@${host.host}:${host.port}`
}
