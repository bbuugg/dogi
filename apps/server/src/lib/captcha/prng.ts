/**
 * 随机源与确定性伪随机（移植自 `console/apps/captcha` 的 `prng.go`）。
 *
 * 两种随机各管一件事，别混：
 * - `randomBytes` / `randomInt` / `randomId` —— 加密安全随机，给「挑战 id / 缺口位置 / 种子」
 *   用。可预测的答案等于没有验证码。
 * - `mulberry32` —— **确定性**伪随机，给渲染用：背景与拼图块是**各自独立渲染**的两张图，
 *   只有吃同一个 seed 才能严丝合缝（同一 seed 必然产出同一张背景）。
 */
import { randomBytes as cryptoRandomBytes } from 'node:crypto'

/**
 * 取 n 个加密安全随机字节。
 *
 * `crypto.randomBytes` 在正常环境不会失败；万一失败（极端熵枯竭）退回 `Math.random` 兜底，
 * 绝不让签发因为随机源异常而中断 —— 验证码发不出来会把所有人挡在登录页外面。
 */
export function randomBytes(n: number): Uint8Array {
  try {
    return cryptoRandomBytes(n)
  } catch {
    const b = new Uint8Array(n)
    for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256)
    return b
  }
}

/** 返回 [0, maxExclusive) 的随机整数（与 Go 版同构：取 4 字节大端再取模）。 */
export function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0
  const b = randomBytes(4)
  const v = (((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0) % maxExclusive
  return v
}

/** 128 位随机 id（hex），做挑战标识 / 一次性票据。 */
export function randomId(): string {
  return Buffer.from(randomBytes(16)).toString('hex')
}

/**
 * mulberry32：同一个 seed 必然产出同一串数（与 fizz 早年的 TS 实现、Go 版逐位一致）。
 *
 * 用 `Math.imul` 而不是 `*`：JS 的乘法是双精度，32 位整数乘积会丢低位；Go 那边是
 * `uint32` 自然回绕。不 imul 的话背景与拼图块两边算出来的图案会对不上。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), 1 | t) >>> 0
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0
    t = (t ^ (t >>> 14)) >>> 0
    return t / 4294967296
  }
}
