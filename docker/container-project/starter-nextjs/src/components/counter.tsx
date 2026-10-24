'use client'

import { useState } from 'react'

/**
 * 热更新自检按钮。
 *
 * 单独拆成客户端组件（而不是给整页加 `'use client'`）：`useState` 只能活在客户端，
 * 而页面其余部分是纯静态内容 —— 留在服务端组件里，首屏 HTML 里就带着完整文案。
 */
export default function Counter() {
  const [count, setCount] = useState(0)

  return (
    <button
      type="button"
      onClick={() => setCount((value) => value + 1)}
      className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand/85 focus-visible:ring-2 focus-visible:ring-brand-soft focus-visible:outline-none"
    >
      点了 <span className="tabular-nums">{count}</span> 次
    </button>
  )
}
