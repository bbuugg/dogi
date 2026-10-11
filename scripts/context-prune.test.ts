/**
 * 工具输出剪枝的纯逻辑验证（真源码，由 `verify-context-prune.mjs` 包装执行）。
 *
 * 覆盖 `agent-core/prune.ts` 的全部不需要真实模型的语义：
 * 未超预算零拷贝、按「从新到旧」保留、省不够不动手、保护工具不剪、协议结构不变。
 *
 * ⚠️ 阈值是**绝对 token**（由调用方按窗口缩放后传入），这里直接传小数值来构造场景，
 * 不去 mock 上下文窗口 —— 缩放的逻辑在 `agent.ts` 的 `pruneBudget` 里，属于集成层。
 */
import { pruneToolOutputs, PRUNE_PROTECT_TOOLS } from '../ai/agent-core/prune.ts'
import { estimateTokens } from '../shared/context-budget.ts'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`)
  }
}

/** 造一条 tool 消息 */
function toolMsg(parts: unknown[]): { role: 'tool'; content: unknown[] } {
  return { role: 'tool', content: parts }
}

/** 造一个 tool-result 部件（默认 text 输出） */
function tr(
  toolName: string,
  value: unknown,
  id = 'c1',
  outputType: 'text' | 'json' | 'error-text' = 'text'
): Record<string, unknown> {
  return {
    type: 'tool-result',
    toolCallId: id,
    toolName,
    output: { type: outputType, value }
  }
}

/** 造一段约 `tokens` 个 token 的中文文本（中文 1 字 = 1.5 token） */
function zh(tokens: number): string {
  return '中'.repeat(Math.ceil(tokens / 1.5))
}

console.log('\n[未超预算：零拷贝]')
{
  const msgs = [toolMsg([tr('read_file', zh(100))])]
  const r = pruneToolOutputs(msgs as never, { protectTokens: 1000, minTokens: 100 })
  check('返回同一引用（零拷贝）', r.messages === msgs)
  check('未剪枝条数为 0', r.prunedToolResults === 0)
  check('省下 0 token', r.savedTokens === 0)
}

console.log('\n[超预算：从新到旧保留，旧的剪掉]')
{
  // 每条 ~6000 token，共 5 条（新→旧）。protect=10000 → 只保得住最新一条
  const parts = [
    tr('read_file', zh(6000), 'old1'),
    tr('read_file', zh(6000), 'old2'),
    tr('read_file', zh(6000), 'old3'),
    tr('read_file', zh(6000), 'old4'),
    tr('read_file', zh(6000), 'newest')
  ]
  const msgs = [toolMsg(parts)]
  const r = pruneToolOutputs(msgs as never, { protectTokens: 10_000, minTokens: 5000 })
  check('动了手（新引用）', r.messages !== msgs)
  check('剪掉 4 条', r.prunedToolResults === 4, `实际 ${r.prunedToolResults}`)
  check('省下 > 0', r.savedTokens > 0)

  const outParts = (r.messages[0] as { content: Array<Record<string, unknown>> }).content
  const newestOut = outParts[4] as { output: { value: string } }
  check('最新一条保持原文', newestOut.output.value.includes('中'))
  const oldOut = outParts[0] as { output: { type: string; value: string } }
  check('最旧一条被换成占位符', oldOut.output.type === 'text' && oldOut.output.value.includes('省略'))
  check('占位符不残留原文', !oldOut.output.value.includes('中'))
}

console.log('\n[省不够 minTokens：不动手]')
{
  const msgs = [toolMsg([tr('read_file', zh(6000))])]
  const r = pruneToolOutputs(msgs as never, { protectTokens: 1000, minTokens: 100_000 })
  check('返回同一引用', r.messages === msgs)
  check('未剪枝', r.prunedToolResults === 0)
}

console.log('\n[协议结构不变：toolCallId / toolName 原样保留]')
{
  const msgs = [toolMsg([tr('execute_command', zh(6000), 'call-abc')])]
  const r = pruneToolOutputs(msgs as never, { protectTokens: 100, minTokens: 100 })
  const p = (r.messages[0] as { content: Array<Record<string, unknown>> }).content[0]
  check('toolCallId 不变', p.toolCallId === 'call-abc')
  check('toolName 不变', p.toolName === 'execute_command')
  check('type 仍是 tool-result', p.type === 'tool-result')
}

console.log('\n[保护工具永不剪枝]')
{
  const msgs = [
    toolMsg([tr('read_skill', zh(6000), 's1')]),
    toolMsg([tr('read_file', zh(6000), 'f1')]),
    toolMsg([tr('read_file', zh(6000), 'f2')])
  ]
  const r = pruneToolOutputs(msgs as never, { protectTokens: 100, minTokens: 100 })
  check('剪掉了 read_file 的两条', r.prunedToolResults === 2, `实际 ${r.prunedToolResults}`)
  const skillPart = (r.messages[0] as { content: Array<Record<string, unknown>> }).content[0]
  check('read_skill 输出未变（同一部件引用）', skillPart === msgs[0].content[0])
  check('read_skill 名单里确实有它', PRUNE_PROTECT_TOOLS.includes('read_skill'))
}

console.log('\n[未剪的部件保持同一引用；混排消息只改该改的]')
{
  // keep 只有 ~50 token，落在 protectTokens=100 的保留预算内；drop 6000 token 必然被剪
  const keepPart = tr('read_file', zh(50), 'keep')
  const msgs = [
    { role: 'user', content: 'hi' },
    toolMsg([keepPart, tr('read_file', zh(6000), 'drop')])
  ]
  const r = pruneToolOutputs(msgs as never, { protectTokens: 100, minTokens: 100 })
  check('user 消息同一引用', r.messages[0] === msgs[0])
  const outContent = (r.messages[1] as { content: unknown[] }).content
  check('未剪的部件同一引用', outContent[0] === keepPart)
  check('被剪的部件是新对象', outContent[1] !== msgs[1].content[1])
}

console.log('\n[非 text 输出（json / error-text）也能估算与替换]')
{
  const msgs = [
    toolMsg([tr('read_file', { big: zh(6000) }, 'j1', 'json')]),
    toolMsg([tr('read_file', zh(6000), 'e1', 'error-text')])
  ]
  const r = pruneToolOutputs(msgs as never, { protectTokens: 100, minTokens: 100 })
  check('两条都被剪', r.prunedToolResults === 2, `实际 ${r.prunedToolResults}`)
  const p = (r.messages[0] as { content: Array<{ output: { type: string } }> }).content[0]
  check('被剪后统一是 text 占位符', p.output.type === 'text')
}

console.log('\n[空输入 / 无 tool 消息：零拷贝]')
{
  const empty: unknown[] = []
  check('空数组同一引用', pruneToolOutputs(empty as never).messages === empty)
  const noTool = [{ role: 'user', content: 'hi' }]
  check('无 tool 消息同一引用', pruneToolOutputs(noTool as never).messages === noTool)
}

console.log('\n[estimateTokens 与剪枝口径一致]')
{
  const text = zh(6000)
  check('估算值落在预期量级', Math.abs(estimateTokens(text) - 6000) < 10)
}

if (failed > 0) {
  console.log(`\n✗ ${failed} 条断言失败`)
  process.exit(1)
}
console.log('\n✓ ALL PASS')
