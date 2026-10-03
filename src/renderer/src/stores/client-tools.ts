/**
 * 客户端工具的渲染端辅助模块：本地注册表 + 权限门 + 回填。
 *
 * 分工（A 方案，见 AGENTS.md「客户端工具」）：
 * - **注册**纯渲染端本地：`registerClientTool(def, handler)` 把定义与执行器记在内存里，
 *   定义随下一次 `agent:chat` 请求携带上去（发送动作统一带上），**不经 IPC 预注册**；
 * - **权限**按 `aiSettings.permissionMode` 在这里处理：`full` 直接执行；
 *   `confirm` 弹 antd Modal 让用户决定 —— 拒绝时把「用户拒绝了这次调用…」作为
 *   **正常工具结果**回填（不是 tool error），模型会看到原因并改道。
 *   **确认不经服务端**：主进程对客户端工具不做任何闸。
 * - **回填**：处理完必须 `window.api.clientTools.resolve(...)`，否则主进程那个
 *   挂起的工具 Promise 永不 settle、当前请求的模型循环卡死（abort 时主进程会
 *   `cancel` 兜底，但正常路径别依赖它）。
 */
import type { ClientToolInfo } from '@shared/types'
import { useAppStore } from './app-store'

type ClientToolHandler = (input: unknown) => Promise<unknown>

/** 工具名 → 执行器（内存态；定义另存一份用于随请求上报） */
const handlers = new Map<string, ClientToolHandler>()
/** 工具名 → 定义（随每次 agent:chat 请求携带） */
const defs = new Map<string, ClientToolInfo>()

/** 注册一个客户端工具（定义立即随下一轮请求上报，handler 立即生效）。同名覆盖旧注册 */
export function registerClientTool(def: ClientToolInfo, handler: ClientToolHandler): void {
  if (!def.name || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(def.name)) {
    throw new Error(`客户端工具名非法：${def.name}（需为字母开头的标识符，≤64 字符）`)
  }
  if (!def.description?.trim()) {
    throw new Error(`客户端工具 ${def.name} 缺少 description（模型靠它决定何时调用）`)
  }
  handlers.set(def.name, handler)
  defs.set(def.name, { name: def.name, description: def.description, inputSchema: def.inputSchema })
}

export function unregisterClientTool(name: string): void {
  handlers.delete(name)
  defs.delete(name)
}

/** 当前已注册的客户端工具定义（发送动作随请求带上；空数组时不带字段） */
export function listClientToolDefs(): ClientToolInfo[] {
  return [...defs.values()]
}

/** 权限门：confirm 模式弹 Modal 让用户决定（居中、含入参预览），full 直接放行 */
async function askPermission(name: string, input: unknown): Promise<boolean> {
  if (useAppStore.getState().aiSettings.permissionMode !== 'confirm') return true
  const { Modal } = await import('antd')
  let preview = ''
  try {
    preview = JSON.stringify(input ?? null, null, 2)
  } catch {
    preview = String(input)
  }
  if (preview.length > 600) preview = `${preview.slice(0, 600)}…`
  return new Promise<boolean>((resolve) => {
    Modal.confirm({
      title: `允许 AI 调用客户端工具「${name}」？`,
      content: preview ? `入参：\n${preview}` : '该工具没有入参。',
      okText: '允许',
      cancelText: '拒绝',
      onOk: () => resolve(true),
      onCancel: () => resolve(false)
    })
  })
}

/**
 * invoke 事件的统一入口（App 装配时订阅 `clientTools:invoke`）。
 * 按权限策略处理后回填；**任何分支都必须回填一次**，否则主进程悬挂。
 */
export async function handleClientToolInvoke(payload: {
  callId: string
  name: string
  input: unknown
}): Promise<void> {
  const resolve = (r: { ok: boolean; result?: unknown; error?: string }) =>
    void window.api.clientTools.resolve({ callId: payload.callId, ...r })
  const handler = handlers.get(payload.name)
  if (!handler) {
    resolve({ ok: false, error: `客户端工具未注册（渲染端）：${payload.name}` })
    return
  }
  let approved: boolean
  try {
    approved = await askPermission(payload.name, payload.input)
  } catch (err) {
    resolve({ ok: false, error: `权限确认失败：${err instanceof Error ? err.message : String(err)}` })
    return
  }
  if (!approved) {
    // 拒绝是「预期内的结果」：作为正常工具结果回传，让模型看到原因后自行调整
    resolve({
      ok: true,
      result: `用户拒绝了这次调用（客户端工具 ${payload.name}）。请询问用户接下来希望怎么做，不要擅自重试同一步。`
    })
    return
  }
  try {
    const result = await handler(payload.input)
    resolve({ ok: true, result })
  } catch (err) {
    resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
