/**
 * 进程内的两种存储（移植自 `console/apps/captcha` 的 `store.go` + `service/captcha.go` 的
 * `passStore`）：
 *
 * 1. **挑战存储**：签发时把答案（`targetX`）存进来，校验时一次性消费；
 * 2. **票据存储**：校验通过后签发一次性 `passToken`，登录接口消费它。
 *
 * 都是内存实现 —— 自托管单实例够用。多实例要共享状态时把这两个换成 Redis 实现
 * （保持同样的 put / consume 语义），调用方一行不用改。
 *
 * ⚠️ 两个都做了容量兜底：不设上限时，伪造请求能把 Map 撑爆内存（每张挑战都是实打实的
 * 像素缓冲与答案记录）。
 */
import { randomId } from './prng'

export interface ChallengeRecord {
  /** 正确答案：拼图块左边应处的 x（逻辑 px） */
  targetX: number
  /** 签发时刻（ms） */
  createdAt: number
  /** 有效期（ms） */
  ttlMs: number
}

export interface ChallengeStore {
  put(id: string, record: ChallengeRecord): void
  /** 取出并作废（一次性）。不存在 / 已过期 / 已消费 → null */
  consume(id: string): ChallengeRecord | null
  size(): number
}

export function createChallengeStore(options: {
  max: number
  now?: () => number
}): ChallengeStore {
  const now = options.now ?? Date.now
  const max = Math.max(0, Math.trunc(options.max))
  const records = new Map<string, ChallengeRecord>()

  const isDead = (r: ChallengeRecord, t: number): boolean => t - r.createdAt > r.ttlMs

  const sweep = (t: number): void => {
    for (const [id, r] of records) if (isDead(r, t)) records.delete(id)
  }

  return {
    put(id, record) {
      const t = now()
      sweep(t)
      // 容量兜底：超限就淘汰一个（Map 的迭代顺序即插入顺序，先到先出）
      if (max > 0 && records.size >= max) {
        const oldest = records.keys().next().value
        if (oldest !== undefined) records.delete(oldest)
      }
      records.set(id, record)
    },

    consume(id) {
      const r = records.get(id)
      if (!r) return null
      records.delete(id)
      return isDead(r, now()) ? null : r
    },

    size() {
      return records.size
    }
  }
}

export interface PassStore {
  /** 签发一张一次性票据 */
  issue(): string
  /** 消费票据（一次性）。不存在 / 已过期 → false */
  consume(token: string): boolean
  size(): number
}

/**
 * 一次性通过票据。
 *
 * TTL 只覆盖「验证码刚过 → 紧接着提交登录」这个短窗口，5 分钟足够；过期后即使票据被
 * 窃取也无法重放（而且它本来就用一次就没了）。
 */
export function createPassStore(options: { max: number; ttlMs: number; now?: () => number }): PassStore {
  const now = options.now ?? Date.now
  const max = Math.max(0, Math.trunc(options.max))
  const ttlMs = Math.max(1000, Math.trunc(options.ttlMs))
  const tokens = new Map<string, number>() // token → 过期时刻

  return {
    issue() {
      const t = now()
      for (const [k, exp] of tokens) if (t >= exp) tokens.delete(k)
      if (max > 0 && tokens.size >= max) {
        const oldest = tokens.keys().next().value
        if (oldest !== undefined) tokens.delete(oldest)
      }
      // 128 位随机 hex，与挑战 id 同一个随机源（不可预测、不可枚举）
      const token = randomId()
      tokens.set(token, t + ttlMs)
      return token
    },

    consume(token) {
      if (!token) return false
      const exp = tokens.get(token)
      if (exp === undefined) return false
      tokens.delete(token)
      return now() < exp
    },

    size() {
      return tokens.size
    }
  }
}
