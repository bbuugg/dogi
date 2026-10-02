import 'streamdown/styles.css'
import '@/assets/css/streamdown.css'
import { useMemo, type ComponentProps } from 'react'
import { cn } from 'cn'
import { Image } from 'antd'
import { Streamdown } from 'streamdown'
import { code as codePlugin } from '@streamdown/code'
import { math as mathPlugin } from '@streamdown/math'
import { mermaid as mermaidPlugin } from '@streamdown/mermaid'
import { cjk as cjkPlugin } from '@streamdown/cjk'

/**
 * Markdown 里 `<img>` 的替换渲染：**点击放大预览**。
 *
 * Streamdown 自带的图片控件只有「下载」，没有点击放大，所以覆盖 `components.img`，
 * 改用 antd 的 `Image` —— 它自带一整套预览能力（点击放大、上下左右居中、点遮罩关闭、
 * 右上角关闭按钮、Esc 关闭、缩放），和项目其余 antd 组件观感一致，不必手写灯箱。
 *
 * 保留 Streamdown 传来的 `className`（正文里图片的圆角 / 描边 / 尺寸收敛都在那上面）。
 */
function AiMarkdownImage({ src, alt, className }: ComponentProps<'img'>) {
  // img 的 src 可选；没有源就不渲染（否则是个坏图占位）
  if (typeof src !== 'string' || !src) return null
  return (
    <Image
      src={src}
      alt={alt ?? ''}
      className={className}
      // 悬停时给个「点击放大」的提示蒙层
      preview={{ mask: <div className="text-xs text-white/90">点击放大</div> }}
    />
  )
}

/**
 * AI 输出 Markdown 渲染。
 * 用 streamdown 替代 react-markdown：对「流式增量输出」更友好（能容错解析未完成的
 * Markdown，例如还在写入的代码块围栏），并内置 GFM、代码高亮（shiki）、LaTeX 公式、
 * Mermaid 图与 CJK 标点优化，开箱带代码/表格的复制、Mermaid 下载等控件。
 */
export function AiMarkdown({ content, className }: { content: string; className?: string }) {
  // components.img 每次渲染新建对象会打断 Streamdown 的 memo，故用 useMemo 稳定引用
  const components = useMemo(() => ({ img: AiMarkdownImage }), [])
  return (
    <Streamdown
      mode="streaming"
      animated={false}
      className={cn('sd-md text-[15px] leading-relaxed break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      shikiTheme={['github-light', 'github-dark']}
      // 图片没有内置放大预览，用 antd Image 补一个（见 AiMarkdownImage）
      components={components}
      plugins={{
        code: codePlugin,
        math: mathPlugin,
        mermaid: mermaidPlugin,
        cjk: cjkPlugin
      }}
    >
      {content}
    </Streamdown>
  )
}
