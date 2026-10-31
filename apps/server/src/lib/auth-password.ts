/**
 * 单用户登录密码：**只保存 scrypt 哈希，绝不落明文**。
 *
 * 约定：
 * - 存储位置就是原来的 `FIZZ_AUTH_PASS`（名字不变，值变成 `scrypt$N$r$p$salt$hash`）；
 * - 首次登录时该值为空 → 把用户这次输入的密码哈希后写入，之后按哈希校验；
 * - 校验用定长比较（`timingSafeEqual`），哈希参数跟着串走，将来调参不用迁移旧值。
 *
 * 为什么不用 Salts 之外的密钥：哈希本来就不需要用户再管一把 key，盐随机生成、
 * 与哈希一起存即可。真正需要「可逆」的场景（要在界面上回显密码）本方案刻意不支持。
 *
 * 持久化由调用方注入（`setPasswordPersister`）：
 * - 独立部署：写回 `.env`（见 `createEnvFilePersister`）；
 * - 桌面端远程访问：写回 `window-prefs.json`（由 agent-host 注入回调）。
 * 未注入时只改进程内 `process.env`，重启会丢 —— 仅开发态可接受。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const PREFIX = 'scrypt'
const DEFAULT_N = 16384
const DEFAULT_R = 8
const DEFAULT_P = 1
const KEYLEN = 64

/** 存储格式：`scrypt$N$r$p$<salt-base64>$<hash-base64>` */
export function isPasswordHash(value: string): boolean {
  return value.startsWith(`${PREFIX}$`)
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: n, r, p }, (err, key) => {
      if (err) reject(err)
      else resolve(key as Buffer)
    })
  })
}

/** 生成新的密码哈希（每次都用新的随机盐） */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, DEFAULT_N, DEFAULT_R, DEFAULT_P, KEYLEN)
  return [
    PREFIX,
    DEFAULT_N,
    DEFAULT_R,
    DEFAULT_P,
    salt.toString('base64'),
    key.toString('base64')
  ].join('$')
}

/** 参数校验：避免被篡改过的环境值拖成一个巨大的 KDF 计算（DoS） */
function validParams(n: number, r: number, p: number): boolean {
  return (
    Number.isInteger(n) &&
    n >= 2 &&
    n <= 1 << 20 &&
    (n & (n - 1)) === 0 &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= 32 &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= 16
  )
}

/** 按存储的哈希校验密码；格式不对 / 参数非法都按「不匹配」处理 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!isPasswordHash(stored)) return false
  const parts = stored.split('$')
  if (parts.length !== 6) return false
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts
  const n = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  if (!validParams(n, r, p)) return false
  const salt = Buffer.from(saltB64 ?? '', 'base64')
  const expected = Buffer.from(hashB64 ?? '', 'base64')
  if (!salt.length || !expected.length) return false
  try {
    const key = await derive(password, salt, n, r, p, expected.length)
    return key.length === expected.length && timingSafeEqual(key, expected)
  } catch {
    return false
  }
}

/** 把明文密码哈希后写进当前进程的 `FIZZ_AUTH_PASS`，并交给持久化回调 */
export async function setStoredPassword(password: string): Promise<void> {
  const hash = await hashPassword(password)
  process.env.FIZZ_AUTH_PASS = hash
  await persister?.(hash)
}

type PasswordPersister = (hash: string) => void | Promise<void>

let persister: PasswordPersister | null = null

/** 注入持久化实现（传 `null` 撤销，例如远程访问关闭时） */
export function setPasswordPersister(next: PasswordPersister | null): void {
  persister = next
}

/**
 * `.env` 持久化：只改 `FIZZ_AUTH_PASS=` 这一行，保留其它内容与注释。
 *
 * 哈希串由 base64 字符组成，不含 `#` / `$`，可以直接不加引号写入。
 */
export function createEnvFilePersister(file: string): PasswordPersister {
  return (hash) => {
    let content = ''
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      content = ''
    }
    const line = `FIZZ_AUTH_PASS=${hash}`
    const pattern = /^[ \t]*(?:export[ \t]+)?FIZZ_AUTH_PASS[ \t]*=.*$/m
    const next = pattern.test(content)
      ? content.replace(pattern, line)
      : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`
    writeFileSync(file, next, 'utf8')
  }
}
