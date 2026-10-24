/**
 * 容器型项目配置在「重新登记 / 重命名」时的存活判据。
 *
 * 为什么单独一个文件：`addWorkspace`（`domain.ts`）是**逐字段重建整条记录**，
 * 重命名、换目录都走它 —— 只要漏带 `container` 字段，容器型项目就会**静默降级**
 * 成普通项目（症状：打开它不再起容器、预览标签消失），且不报任何错。
 *
 * 这里刻意做成**零依赖纯函数**（只 `import type`，运行期不引任何 `@fizz/*`），
 * 好让 vitest 直接跑它、不需要 alias / 构建。
 *
 * 优先级：**新值 > 同 id 的旧记录 > 同路径的记录**。
 *  - 新值：显式传入（创建）/ 显式改配置；
 *  - 同 id 旧记录：重命名 —— 只传 `name`，靠它把 `container` 带过去；
 *  - 同路径记录：换目录场景下 `byPath` 命中的那条。
 */
import type { ContainerProjectConfig } from '@fizz/contracts'

export function pickContainer(
  input?: ContainerProjectConfig,
  prev?: ContainerProjectConfig,
  byPath?: ContainerProjectConfig
): ContainerProjectConfig | undefined {
  return input ?? prev ?? byPath
}
