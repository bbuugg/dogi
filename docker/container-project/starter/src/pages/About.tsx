import { Link } from 'react-router-dom'
import { ArrowRight, Code, Rocket, TriangleAlert } from 'lucide-react'

const FACTS = [
  {
    icon: Rocket,
    title: '为什么打开就有页面',
    detail:
      '镜像里烘了这份模板。容器启动时如果工作区还是空的，会自动铺开、装好依赖并执行 npm run dev。'
  },
  {
    icon: Code,
    title: '预览端口别改',
    detail:
      '服务必须监听 FIZZ_PREVIEW_PORT（本镜像为 3000）并绑 0.0.0.0；换成 5173 之类，预览页会空白且不报错。'
  },
  {
    icon: TriangleAlert,
    title: '启动脚本与自动启动互斥',
    detail:
      '一旦写了 .fizz/container/start.mjs，容器就只跑你的脚本，不再自动起 dev server —— 要用别的启动命令时才写它。'
  }
]

export default function AboutPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">关于这个模板</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-400">
        依赖已经装好：<code className="text-neutral-300">react-router</code> /{' '}
        <code className="text-neutral-300">react-router-dom</code>（v7，两者锁同一版本，避免装出两份
        router）、<code className="text-neutral-300">lucide-react</code> 图标、
        <code className="text-neutral-300">tailwindcss</code> v4。路由在{' '}
        <code className="text-neutral-300">src/App.tsx</code>，页面在{' '}
        <code className="text-neutral-300">src/pages/</code>。
      </p>

      <ul className="mt-6 space-y-3">
        {FACTS.map(({ icon: Icon, title, detail }) => (
          <li key={title} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-neutral-200">
              <Icon className="size-4 text-brand-soft" />
              {title}
            </p>
            <p className="mt-1.5 text-xs leading-5 text-neutral-400">{detail}</p>
          </li>
        ))}
      </ul>

      <Link
        to="/"
        className="mt-8 inline-flex items-center gap-1.5 text-sm text-brand-soft transition hover:text-brand-soft/80"
      >
        回首页
        <ArrowRight className="size-3.5" />
      </Link>
    </main>
  )
}
