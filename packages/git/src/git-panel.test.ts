/**
 * `samePath` 的归一化判据（纯函数，vitest 覆盖）。
 *
 * 用途见 `apps/server/src/api/workspaces/[id]/git/status/route.ts`：判断 `repoRoot()`
 * 返回的仓库根**是不是工作区自己**。临时会话（`scratch`）目录落在数据目录里
 * （`~/.fizz-server/conversations/<会话 id>`），而数据目录常常落在用户主目录 ——
 * 主目录一旦被 `git init` 过（dotfiles 仓库，很常见），`repoRoot()` 就会返回主目录。
 * 那时若把它当仓库，`git status --untracked-files=all` 会在**整个主目录**上枚举未跟踪
 * 文件：面板永远停在「读取仓库状态…」，会话 JSON 还会被列成待提交改动。
 *
 * 所以这条判据错一次的代价是「面板卡死 / 用户把数据目录提交进仓库」，这里钉住它：
 * 1. 同一目录的不同写法（分隔符 / 末尾斜杠 / Windows 大小写）必须算同一个；
 * 2. 形近的兄弟目录不能误判（`/home/a` 与 `/home/ab`）—— 所以不能用 `startsWith`。
 */
import { describe, expect, it } from 'vitest'
import { samePath } from './git-panel'

describe('samePath', () => {
  it('同一目录的不同写法算同一个（分隔符 / 末尾斜杠）', () => {
    // Windows 才允许 `\` 作分隔符；POSIX 上 `\` 是合法文件名字符，不能拿它当同义写法
    if (process.platform === 'win32') {
      expect(samePath('C:/Users/a/repo', 'C:\\Users\\a\\repo\\')).toBe(true)
      expect(samePath('C:\\Users\\a\\repo', 'C:/Users/a/repo')).toBe(true)
    } else {
      expect(samePath('/home/a/repo', '/home/a/repo/')).toBe(true)
    }
  })

  it('大小写：Windows 不敏感，其它平台敏感（两个不同目录）', () => {
    const insensitive = process.platform === 'win32'
    expect(samePath('/home/A/repo', '/home/a/repo')).toBe(insensitive)
  })

  it('父子 / 兄弟目录不算同一个', () => {
    expect(samePath('/home/a', '/home/a/repo')).toBe(false)
    expect(samePath('/home/a', '/home/ab')).toBe(false)
  })

  it('相对路径先按 cwd 解析再比（调用方传谁都行，不要求预先 resolve）', () => {
    expect(samePath('.', process.cwd())).toBe(true)
  })
})
