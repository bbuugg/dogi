/**
 * 上下文压缩 + 会话累计用量的纯逻辑验证（真源码，由 verify-context-compression.mjs 包装执行）。
 *
 * 覆盖 compressContext 的**不需要真实模型**的分支：未超预算零改动、切轮边界、摘要失败回退截断、
 * 单轮超预算不压缩。摘要成功的路径要真调模型，不在这里造（那属于集成验证）。
 */
import {
  compressContext,
  estimateTokens,
  DEFAULT_CONTEXT_BUDGET,
  type CompressResult
} from '../ai/context.ts'
import { sumUsage } from '../shared/agent-usage.ts'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`)
  }
}

/** 一条 user 消息 */
function user(text: string): { role: 'user'; content: string } {
  return { role: 'user', content: text }
}
/** 一条 assistant 文本消息 */
function assistant(text: string): { role: 'assistant'; content: string } {
  return { role: 'assistant', content: text }
}

/** 造一段很长的中文历史（每轮 ~2000 token），共 n 轮 */
function longHistory(n: number): Array<{ role: 'user'; content: string } | { role: 'assistant'; content: string }> {
  const out: Array<{ role: 'user'; content: string } | { role: 'assistant'; content: string }> = []
  for (let i = 0; i < n; i++) {
    out.push(user(`第 ${i} 轮的问题`.repeat(300)))
    out.push(assistant(`第 ${i} 轮的回答`.repeat(300)))
  }
  return out
}

/**
 * 模型配置指向**本机一个没人监听的端口**（127.0.0.1:1）：摘要请求会立即连接失败，
 * 正好走「回退截断」分支 —— 既不靠外网（快且确定），也不依赖真实网关。
 */
const BAD_MODEL = {
  id: 'x',
  name: 'x',
  kind: 'openai',
  apiStyle: 'chat',
  apiKey: 'EMPTY',
  baseURL: 'http://127.0.0.1:1/v1',
  model: 'gpt-x',
  createdAt: 0,
  updatedAt: 0
} as never

console.log('\n[estimateTokens]')
{
  check('空串 = 0', estimateTokens('') === 0)
  // 中文 1 字 ≈ 1.5 token
  check('中文按 1.5/字', estimateTokens('中'.repeat(10)) === 15, `实际 ${estimateTokens('中'.repeat(10))}`)
  // 其余 4 字符 ≈ 1 token
  check('英文按 0.25/字符', estimateTokens('a'.repeat(8)) === 2, `实际 ${estimateTokens('a'.repeat(8))}`)
  check('混排', estimateTokens('中文abc') === Math.ceil(2 * 1.5 + 3 * 0.25))
  check('默认预算是 80000', DEFAULT_CONTEXT_BUDGET === 80_000)
}

console.log('\n[compressContext] 未超预算：零改动')
{
  const msgs = [user('你好'), assistant('在')]
  const r: CompressResult = await compressContext(msgs, { budget: 80_000, model: BAD_MODEL })
  check('compressed 为 null', r.compressed === null)
  check('messages 是同一引用（零拷贝）', r.messages === msgs)
}

console.log('\n[compressContext] 空历史：零改动')
{
  const r = await compressContext([], { budget: 1, model: BAD_MODEL })
  check('compressed 为 null', r.compressed === null)
}

console.log('\n[compressContext] 单轮就超预算：不压缩（最后一轮含本轮输入，绝不能摘要掉）')
{
  const msgs = [user('超长内容'.repeat(5000)), assistant('回答'.repeat(5000))]
  const r = await compressContext(msgs, { budget: 10, model: BAD_MODEL })
  check('compressed 为 null', r.compressed === null)
  check('messages 未变', r.messages === msgs)
}

console.log('\n[compressContext] 摘要失败 → 回退截断（仍要能把请求发出去）')
{
  const history = longHistory(8)
  const r = await compressContext(history, { budget: 20_000, model: BAD_MODEL })
  check('确实触发了压缩', r.compressed !== null)
  if (r.compressed) {
    const c = r.compressed
    check('标记 truncated', c.truncated === true)
    check('压缩后 token 明显变少', c.afterTokens < c.beforeTokens, `${c.beforeTokens} → ${c.afterTokens}`)
    check('摘要了旧轮、保留了近期轮', c.summarizedTurns > 0 && c.keptTurns > 0, `${c.summarizedTurns}/${c.keptTurns}`)
    check('keptTurns ≥ 1（最后一轮必须保留）', c.keptTurns >= 1)
  }
  // 摘要失败时第一条应是「已截断丢弃」的占位说明
  const first = r.messages[0]
  check(
    '首条是截断说明',
    typeof first.content === 'string' && first.content.includes('已截断丢弃'),
    typeof first.content === 'string' ? first.content.slice(0, 40) : '(非字符串)'
  )
  check('结果非空', r.messages.length > 0)
}

console.log('\n[compressContext] 切轮边界：保留比例决定留几轮')
{
  const history = longHistory(4)

  // ratio=0 → 只留最后一轮（它含本轮输入）；ratio=1 → 留「满预算」的近期轮。
  // 注意 ratio=1 **不等于**「全保留」：预算是有限的，超出部分照样要摘要掉。
  const r0 = await compressContext(history, { budget: 10_000, keepRecentRatio: 0, model: BAD_MODEL })
  const r1 = await compressContext(history, { budget: 10_000, keepRecentRatio: 1, model: BAD_MODEL })
  check('ratio=0 时会压缩', r0.compressed !== null)
  check('ratio=0 时只保留 1 轮', r0.compressed?.keptTurns === 1, String(r0.compressed?.keptTurns))
  check('ratio=1 保留的轮数 ≥ ratio=0', (r1.compressed?.keptTurns ?? 0) >= (r0.compressed?.keptTurns ?? 0),
    `${r1.compressed?.keptTurns} vs ${r0.compressed?.keptTurns}`)
  check('ratio=1 时压缩量更小', (r1.compressed?.summarizedTurns ?? 99) <= (r0.compressed?.summarizedTurns ?? 0),
    `${r1.compressed?.summarizedTurns} vs ${r0.compressed?.summarizedTurns}`)

  // 预算大到装得下全部轮次 → 不该触发任何压缩
  const rAll = await compressContext(history, { budget: 10_000_000, model: BAD_MODEL })
  check('预算充足时不压缩', rAll.compressed === null)
}

console.log('\n[compressContext] 预算非法 → 回退默认值')
{
  const r = await compressContext([user('短')], { budget: 0, model: BAD_MODEL })
  check('budget=0 不报错、不压缩', r.compressed === null)
  const r2 = await compressContext([user('短')], { budget: Number.NaN, model: BAD_MODEL })
  check('budget=NaN 不报错、不压缩', r2.compressed === null)
}

console.log('\n[sumUsage] 会话累计')
{
  check('空消息 = 全 0', JSON.stringify(sumUsage([])) === JSON.stringify({
    inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0
  }))

  const usage = (i: number, o: number, t: number, r?: number, c?: number) => ({
    usage: { inputTokens: i, outputTokens: o, totalTokens: t, durationMs: 1, tps: 1, reasoningTokens: r, cachedInputTokens: c }
  })
  const s = sumUsage([
    usage(100, 50, 150, 10, 5),
    { role: 'user' } as never,
    usage(200, 80, 280)
  ])
  check('输入累加', s.inputTokens === 300, String(s.inputTokens))
  check('输出累加', s.outputTokens === 130, String(s.outputTokens))
  check('合计累加', s.totalTokens === 430, String(s.totalTokens))
  check('思考累加', s.reasoningTokens === 10, String(s.reasoningTokens))
  check('缓存累加', s.cachedInputTokens === 5, String(s.cachedInputTokens))

  // totalTokens 按各轮直接相加，不拿 input+output 反推（含缓存额外项时才对得上账单）
  const s2 = sumUsage([usage(100, 50, 999)])
  check('totalTokens 不反推', s2.totalTokens === 999, String(s2.totalTokens))

  // 缺字段的老消息不能变成 NaN
  const s3 = sumUsage([{ usage: { durationMs: 1, tps: 1 } } as never])
  check('缺字段不产生 NaN', s3.inputTokens === 0 && s3.totalTokens === 0)
}

console.log(failed === 0 ? '\n全部通过\n' : `\n${failed} 项失败\n`)
if (failed > 0) process.exit(1)