/**
 * 探针：找出「一轮里堆出多段 ⚠️ 文案」的真实来源。
 *
 * 已排除：**不是**「每次重试各发一个 error chunk」。用 always-500 假模型实测：
 * maxRetries=0 → 1 个 error chunk；maxRetries=2（模型被调 3 次）→ 仍只有 1 个。
 * 多步（先工具调用、后失败）也只有 1 个。
 *
 * 本探针穷举「流已开后失败」的几种形态，因为那是唯一还可能有**两个** error 事件的形状 ——
 * 渲染端 `error` 事件既可能来自 mastra 的 error chunk（`adaptMastraPart`），
 * 又可能来自 `consumeMastraStream` 的 catch（for-await 抛出）。两者都发 = 两段文案。
 *
 * 形态：
 *   immediate-throw  doStream 直接抛（没开流）
 *   mid-chunk-error  开流后由 provider 吐一个 `{type:'error'}` chunk
 *   mid-iter-throw   开流后迭代器自己抛
 *   mid-chunk-then-throw  先吐 error chunk 再抛（最坏情况）
 *
 * 用法：node scripts/probe-mastra-error-chunks.mjs
 */
import { Agent } from '@mastra/core/agent'
import { APICallError } from '@ai-sdk/provider'

const boom = () =>
  new APICallError({
    message: 'probe: 模拟中断',
    url: 'http://127.0.0.1:1/probe',
    requestBodyValues: {},
    statusCode: 500,
    isRetryable: true
  })

function makeModel(mode) {
  let calls = 0
  const model = {
    specificationVersion: 'v2',
    provider: 'probe',
    modelId: mode,
    doStream: async () => {
      calls++
      if (mode === 'immediate-throw') throw boom()
      const src = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: 't1' })
          controller.enqueue({ type: 'text-delta', id: 't1', delta: '说了一半，' })
          if (mode === 'mid-chunk-error' || mode === 'mid-chunk-then-throw') {
            controller.enqueue({ type: 'error', error: boom() })
          }
          if (mode === 'mid-iter-throw' || mode === 'mid-chunk-then-throw') {
            controller.error(boom())
          } else {
            controller.close()
          }
        }
      })
      return { stream: src }
    }
  }
  return { model, calls: () => calls }
}

for (const mode of ['immediate-throw', 'mid-chunk-error', 'mid-iter-throw', 'mid-chunk-then-throw']) {
  const { model, calls } = makeModel(mode)
  const agent = new Agent({ id: 'p', name: 'P', instructions: 'p', model })
  const errors = []
  let text = ''
  let finishes = 0
  let threw = null
  try {
    const { fullStream } = await agent.stream('hi', { modelSettings: { maxRetries: 0 } })
    for await (const part of fullStream) {
      if (part.type === 'error') errors.push(part.error?.message ?? '(none)')
      if (part.type === 'text-delta') text += part.text
      if (part.type === 'finish') finishes++
    }
  } catch (e) {
    threw = e
  }
  console.log(
    `mode=${mode.padEnd(22)} 调用 ${calls()} 次 | error chunk ${errors.length} | finish ${finishes} | ` +
      `for-await ${threw ? '抛出' : '未抛'} | 正文 ${JSON.stringify(text)}`
  )
  errors.forEach((e, i) => console.log(`      error#${i + 1}: ${e}`))
}
