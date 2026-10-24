import { describe, expect, it } from 'vitest'
import { assertContainerSkillPaths } from './skills'

/**
 * 只测纯函数：断言**不依赖任何 `@fizz/*` 运行期模块**（见 skills.ts 的说明），
 * 「宿主路径必须当场抛错」是容器型项目最容易踩的一条 —— 发下去的话容器里
 * 那个文件根本不存在，模型只会得到一句「读不到」。
 */
describe('assertContainerSkillPaths —— 只允许容器内路径', () => {
  it('容器内路径通过', () => {
    expect(() =>
      assertContainerSkillPaths([
        { path: '/app/skills/a/SKILL.md' },
        { path: '/workspace/.fizz/skills/b/SKILL.md' },
        // 用户级 / 跨智能体共享目录：靠 `lifecycle.ts` 的只读挂载才存在
        { path: '/fizz-skills/user/c/SKILL.md' },
        { path: '/fizz-skills/agents/d/SKILL.md' }
      ])
    ).not.toThrow()
  })

  it('宿主路径当场抛错', () => {
    expect(() => assertContainerSkillPaths([{ path: 'C:/Users/x/.fizz/skills/a/SKILL.md' }])).toThrow()
  })

  it('挂载点的兄弟目录不算容器内路径', () => {
    // 前缀相同但不在 /fizz-skills/user 里：拼错路径时不能静默放过
    expect(() => assertContainerSkillPaths([{ path: '/fizz-skills/userx/a/SKILL.md' }])).toThrow()
  })
})
