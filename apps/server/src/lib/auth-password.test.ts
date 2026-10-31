/**
 * 这条测试在防什么回归：
 * - 密码只保存 scrypt 哈希，绝不能把明文写进 `FIZZ_AUTH_PASS`；
 * - 同一个密码两次哈希结果不同（随机盐），但都能校验通过；
 * - 首次登录（值为空）设置的哈希会交给持久化回调；
 * - `.env` 持久化只替换对应行，不碰其它配置。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEnvFilePersister,
  hashPassword,
  isPasswordHash,
  setPasswordPersister,
  setStoredPassword,
  verifyPassword
} from './auth-password'

describe('auth-password', () => {
  const original = process.env.FIZZ_AUTH_PASS

  beforeEach(() => {
    setPasswordPersister(null)
  })

  afterEach(() => {
    setPasswordPersister(null)
    if (original === undefined) delete process.env.FIZZ_AUTH_PASS
    else process.env.FIZZ_AUTH_PASS = original
  })

  it('哈希带 scrypt 前缀且不含明文', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(isPasswordHash(hash)).toBe(true)
    expect(hash).not.toContain('correct horse battery staple')
    expect(hash.split('$')).toHaveLength(6)
  })

  it('同一密码每次盐不同，但都能通过校验', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a).not.toBe(b)
    await expect(verifyPassword('same-password', a)).resolves.toBe(true)
    await expect(verifyPassword('same-password', b)).resolves.toBe(true)
  })

  it('错误密码 / 非法哈希都不通过', async () => {
    const hash = await hashPassword('right')
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false)
    await expect(verifyPassword('right', 'not-a-hash')).resolves.toBe(false)
    await expect(verifyPassword('right', 'scrypt$bad$$salt$hash')).resolves.toBe(false)
  })

  it('首次设置密码时只把哈希写进环境变量并调用持久化', async () => {
    process.env.FIZZ_AUTH_PASS = ''
    const persist = vi.fn()
    setPasswordPersister(persist)
    await setStoredPassword('first-password')
    expect(process.env.FIZZ_AUTH_PASS).toBeTruthy()
    expect(isPasswordHash(process.env.FIZZ_AUTH_PASS!)).toBe(true)
    expect(process.env.FIZZ_AUTH_PASS).not.toContain('first-password')
    expect(persist).toHaveBeenCalledTimes(1)
    expect(isPasswordHash(persist.mock.calls[0]![0] as string)).toBe(true)
  })

  it('.env 持久化只改 FIZZ_AUTH_PASS 行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fizz-auth-'))
    const file = join(dir, '.env')
    writeFileSync(file, '# 注释\nFIZZ_AUTH_USER=legacy\nFIZZ_AUTH_PASS=old\nFIZZ_JWT_SECRET=keep\n')
    try {
      createEnvFilePersister(file)('scrypt$1$2$3$abc$def')
      const content = readFileSync(file, 'utf8')
      expect(content).toContain('FIZZ_AUTH_PASS=scrypt$1$2$3$abc$def')
      expect(content).not.toContain('FIZZ_AUTH_PASS=old')
      expect(content).toContain('FIZZ_JWT_SECRET=keep')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
