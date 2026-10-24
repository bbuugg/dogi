/**
 * 内置插件：每轮对话追加一段自定义系统提示词。
 *
 * 用途是给所有会话加一层稳定的「长期约定」（回复语言、代码风格、默认工作方式等），
 * 不必每开一个会话都重新说一遍。正文在 设置 →「全局插件」→「系统提示词」里填。
 *
 * ## 为什么用 `ctx.prompt.section` 而不是 `prompt:render` 钩子
 *
 * `prompt:render` 拿到的是已经拼好的整段正文，插件得自己找位置插入 / 甚至整体改写，
 * 很容易把内置提示词或别的插件段落挤掉。`ctx.prompt.section` 是注册表自己的入口：
 * 只追加一段，渲染顺序由 `priority` 决定，也不会影响其他 section。
 *
 * priority 用 1000（远高于内置基础提示词 0、调用方 1、项目工具提示 10）：
 * 用户的长期约定排在最后，读起来是「在默认规则之上再加一层」，而不是被后文覆盖。
 *
 * ## 生效时机
 *
 * 提示词挂在**每轮对话的 turn context** 上，所以改完设置从**下一轮**开始生效；
 * 已经在跑的那一轮不会中途变（系统提示词本身也是每轮定稿的）。
 *
 * 只影响 Fizz 自己的对话。ACP 外部 agent 不注入系统提示词（见 AGENTS.md），
 * 这条也自然不生效。
 *
 * ## 默认开着，但空内容 = 不注入
 *
 * `enabled` 默认 true：用户填完正文就自动生效，不用再去找开关。正文为空时
 * `PromptService.list()` 会跳过空段，所以出厂状态对系统提示词**逐字节无影响**。
 * 不想删正文又想临时关掉时，把开关关掉即可。
 */
const ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M5 4h14v13H8l-3 3z"/>' +
    '<path d="M8 8h8"/>' +
    '<path d="M8 11h6"/>' +
    '</svg>'
)}`

interface SystemPromptConfig {
  enabled?: boolean
  prompt?: string
}

/**
 * 插件 ctx 的最小结构化类型（不 import `@fizz/plugin`）：插件目录的解析规则不该依赖
 * workspace 包能解析到，类型只写用得到的那几项（与 rtk 的写法一致）。
 */
interface PluginCtx {
  inject(deps: string[], cb: (c: PluginCtx) => void | (() => void)): unknown
  ui: { icon(uri: string): unknown; setting(item: unknown): unknown }
  prompt: { section(id: string, text: string, opts?: { priority?: number }): unknown }
}

export default {
  name: 'system-prompt',
  /**
   * 顶层不声明依赖 = 任何 context 都 apply：设置项必须在设置页那次 inspect 里被收集，
   * 而那里没有 prompt 能力；两半各自用 `ctx.inject` 声明依赖（同 oss / rtk 的写法）。
   */
  inject: [],

  apply(ctx: PluginCtx, config?: SystemPromptConfig) {
    // `default` 只是界面初值、不会进 config，所以「没配过」要按默认开处理。
    const enabled = config?.enabled !== false
    const text = typeof config?.prompt === 'string' ? config.prompt.trim() : ''

    ctx.inject(['ui'], (c) => {
      c.ui.icon(ICON)
      c.ui.setting({
        id: 'enabled',
        title: '启用系统提示词',
        type: 'boolean',
        default: true,
        description: '关掉后正文保留但不注入；从下一轮对话开始生效'
      })
      c.ui.setting({
        id: 'prompt',
        title: '提示词正文',
        type: 'string',
        multiline: true,
        placeholder: '例如：始终用中文回答；修改代码前先读相关文件；不要主动提交 git。',
        description:
          '每轮对话追加在系统提示词末尾。留空 = 不注入；改完从下一轮开始生效。'
      })
    })

    if (!enabled || !text) return

    ctx.inject(['prompt'], (c) => {
      c.prompt.section('system-prompt', text, { priority: 1000 })
    })
  }
}
