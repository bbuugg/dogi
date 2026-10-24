'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { House, Info, Sparkles } from 'lucide-react'

/** 顶部导航；加页面就在这里加一条 + 在 `src/app/` 下建同名目录 */
const NAV = [
  { href: '/', label: '首页', icon: House },
  { href: '/about', label: '关于', icon: Info }
] as const

/**
 * 导航条是**客户端组件**（`'use client'`）：高亮当前页要靠 `usePathname()`，
 * 而服务端组件拿不到「用户当前在哪条路由」。
 *
 * 只有这一小块是客户端的 —— 页面本身仍是服务端组件，改动尽量留在那边。
 */
export default function SiteNav() {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-10 border-b border-white/10 bg-neutral-950/80 backdrop-blur">
      <nav className="mx-auto flex w-full max-w-3xl items-center gap-1 px-4 py-2.5">
        <span className="mr-auto flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4 text-brand" />
          Fizz Starter
        </span>
        {NAV.map(({ href, label, icon: Icon }) => {
          // 首页只认完全相等，否则任何路径都会把「首页」算成激活
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition ${
                active
                  ? 'bg-white/10 text-neutral-100'
                  : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
              }`}
            >
              <Icon className="size-3.5" />
              {label}
            </Link>
          )
        })}
      </nav>
    </header>
  )
}
