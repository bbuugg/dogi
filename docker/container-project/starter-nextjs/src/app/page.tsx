import Link from 'next/link'
import { ArrowRight, Layers, Terminal, Zap } from 'lucide-react'
import Counter from '@/components/counter'

/** 这块页面就是模板本体：直接改、保存，dev server 会即时更新（容器里也一样） */
const STACK = ['Next.js 16', 'React 19', 'TypeScript', 'Tailwind v4', 'App Router', 'lucide-react']

const NEXT_STEPS = [
  { icon: Terminal, title: '改这一页', detail: '编辑 src/app/page.tsx，保存即热更新。' },
  { icon: Layers, title: '加页面', detail: '在 src/app/ 下新建目录 + page.tsx，路径就是 URL（如 about/page.tsx → /about）。' },
  { icon: Zap, title: '装依赖', detail: '让 Agent 执行 npm install <包名>，或自己进终端装。' },
  { icon: ArrowRight, title: '重启用', detail: '容器重启后会自动把 dev server 拉起来，不用手写启动脚本。' }
]

/**
 * 首页（App Router 的服务端组件，默认就是 —— 没有 `'use client'`）。
 *
 * 需要交互的那一小块（计数器）拆进了 `Counter`，别为了一个按钮把整页变成客户端组件：
 * 那样首屏就只剩空壳 + JS，白白丢掉服务端渲染的好处。
 */
export default function HomePage() {
  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden p-6">
      {/* 背景光晕：纯装饰，别被这里的渐变写法绑住手脚 */}
      <div className="pointer-events-none absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-brand/25 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-52 right-0 size-[28rem] rounded-full bg-brand-soft/15 blur-3xl" />

      <section className="relative w-full max-w-2xl rounded-2xl border border-white/10 bg-white/[0.04] p-8 shadow-2xl backdrop-blur">
        <p className="text-xs font-medium tracking-[0.2em] text-brand-soft uppercase">
          Fizz · Container Project
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
          你的 Next.js 工作区已经在容器里跑起来了
        </h1>
        <p className="mt-3 text-sm leading-6 text-neutral-400">
          这个页面来自镜像内置的起手模板（Next.js + React + TypeScript + Tailwind v4，带 App Router
          与 lucide 图标）。改文件会即时生效；容器重启后 dev server 也会自动重新拉起。
        </p>

        <ul className="mt-6 flex flex-wrap gap-2">
          {STACK.map((item) => (
            <li
              key={item}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-300"
            >
              {item}
            </li>
          ))}
        </ul>

        <div className="mt-8 flex flex-col gap-4 rounded-xl border border-white/10 bg-black/20 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">热更新自检</p>
            <p className="mt-0.5 text-xs text-neutral-400">
              点几下，数值变化说明 React 与 HMR 都在工作。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Counter />
            {/* 路由自检：这一下跳过去，说明 App Router 的客户端导航是通的 */}
            <Link
              href="/about"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-sm text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100"
            >
              关于
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </div>

        <dl className="mt-8 grid gap-4 sm:grid-cols-2">
          {NEXT_STEPS.map(({ icon: Icon, title, detail }) => (
            <div key={title} className="rounded-lg border border-white/[0.08] p-3">
              <dt className="flex items-center gap-2 text-sm font-medium text-neutral-200">
                <Icon className="size-3.5 text-brand-soft" />
                {title}
              </dt>
              <dd className="mt-1 text-xs leading-5 text-neutral-400">{detail}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  )
}
