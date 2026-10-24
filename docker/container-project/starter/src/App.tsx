import { NavLink, Route, Routes } from 'react-router-dom'
import { House, Info, Sparkles } from 'lucide-react'
import HomePage from './pages/Home'
import AboutPage from './pages/About'

/** 顶部导航；加页面就在这里加一条 + 下面 `Routes` 里加一条路由 */
const NAV = [
  { to: '/', label: '首页', icon: House },
  { to: '/about', label: '关于', icon: Info }
] as const

/**
 * 外壳：导航 + 路由。页面在 `src/pages/`，样式是 Tailwind 工具类（主题色见 `index.css`）。
 *
 * `end` 只给 `/`：否则 `NavLink to="/"` 在任何路径下都会算「激活」。
 */
export default function App() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-neutral-950/80 backdrop-blur">
        <nav className="mx-auto flex w-full max-w-3xl items-center gap-1 px-4 py-2.5">
          <span className="mr-auto flex items-center gap-2 text-sm font-medium">
            <Sparkles className="size-4 text-brand" />
            Fizz Starter
          </span>
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }: { isActive: boolean }) =>
                `flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition ${
                  isActive
                    ? 'bg-white/10 text-neutral-100'
                    : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
                }`
              }
            >
              <Icon className="size-3.5" />
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      <div className="flex flex-1 flex-col">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/about" element={<AboutPage />} />
          {/* 未知路径回首页：模板里不做 404 页，免得用户以为路由坏了 */}
          <Route path="*" element={<HomePage />} />
        </Routes>
      </div>
    </div>
  )
}
