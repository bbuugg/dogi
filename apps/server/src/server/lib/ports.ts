/**
 * 宿主端口分配 —— 容器型项目（agent 控制面 + 预览服务）用的端口池。
 *
 * 池子只有**一份**：docker 的端口表按 `docker ps` 全量查（见下），所以这里只要
 * 按同一套算法挑，就不会和宿主机上任何别的容器撞。
 *
 * 两道检查都要，缺一不可：
 * - `docker ps` 的端口表：覆盖不到「别的进程占着这个端口但没起容器」的情况；
 * - `hostPortFree`（真实 bind 一次）：覆盖不到「容器已创建但还没 start」——那时端口
 *   还没真的绑上，bind 会假阳性成功。
 */
import net from 'node:net'
import { listContainers } from './docker'

/**
 * 宿主端口池。
 *
 * 取 41000–41999 这段：高于 Linux 的临时端口下限（`ip_local_port_range` 通常从 32768
 * 起），所以不会撞上内核随手分出去的回环端口；又远离常见服务端口，人工 `docker ps`
 * 时一眼能认出「这是我们起的」。
 */
const HOST_PORT_RANGE: readonly [number, number] = [41000, 41999]

/** 已被 docker 映射出去的宿主端口（一条 `docker ps -a` 的等价请求，不 spawn 进程） */
async function usedHostPorts(): Promise<Set<number>> {
  const ports = new Set<number>()
  try {
    for (const item of await listContainers({ all: true })) {
      for (const hostPort of item.ports.values()) ports.add(hostPort)
    }
  } catch {
    // 引擎连不上时当空集：下面 hostPortFree 还会真的 bind 一次，不至于把占用端口发出去
  }
  return ports
}

/** 真的 bind 一次看能不能占到（不能占说明有别的进程在用） */
function hostPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = net.createServer()
    server.once('error', () => resolvePromise(false))
    server.once('listening', () => server.close(() => resolvePromise(true)))
    server.listen(port, '0.0.0.0')
  })
}

/**
 * 从端口池里挑一个空闲宿主端口；池子耗尽时抛错（宁可报错也别复用别人的端口）。
 *
 * `exclude`：**同一次映射里要取多个端口时，必须把已取走的传回来**。端口在 `docker run`
 * 真正执行前还没被绑上，`docker ps` 与 `hostPortFree` 都看不见它，于是第二次调用会
 * **从头重扫、又把同一个 41000 给出去** —— `docker run` 随即失败：
 * `Bind for 127.0.0.1:41000 failed: port is already allocated`
 * （容器型项目要同时映射 agent 控制面与预览服务，正好是两次调用，真踩过）。
 */
export async function allocateHostPort(exclude?: ReadonlySet<number>): Promise<number> {
  const used = await usedHostPorts()
  const [start, end] = HOST_PORT_RANGE
  for (let port = start; port <= end; port++) {
    if (exclude?.has(port)) continue
    if (!used.has(port) && (await hostPortFree(port))) return port
  }
  throw new Error(`没有可用端口（${start}-${end}）`)
}
