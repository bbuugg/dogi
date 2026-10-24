/**
 * Fizz 插件模板 —— 复制到 `<项目>/.fizz/plugins/<id>/index.ts` 后按需删改，
 * 并在同目录放一个 `plugin.json`（必填字段见 SKILL.md 第 1 节）。
 *
 * `zod` / `ai` 由宿主提供别名，**放在哪都能 import**（内置 / 项目级 / 用户级一样，见 SKILL.md 第 4 节）；
 * 其它第三方包则不保证能解析到 —— 别在插件里依赖它们（用无参工具 + 内置能力代替）。
 *
 * 生效时机：新增 / **改动**插件目录都是**下一轮对话**生效（加载器按目录源码指纹判断要不要重新加载，支持热重载）。
 */
import { z } from 'zod'
import { tool } from 'ai'

/** plugins.yml 里配给这个插件的 config（可选） */
export interface MyPluginConfig {
  greeting?: string
}

export default {
  name: 'my-plugin',
  // 依赖的服务：缺任意一项会推迟挂载，直到它被提供（顺序无关）
  inject: ['tools'],

  apply(ctx, config: MyPluginConfig) {
    const greeting = config?.greeting ?? '你好'

    // 1) 往系统提示词插一段
    ctx.prompt.section('my-plugin:hint', `打招呼时用「${greeting}」。`, { priority: 10, source: 'my-plugin' })

    // 2) 注册一个工具（返回值一般是字符串，模型直接读；出错就 throw）
    ctx.tools.register(
      'word_count',
      tool({
        description: '数一段文本的字符数',
        inputSchema: z.object({ text: z.string().describe('要数的文本') }),
        execute: async ({ text }) => `${text.length} 字`
      }),
      { source: 'my-plugin', mutating: false }
    )

    // 3) 拦截工具调用（waterfall 的 around 范式：先 next() 放行，再加工结果）
    ctx.hooks.on('tool:call', (name, _input, next) => {
      ctx.logger.debug('工具调用：', name)
      return next()
    })

    // 4) 声明设置项 / 面板（目前只读展示，不需要 import 任何前端代码）
    ctx.ui.setting({ id: 'my-plugin.enabled-hint', title: '示例开关', type: 'boolean', default: true })

    // 5) 需要手动清理时：要么 ctx.effect(fn)，要么直接 return 一个清理函数
    // 工具 / 监听器 / effect 在插件卸载时会自动回收，通常不必手写
  }
}