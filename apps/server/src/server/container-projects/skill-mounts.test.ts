import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { skillMountKey, skillMountsOf } from './skill-mounts'

/**
 * 这一层的两个约定值得钉住：**只挂存在的目录**（否则 docker 会在用户 home 里建空壳）、
 * **指纹只看容器内路径**（宿主路径换机器会变，但那不是「换了一批挂载」）。
 */
describe('skillMountsOf', () => {
  it('用户级目录会被建出来，跨智能体目录不存在就不挂', () => {
    const home = mkdtempSync(join(tmpdir(), 'fizz-home-'))
    try {
      const mounts = skillMountsOf(home)
      expect(mounts.map((m) => m.source)).toEqual(['user'])
      expect(mounts[0]?.containerDir).toBe('/fizz-skills/user')
      expect(skillMountKey(mounts)).toBe('/fizz-skills/user')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('~/.agents/skills 存在时两条都挂，指纹随之变化', () => {
    const home = mkdtempSync(join(tmpdir(), 'fizz-home-'))
    try {
      mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
      const mounts = skillMountsOf(home)
      expect(mounts.map((m) => m.source)).toEqual(['user', 'agents'])
      expect(mounts.map((m) => m.hostDir)).toEqual([
        join(home, '.fizz', 'skills'),
        join(home, '.agents', 'skills')
      ])
      // 容器指纹只由容器内路径决定（进 `lifecycle.ts` 的 `specOf`）
      expect(skillMountKey(mounts)).toBe('/fizz-skills/user;/fizz-skills/agents')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
