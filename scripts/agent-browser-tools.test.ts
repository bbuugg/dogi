/**
 * Agent 浏览器工具集的行为验证 —— **直接跑 src/main/services/browser/agent.ts 的真源码**。
 *
 * 不要用 `node` 直接跑本文件：源码里的相对 import 没写扩展名、`@shared/*` 是 tsconfig
 * 别名，`--experimental-strip-types` 解析不了。请跑包装脚本，它会把需要的文件复制到
 * `.tooltest/` 并改写 import 说明符：
 *
 *   node scripts/verify-agent-browser-tools.mjs
 *
 * 复制的是真文件、只改 import 说明符，不是手抄逻辑（见 skill「node-run-ts-without-build」）。
 *
 * 用一个本地假站点当被测目标（不打真实上游），覆盖：
 * navigate → 快照拿 ref → 按 ref 点击 → evaluate 验证页面真实状态 → type（含中文）
 * → press → wait_for → screenshot 落盘 → close → close 后能重新懒启动。
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildBrowserToolDefs } from './browser/agent.ts'

const FIX = join(process.env.TEMP ?? process.env.TMP ?? '.', 'dogi-agent-browser-test')
rmSync(FIX, { recursive: true, force: true })
mkdirSync(FIX, { recursive: true })

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}

// ---------------------------------------------------------------------------
// 假站点
// ---------------------------------------------------------------------------
const PAGE = `<!doctype html><meta charset="utf-8"><title>工具测试页</title>
<h1>欢迎</h1>
<label>用户名 <input id="u" data-testid="user" placeholder="用户名"></label>
<button id="go" data-testid="go">提交</button>
<p id="out"></p>
<script>
  window.__clicked = 0
  document.getElementById('go').addEventListener('click', () => {
    window.__clicked++
    document.getElementById('out').textContent = '已提交'
  })
</script>`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
  res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/`
console.log('假站点:', base)

// ---------------------------------------------------------------------------
// 工具集
// ---------------------------------------------------------------------------
// 新 API：buildBrowserToolDefs 返回**静态定义**，会话绑定（sessionId 由
// conversationId 推导 / 截图落盘根目录 / 渠道偏好）全部经 ToolRunContext 注入。
// 这里不需要 AI 运行时，手工把定义包成可直接 execute 的形状。
const ctx = {
  requestId: 'r1',
  conversationId: 'selftest',
  scope: 'workspace' as const,
  workspace: { id: 'w', name: 'w', path: FIX, createdAt: 0, updatedAt: 0 },
  signal: new AbortController().signal,
  permissionMode: 'full' as const,
  requestConfirm: async () => true
}
const tools = Object.fromEntries(
  buildBrowserToolDefs({ channel: () => 'auto' }).map((d) => [
    d.name,
    {
      execute: (input: unknown, options: { toolCallId: string }): Promise<unknown> =>
        d.execute(input, { toolCallId: options.toolCallId }, ctx)
    }
  ])
)
const call = (t: { execute?: unknown }, args: unknown): Promise<unknown> =>
  (t.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, {
    toolCallId: 'test',
    messages: []
  })

const toolNames = Object.keys(tools).sort()
console.log('工具集:', toolNames.join(', '))
check(
  '工具集包含全部浏览器工具',
  [
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_wait_for',
    'browser_evaluate',
    'browser_screenshot',
    'browser_close'
  ].every((n) => toolNames.includes(n)),
  toolNames
)

try {
  // 1. 导航 + 快照
  const nav = (await call(tools.browser_navigate, { url: base })) as string
  check(
    'browser_navigate 返回页面快照',
    typeof nav === 'string' && nav.includes('URL：'),
    nav?.slice?.(0, 200)
  )
  check('快照含 [ref=eN] 引用', /\[ref=e\d+\]/.test(nav))
  check('快照含可访问名称「提交」', nav.includes('提交'))

  // 2. 从快照解析出按钮 ref（模拟模型「照着 ref 点」）
  const goLine = nav.split('\n').find((l) => l.includes('提交') && l.includes('[ref='))
  const goRef = goLine?.match(/\[ref=(e\d+)\]/)?.[1]
  check('能从快照里解析出按钮 ref', Boolean(goRef), goLine)

  // 3. 按 ref 点击
  const clicked = (await call(tools.browser_click, { ref: goRef })) as string
  check(
    'browser_click 执行成功',
    typeof clicked === 'string' && clicked.includes('已点击'),
    clicked?.slice?.(0, 200)
  )
  check('点击后快照反映页面变化（已提交）', typeof clicked === 'string' && clicked.includes('已提交'))

  // 4. evaluate 验证页面真实状态（不看返回值，看 DOM 里的计数）
  const count = (await call(tools.browser_evaluate, { expression: 'window.__clicked' })) as string
  check('browser_evaluate 读到点击计数 = 1', count.trim() === '1', count)

  // 5. 输入（含中文 —— 验证编码没坏）
  const typed = (await call(tools.browser_type, { selector: '#u', text: '阿墨' })) as string
  check(
    'browser_type 执行成功',
    typeof typed === 'string' && typed.includes('已输入'),
    typed?.slice?.(0, 200)
  )
  const value = (await call(tools.browser_evaluate, {
    expression: "document.getElementById('u').value"
  })) as string
  check('输入框内容正确（中文未乱码）', value.includes('阿墨'), value)

  // 6. 按键
  const pressed = (await call(tools.browser_press, { key: 'Enter' })) as string
  check('browser_press 执行成功', typeof pressed === 'string', pressed?.slice?.(0, 120))

  // 7. 等待文本
  const waited = (await call(tools.browser_wait_for, { text: '已提交' })) as string
  check('browser_wait_for 命中文本', typeof waited === 'string' && waited.includes('已出现'), waited)

  // 8. 截图落盘到工作区
  const shot = (await call(tools.browser_screenshot, { path: 'shots/a.png' })) as string
  const shotAbs = join(FIX, 'shots', 'a.png')
  check('browser_screenshot 报告保存路径', typeof shot === 'string' && shot.includes('shots/a.png'), shot)
  check('截图文件真的落盘且非空', existsSync(shotAbs) && statSync(shotAbs).size > 1000, shot)

  // 9. 关闭
  const closed = (await call(tools.browser_close, {})) as string
  check('browser_close 执行成功', closed.includes('已关闭'), closed)

  // 10. 关掉之后还能重新懒启动（会话在池里是 closed 终态，必须能重建）
  const again = (await call(tools.browser_navigate, { url: base })) as string
  check(
    '关闭后能重新懒启动浏览器',
    typeof again === 'string' && again.includes('工具测试页'),
    again?.slice?.(0, 160)
  )
  await call(tools.browser_close, {})
} catch (err) {
  fail++
  console.log(
    '  FAIL 抛异常:',
    err instanceof Error ? (err.stack ?? err.message).split('\n').slice(0, 4).join('\n') : String(err)
  )
} finally {
  server.close()
  rmSync(FIX, { recursive: true, force: true })
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
