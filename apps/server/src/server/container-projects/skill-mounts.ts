/**
 * 用户级技能目录 → 容器内的**只读挂载点**。
 *
 * 容器只挂了项目目录（`/workspace`），`~/.fizz/skills` 与 `~/.agents/skills` 在容器里根本
 * 不存在 —— 不挂的话 `containerSkillList` 只能把它们整类排除（用户装了技能、容器里永远用不上）。
 * 所以 `lifecycle.ts` 建容器时按这张表加 bind，`skills.ts` 按**同一份常量**改写路径。
 *
 * ⚠️ 三条约束：
 *
 * 1. **只挂真实存在的目录**：docker 会替不存在的宿主路径建一个空目录（还常以 root 建），
 *    等于往用户 home 里留空壳。`~/.agents/skills` 属于 skills CLI，我们不去创建它；
 *    `~/.fizz/skills` 是我们自己的目录（扫描时本来也会建），先建出来让挂载集合稳定 ——
 *    否则会出现「第一次启动没挂上、扫描一次之后指纹又变了」。
 * 2. **只读（`:ro`）**：容器里的 agent 不该改用户的技能目录。只读不影响执行技能里的脚本。
 * 3. **挂载集合进容器指纹**（`lifecycle.ts` 的 `specOf`）：容器建好之后用户才装出
 *    `~/.agents/skills` 时，指纹变化 → 下次启动重建容器，新目录自动挂上。
 *
 * ⚠️ 指纹只能保证「下次启动」：**正在跑的旧容器没有这些挂载**。所以 `doStart` 会按
 * 「容器形状是否与当前配置一致」把真实的挂载情况（`skillMounts`）带出来，`containerSkillList`
 * 据此裁剪 —— 宁可不把用户级技能发给它，也不发一条容器里读不到的路径。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 容器内用户级技能的统一父目录（`docker run -v <宿主目录>:/fizz-skills/<source>:ro`） */
export const CONTAINER_SKILLS_ROOT = '/fizz-skills'
/** `~/.fizz/skills` 在容器里的位置 */
export const CONTAINER_USER_SKILLS_DIR = `${CONTAINER_SKILLS_ROOT}/user`
/** `~/.agents/skills` 在容器里的位置 */
export const CONTAINER_AGENTS_SKILLS_DIR = `${CONTAINER_SKILLS_ROOT}/agents`

/** 一个「宿主目录 → 容器内目录」的技能挂载 */
export interface SkillMount {
  source: 'user' | 'agents'
  /** 宿主绝对路径（Windows 上是 `C:\Users\...`，进 docker 前由 `toDockerPath` 归一） */
  hostDir: string
  /** 容器内挂载点（POSIX 绝对路径） */
  containerDir: string
}

/**
 * 现在该挂哪些目录（**只含存在的**）。
 *
 * `home` 可注入：服务端可能跑在别的用户下，测试里也不想碰真实 home。
 */
export function skillMountsOf(home = homedir()): SkillMount[] {
  const userDir = join(home, '.fizz', 'skills')
  // `existsSync` 先挡一下：这个函数在 `specOf` 里被反复调（每条消息好几次），
  // 每次 `mkdirSync` 都白付一次系统调用
  if (!existsSync(userDir)) {
    try {
      mkdirSync(userDir, { recursive: true })
    } catch {
      // 建不出来（只读 home / 权限不足）：当成没有这个目录，下面的 existsSync 会兜住
    }
  }
  const candidates: SkillMount[] = [
    { source: 'user', hostDir: userDir, containerDir: CONTAINER_USER_SKILLS_DIR },
    {
      source: 'agents',
      hostDir: join(home, '.agents', 'skills'),
      containerDir: CONTAINER_AGENTS_SKILLS_DIR
    }
  ]
  return candidates.filter((mount) => existsSync(mount.hostDir))
}

/**
 * 挂载集合的**稳定指纹**（进 `specOf`）：容器内目录按来源顺序拼起来。
 *
 * 用容器内路径而不是宿主路径：宿主路径换机器会变（`/home/a` vs `C:\Users\a`），
 * 但它是不是「同一批挂载」只看容器内目录。
 */
export function skillMountKey(mounts = skillMountsOf()): string {
  return mounts.map((mount) => mount.containerDir).join(';')
}
