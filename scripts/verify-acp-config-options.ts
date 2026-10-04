/**
 * 验证 ACP 会话配置项与 usage_update 的映射（**直接跑 `acp-config-options.ts` 真源码**）。
 *
 * 跑法：`node --experimental-strip-types scripts/verify-acp-config-options.ts`
 *（纯逻辑、不引 electron、不起 Electron；见 AGENTS 4.18「配置项」小节）
 *
 * 覆盖：
 * - select / boolean 的收下与丢弃规则（没 id、没候选项、未知 type 都丢掉）；
 * - 分组结构（`{ options: [...] }`）被拍平，缺 name 时退回 value；
 * - **未知 / 缺失 category 一律放过**（协议要求优雅处理 —— 自定义项天然可用）；
 * - 模型项的提取（category=model 的 select），以及非 model 项不误取；
 * - `usage_update` → `context-usage`；数字缺失时返回 null（不用 0 冒充）。
 */
import assert from 'node:assert/strict'
import {
  extractConfigOptions,
  extractModelOption,
  usageUpdateToEvent
} from '../src/main/services/ai/acp-config-options.ts'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, `FAIL: ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
  passed++
  console.log(`  ok  ${label}`)
}

// ---------- 空输入 ----------
check('null / undefined / [] → 空数组', extractConfigOptions(null).length === 0 &&
  extractConfigOptions(undefined).length === 0 &&
  extractConfigOptions([]).length === 0)
check('空配置 → 模型项为 null', extractModelOption(null) === null)

// ---------- select：分组拍平 / name 缺失退回 value ----------
{
  const opts = extractConfigOptions([
    {
      id: 'reasoning',
      name: '思考档位',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: '低' },
        { name: '无 name 的分组', options: [{ value: 'medium' }, { value: 'high', name: '高' }] }
      ]
    }
  ])
  check('select 收下', opts.length === 1 && opts[0].id === 'reasoning')
  check(
    '分组被拍平、缺 name 退回 value',
    JSON.stringify(opts[0].options) ===
      JSON.stringify([
        { value: 'low', name: '低' },
        { value: 'medium', name: 'medium' },
        { value: 'high', name: '高' }
      ]),
    opts[0].options
  )
  check('category 原样保留', opts[0].category === 'thought_level')
  check('当前值原样带回', opts[0].currentValue === 'high')
}

// ---------- 丢弃规则 ----------
{
  const opts = extractConfigOptions([
    { name: '没有 id', type: 'select', currentValue: 'a', options: [{ value: 'a' }] },
    { id: 'no-candidates', name: '没有候选项', type: 'select', currentValue: 'a', options: [] },
    { id: 'weird', name: '未知 type', type: 'color' },
    { id: 'ok', name: '正常', type: 'boolean', currentValue: true }
  ])
  check(
    '没 id / 没候选项 / 未知 type 一律丢掉，只剩 boolean',
    opts.length === 1 && opts[0].id === 'ok',
    opts
  )
  check('boolean 当前值是 true / options 为空', opts[0].type === 'boolean' &&
    opts[0].currentValue === true && opts[0].options.length === 0)
}

// ---------- category 缺失 / 未知：一律放过（协议要求优雅处理） ----------
{
  const opts = extractConfigOptions([
    { id: 'x', type: 'select', currentValue: '1', options: [{ value: '1', name: '一' }] },
    { id: 'y', name: '未来项', category: 'some-future-category', type: 'boolean', currentValue: false }
  ])
  check('category 缺失不丢', opts.length === 2 && opts[0].category === undefined)
  check('未知 category 也收下（不做白名单）', opts[1].category === 'some-future-category')
  check('缺 name 时退回 id', opts[0].name === 'x')
}

// ---------- 模型项 ----------
{
  const raw = [
    {
      id: 'thought',
      name: '思考',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [{ value: 'high', name: '高' }]
    },
    {
      id: 'model',
      name: '模型',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-5',
      options: [
        { value: 'gpt-5', name: 'GPT-5' },
        { name: 'OpenAI', options: [{ value: 'o3', name: 'o3' }] }
      ]
    }
  ]
  const model = extractModelOption(raw)
  check(
    '模型项被提取（分组也拍平）',
    model?.optionId === 'model' && model?.currentValue === 'gpt-5' && model?.models.length === 2,
    model
  )
  check('没有 model 项 → null', extractModelOption([raw[0]]) === null)
}

// ---------- usage_update ----------
{
  const ev = usageUpdateToEvent({ sessionUpdate: 'usage_update', used: 12345, size: 200000 })
  check(
    'usage_update → context-usage（used / size）',
    ev?.type === 'context-usage' && ev.used === 12345 && ev.budget === 200000,
    ev
  )
  check('别的 sessionUpdate → null', usageUpdateToEvent({ sessionUpdate: 'plan' }) === null)
  check(
    '数字缺失 → null（不用 0 冒充「上游报的 0」）',
    usageUpdateToEvent({ sessionUpdate: 'usage_update', used: 10 }) === null &&
      usageUpdateToEvent({ sessionUpdate: 'usage_update', size: 10 }) === null &&
      usageUpdateToEvent({ sessionUpdate: 'usage_update', used: '10', size: 20 }) === null
  )
  check(
    'used = 0 也照发（真的没占上下文是有意义的信息）',
    usageUpdateToEvent({ sessionUpdate: 'usage_update', used: 0, size: 0 })?.type === 'context-usage'
  )
}

console.log(`\nALL PASS（${passed} 条）`)