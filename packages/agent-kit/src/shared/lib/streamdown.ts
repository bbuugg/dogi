/**
 * Streamdown 的接入配置 —— MessageResponse（正文）与 ReasoningContent（思考）共用，
 * 调用点先 `const streamdownOptions = useStreamdownOptions()` 再展开
 * `{...streamdownOptions}`（放在自己的 props 展开之前，允许调用方覆盖）。
 *
 * Streamdown 2.x 默认是「文档阅读器」形态，这里收敛成聊天流的形态：
 * - **行号**：代码块每行带行号，吃掉 40px 横向空间 → 关；
 * - **表格工具条**：表格顶上悬着一排复制 / 下载 / 全屏按钮，多占一行 → 关；
 *   代码块的复制按钮保留（代码是聊天里最常被复用的内容）；
 * - **语法高亮**：2.x 把高亮拆成了外部插件，不接 `plugins.code` 代码块就是**纯文本**。
 *   主题来自 `lib/code-theme.ts` 的 `useCodeTheme()` —— 跟着**当前配色主题**走
 *   （与工具卡的 CodeBlock、Monaco 编辑器同一份 `--syntax-*`）。
 * - **图片**：Streamdown 自带的图片控件只有「下载」，**没有**点击放大，所以用
 *   `components.img` 覆盖成可点开全屏查看器的图（`ai-elements/markdown-image.tsx`，查看器是
 *   共享的 `shared/ui/image-viewer.tsx`）。副作用：Streamdown 的 `image-wrapper`（悬浮暗角 +
 *   自带下载控件）随之被换掉，那个下载按钮由我们的组件自己重新做了一份。
 *
 * 视觉上的收敛（拆卡片、单层描边、13px）见 styles.css 的 `.sd-md` 段。
 */
import { useMemo } from 'react'
import { createCodePlugin } from '@streamdown/code'
import type { Components, StreamdownProps } from 'streamdown'
import { math as mathPlugin } from '@streamdown/math'
import { mermaid as mermaidPlugin } from '@streamdown/mermaid'
import { cjk as cjkPlugin } from '@streamdown/cjk'
import { MarkdownImage } from '@fizz/agent-kit/shared/ai-elements/markdown-image'
import { useCodeTheme } from '@fizz/agent-kit/shared/lib/code-theme'

/**
 * 与主题无关的固定选项（模块级常量：跨组件、跨渲染保持同一份对象，
 * 免得 Streamdown 每次都当新 props 处理）。
 */
const BASE_OPTIONS = {
  lineNumbers: false,
  controls: { table: false },
  // 图片没有内置的放大预览，用自定义渲染补一个（保留 Streamdown 传来的 img className）。
  // ⚠️ Streamdown 的 `Components` 索引签名把自定义组件的 props 定成
  // `Record<string, unknown> & ExtraProps`，与标准 img props 类型不兼容（函数参数逆变），
  // 直接写会 TS2322；这里显式桥接到 `Components`，组件内部仍按标准 img props 使用。
  components: { img: MarkdownImage } as unknown as Components
} satisfies Partial<StreamdownProps>

/** 与主题无关的插件（`code` 要按主题现建，见下面，不在这里） */
const BASE_PLUGINS = {
  math: mathPlugin,
  mermaid: mermaidPlugin,
  cjk: cjkPlugin
}

/**
 * 当前主题下的 Streamdown 渲染选项：`shikiTheme` 与 `plugins.code` 都取同一对
 * `[亮, 暗]` Shiki 主题，换主题 / 改自定义代码色时会自动重建。
 */
export function useStreamdownOptions(): Partial<StreamdownProps> {
  const { shiki } = useCodeTheme()
  return useMemo(
    () => ({
      ...BASE_OPTIONS,
      shikiTheme: shiki,
      plugins: { ...BASE_PLUGINS, code: createCodePlugin({ themes: shiki }) }
    }),
    [shiki]
  )
}
