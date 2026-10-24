/**
 * 预览端口校验 —— **零依赖纯函数**（vitest 直接跑，不需要 alias / 构建）。
 *
 * 预览端口是**容器内**服务的端口，会被 `docker run -p 127.0.0.1:<宿主>:<预览端口>` 转发。
 * 它有两个必须挡住的坑：
 *  1. **不能是 8080** —— 那是容器内 agent 控制面端口。撞上就是 `docker run` 的两个
 *     `-p` 抢同一个容器内端口（docker 会拒绝启动，或其中一个映射失效）。
 *  2. 必须是 1-65535 的**整数**（`docker -p` 不接受 0 / 负数 / 小数 / 越界）。
 */
export function isValidPreviewPort(port: number | undefined): boolean {
  // 不填 = 该项目不支持预览，合法
  if (port === undefined) return true
  if (!Number.isInteger(port)) return false
  if (port < 1 || port > 65535) return false
  // 8080 是容器内 agent 控制面（见 spec §4.3）
  if (port === 8080) return false
  return true
}
