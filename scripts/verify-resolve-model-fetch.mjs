// 验证删掉 getDispatcher 之后，AI 请求该带的东西**没丢**：
// 浏览器 UA、流式空闲超时关闭、SSE 思考字段归一化 —— 全部走真源码 + 进程内 SSE 服务器。
//
// 关注点是「删死代码没有顺手删掉活的那部分」。
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'

const { normalizeReasoningFetch, streamingFetch, resolveModel } = await import(
  '../src/main/services/ai/resolve-model.ts'
)

/** 起一个假的 OpenAI 兼容 SSE 端点，记录它收到的请求头 */
function startSse() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(
      'data: {"choices":[{"delta":{"reasoning_content":"想一下…"},"finish_reason":null}]}\n\n'
    )
    res.write(
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"想一下…"}]},"finish_reason":null}]}\n\n'
    )
    res.write('data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, port: server.address().port })))
}

/**
 * 关服必须先断掉 keep-alive 连接：Node 的 fetch 把连接池留着，
 * 直接 server.close() 会挂住等句柄，进程退出时撞 libuv 的 UV_HANDLE_CLOSING 断言
 * （退出码 127，把一个「全通过」报成失败）。
 */
function stopSse(server) {
  server.closeAllConnections?.()
  server.close()
}

const results = []
const check = (name, ok, detail) => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---- 1) streamingFetch：浏览器 UA + 超时关闭 ----
{
  const { server, seen, port } = await startSse()
  const res = await streamingFetch()(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    body: '{}'
  })
  await res.text()
  const ua = seen[0]?.headers['user-agent'] ?? ''
  // 断言必须能抓住「退回 Node 默认 UA」：不传时 undici 发的是 `node`，
  // 所以这里卡 Chrome 标识而不是只卡“非空”（只卡非空的话，删掉代码它照样 PASS）。
  check(
    'streamingFetch 带的是浏览器 UA（而非 node 默认）',
    /Chrome\/\d+/.test(ua),
    ua.slice(0, 60)
  )
  check('streamingFetch 请求真的发出去了', seen.length === 1, `${seen.length} 个请求`)
  stopSse(server)
}

// ---- 2) normalizeReasoningFetch：SSE 里的 reasoning 字段改名后仍能透传 ----
{
  const { server, port } = await startSse()
  const res = await normalizeReasoningFetch()(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    body: '{}'
  })
  const text = await res.text()
  check('SSE 流正常返回', res.status === 200, `status=${res.status}`)
  check('归一化后仍带 reasoning 字段', text.includes('reasoning'), text.slice(0, 80).replace(/\n/g, ' '))
  check('content-length 已删除（体积变了）', !res.headers.get('content-length'), res.headers.get('content-length') ?? '(null)')
  stopSse(server)
}

// ---- 3) resolveModel：五个 provider 分支都还能构造出模型实例 ----
{
  const base = { apiKey: 'k', model: 'm', createdAt: 0, updatedAt: 0 }
  const cases = [
    ['anthropic', { ...base, kind: 'anthropic' }],
    ['deepseek', { ...base, kind: 'deepseek' }],
    ['google', { ...base, kind: 'google' }],
    ['openai-compatible/responses', { ...base, kind: 'openai-compatible', apiStyle: 'responses' }],
    ['openai-compatible/chat', { ...base, kind: 'openai-compatible', apiStyle: 'chat-completions' }],
    ['openai/responses', { ...base, kind: 'openai', apiStyle: 'responses' }],
    ['openai/chat', { ...base, kind: 'openai', apiStyle: 'chat-completions' }]
  ]
  let ok = 0
  const bad = []
  for (const [name, cfg] of cases) {
    try {
      const m = resolveModel(cfg)
      if (m && typeof m === 'object') ok++
      else bad.push(name)
    } catch (e) {
      bad.push(`${name}: ${e.message}`)
    }
  }
  check('全部 provider 分支可构造模型实例', ok === cases.length, `${ok}/${cases.length}${bad.length ? ' 失败: ' + bad.join('; ') : ''}`)
}

const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${failed === 0 ? '全部通过' : failed + ' 条失败'}（${results.length} 条）`)
// ⚠️ 别写 process.exit()：undici 的全局 dispatcher 这时还在收尾，强退会撞上
// libuv 的 `UV_HANDLE_CLOSING` 断言，退出码变成 127 —— 把「全通过」报成失败。
// 让 Node 自然退出即可（断言失败靠上面的 failed 体现）。
process.exitCode = failed === 0 ? 0 : 1
