import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import SiteNav from '@/components/site-nav'
import './globals.css'

export const metadata: Metadata = {
  title: 'Fizz Starter · Next.js',
  description: 'Fizz 容器项目起手模板：Next.js + Tailwind v4 + lucide-react'
}

/**
 * 根布局（App Router 的 `app/layout.tsx`）：全站唯一的 `<html>` / `<body>`。
 *
 * 导航放在这里而不是每一页里：换页时它**不重挂载**，滚动位置与客户端状态都保得住
 * （这也是 App Router 与「每页各写一份外壳」最实际的区别）。
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="flex min-h-full flex-col">
        <SiteNav />
        <div className="flex flex-1 flex-col">{children}</div>
      </body>
    </html>
  )
}
