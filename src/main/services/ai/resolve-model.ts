/**
 * 由模型配置创建 AI SDK 的模型实例。
 *
 * 单独成文件（不依赖 electron / node-pty）是为了能直接跑真代码做验证：
 * `node --experimental-strip-types scripts/probe-reasoning.mjs` 就能把这里
 * 接上真实网关，实测「思考内容」到底有没有出来 —— 见该脚本。
 */
import { type LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { AiModelConfig } from '@shared/types'

// ---------- 兼容网关的 SSE 字段归一化（思考内容 + 工具调用增量） ----------

const sseDecoder = new TextDecoder()
const sseEncoder = new TextEncoder()

/**
 * 把一行 SSE `data:` 里「各家网关的野写法」改写成 AI SDK 认得的标准字段。
 *
 * 目前归一化两类（都是实测踩到、且会直接中断整条流的）：
 * 1. 思考字段：`reasoning` / `reasoning_details` → `reasoning_content`
 * 2. 工具调用增量：空串的 `tool_calls[].type` → `"function"`，`function` 壳缺失时补齐
 *
 * 不是 data 行、`[DONE]`、解析失败、没有 delta —— 一律原样返回。
 */
export function rewriteSseLine(line: string): string {
  if (!line.startsWith('data:')) return line
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return line
  let json: unknown
  try {
    json = JSON.parse(payload)
  } catch {
    return line
  }
  const delta = (json as { choices?: { delta?: Record<string, unknown> }[] })?.choices?.[0]?.delta
  if (!delta || typeof delta !== 'object') return line

  let changed = false

  // ---- 1. 思考内容 ----
  if (delta.reasoning_content === undefined) {
    let text = ''
    if (typeof delta.reasoning === 'string') {
      text = delta.reasoning
    } else if (Array.isArray(delta.reasoning_details)) {
      for (const detail of delta.reasoning_details) {
        const t = (detail as { text?: unknown })?.text
        if (typeof t === 'string') text += t
      }
    }
    if (text) {
      delta.reasoning_content = text
      changed = true
    }
  }

  // ---- 2. 工具调用增量 ----
  if (normalizeDeltaToolCalls(delta)) changed = true

  return changed ? `data: ${JSON.stringify(json)}` : line
}

/**
 * 修掉各家网关在流式 `tool_calls` 上的野写法，返回是否改动过。
 *
 * AI SDK 的 chat chunk schema 里 `tool_calls[].type` 是 **字面量** `z.literal('function')`
 * （且 `function` 对象必须存在），空串 / 缺字段会直接 `invalid_union` —— 整条流被丢弃，
 * 界面表现就是「工具调用刚开始就报错中断」。
 *
 * 实测 StepFun（step-5-preview）：首个增量正常发 `type: "function"`，**后续增量把 `type`、`id`、
 * `name` 全发成空串**（只带 `arguments` 片段），AI SDK 原样校验必然失败。
 */
function normalizeDeltaToolCalls(delta: Record<string, unknown>): boolean {
  const calls = delta.tool_calls
  if (!Array.isArray(calls)) return false
  let changed = false
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue
    const tc = call as Record<string, unknown>
    if (tc.type !== 'function') {
      tc.type = 'function'
      changed = true
    }
    if (!tc.function || typeof tc.function !== 'object') {
      // 少数网关把 name / arguments 平铺在 tool_call 上，或压根不发 function 壳
      tc.function = {
        name: typeof tc.name === 'string' ? tc.name : '',
        arguments: typeof tc.arguments === 'string' ? tc.arguments : ''
      }
      changed = true
    }
  }
  return changed
}

/**
 * 归一化 fetch：把 SSE 流里的字段改写成 AI SDK 认得的标准形式。
 *
 * 除了思考字段（见上），还要修**工具调用增量** —— StepFun 之类网关会在后续增量里把
 * `tool_calls[].type` 发成空串，而 AI SDK 的 chunk schema 是字面量 `"function"`，
 * 空串会触发 `invalid_union`，整条流直接报「Type validation failed」失败。
 *
 * OpenAI 官方的 chat-completions 协议里没有「思考」这个概念，各家兼容网关就各造了一套：
 * - GLM / airouter / StepFun：`delta.reasoning_content`（字符串）
 * - OpenRouter：`delta.reasoning`（字符串）+ `delta.reasoning_details`（数组）
 *
 * 实测（`scripts/probe-reasoning.mjs`，4 个配置全跑）：
 * - `@ai-sdk/openai` 的 chat-completions 分支对上述字段**一个都不解析**，reasoning 恒为 0 字；
 * - `@ai-sdk/deepseek` 只认 `reasoning_content`（GLM / airouter / StepFun 命中，OpenRouter 落空）。
 *
 * 所以这里在 fetch 层做一次字段改名，再交给 deepseek 的 chat 模型解析 ——
 * 既不用自己实现整套 OpenAI 协议，也不依赖具体是哪个网关。
 */
export function normalizeReasoningFetch(
  ...args: Parameters<typeof globalThis.fetch>
): ReturnType<typeof globalThis.fetch> {
  return globalThis.fetch(...args).then((res) => {
    const contentType = res.headers.get('content-type') ?? ''
    if (!res.body || !contentType.includes('text/event-stream')) return res

    let buffer = ''
    const stream = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += sseDecoder.decode(chunk, { stream: true })
          const lines = buffer.split('\n')
          // 最后一段可能是被切断的半行，留在缓冲里等下一块
          buffer = lines.pop() ?? ''
          if (!lines.length) return
          controller.enqueue(sseEncoder.encode(lines.map(rewriteSseLine).join('\n') + '\n'))
        },
        flush(controller) {
          if (buffer) controller.enqueue(sseEncoder.encode(rewriteSseLine(buffer)))
        }
      })
    )
    const headers = new Headers(res.headers)
    // 体积/编码已变，留着会让上层按错误的长度或压缩方式解析
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(stream, { status: res.status, statusText: res.statusText, headers })
  })
}

/**
 * 根据配置创建对应 provider 的模型实例（agent 服务复用）。
 *
 * ⚠️ `openai-compatible` 的 chat-completions 走的是 **deepseek** 的 chat 模型，不是 openai 的 ——
 * 因为只有它会解析 `reasoning_content`，openai 的实现会把思考内容整段丢掉（见 normalizeReasoningFetch）。
 * 两者发的都是标准 OpenAI chat-completions 请求，差异仅在响应解析。
 */
export function resolveModel(config: AiModelConfig, modelId?: string): LanguageModel {
  // 会话按「配置 / 模型 id」两级选择：显式传了 modelId 就用它，缺省用配置的默认模型
  const model = modelId || config.model
  switch (config.kind) {
    case 'anthropic': {
      const provider = createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL })
      return provider(model)
    }
    case 'deepseek': {
      const provider = createDeepSeek({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        fetch: normalizeReasoningFetch
      })
      return provider(model)
    }
    case 'google': {
      const provider = createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: config.baseURL })
      return provider(model)
    }
    case 'openai-compatible': {
      const style = config.apiStyle ?? 'chat-completions'
      if (style === 'responses') {
        const provider = createOpenAI({
          apiKey: config.apiKey ?? 'EMPTY',
          baseURL: config.baseURL,
          fetch: normalizeReasoningFetch
        })
        return provider.responses(model)
      }
      const provider = createDeepSeek({
        apiKey: config.apiKey ?? 'EMPTY',
        baseURL: config.baseURL,
        fetch: normalizeReasoningFetch
      })
      return provider(model)
    }
    case 'openai':
    default: {
      // openai 官方：默认 Responses API（官方 chat-completions 里本就没有思考内容可解析）
      const style = config.apiStyle ?? 'responses'
      const provider = createOpenAI({
        apiKey: config.apiKey ?? 'EMPTY',
        baseURL: config.baseURL,
        // 官方不会发 type:"" 这种脏数据，但用户可能把 kind:'openai' 指向兼容网关
        fetch: normalizeReasoningFetch
      })
      return style === 'responses' ? provider.responses(model) : provider.chat(model)
    }
  }
}
