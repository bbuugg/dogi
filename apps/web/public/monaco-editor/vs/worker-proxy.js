/*
 * Monaco worker 的同源代理壳（scripts/copy-monaco.cjs 生成，勿手改）。
 *
 * 与 monaco 自带的 blob 壳语义一致：注册 trustedTypes 策略 -> importScripts 目标 worker
 * -> 发 ready 握手。区别只有一处 —— 这里是**同源文件**（worker-src 'self' 可放行），
 * 而 blob 在 MV3 扩展页面的 CSP 下被 Chrome 禁掉。目标地址从查询串 ?u= 读（绝对地址、
 * 由宿主按 worker-map.json 算好），同源才放行，防滥用。
 */
const requested = new URLSearchParams(self.location.search).get('u')
if (!requested || !requested.startsWith(self.location.origin + '/')) {
  throw new Error('monaco-worker-proxy: 非同源的目标地址被拒绝：' + requested)
}
globalThis.workerttPolicy = globalThis.trustedTypes?.createPolicy('defaultWorkerFactory', {
  createScriptURL: (value) => value
})
importScripts(requested)
globalThis.postMessage({ type: 'vscode-worker-ready' })
