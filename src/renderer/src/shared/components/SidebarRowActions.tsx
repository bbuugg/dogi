import type { ReactNode } from 'react'
import { cn } from 'cn'

/**
 * 侧栏列表行尾的「悬浮操作区」：绝对定位在行右侧，hover 整行才浮现。
 *
 * ## 为什么必须绝对定位（别再改回 flex 流里的 opacity-0）
 *
 * 最直觉的写法是把按钮留在 flex 行里，只加 `opacity-0 group-hover:opacity-100`。
 * 但 `opacity-0` 只是**不可见**，按钮照样占着一格宽度 —— 侧栏本来就窄，
 * 悬停才出现的按钮却**全程**在吃名字的宽度，于是名字被提前 truncate 成几个字。
 * （ScriptsPanel / ApiPanel / NotesPanel 当年用的 `invisible` 是同一个坑，
 * `invisible` 连布局位一起留着，效果一模一样。）
 *
 * 改成浮层后：
 * - **平时**名字吃满整行，右侧按钮一格都不占；
 * - **hover 时**由名字上的 `SIDEBAR_ROW_NAME` / `SIDEBAR_ROW_TRAIL_RESERVE`（pe-*）让出按钮那一段，
 *   文字不会硬贴在按钮底下 —— 浮层自带从 sidebar 底色渐隐过去的背景。
 *
 * `pointer-events-none` 同样重要：浮层隐藏时必须不吃点击，
 * 否则它会盖住行尾区域（点空白处却命中了看不见的按钮）。
 *
 * @param hoverClass 行的 group 类拼出来的显形类（如 `group-hover/grp:opacity-100
 *                    group-hover/grp:pointer-events-auto`）。Tailwind 只能扫到源码里的
 *                    完整类名，所以由调用方拼好传进来，不能在这里插值。
 * @param align `center` 贴行中（单行列表）；`bottom` 贴行底（多行卡片式行）。
 */
export function SidebarRowActions({
  hoverClass,
  align = 'center',
  className,
  children
}: {
  /** 显形用的 group-hover 类（调用方拼好，含 pointer-events 恢复） */
  hoverClass: string
  /** 垂直贴靠：单行列表用 center，多行卡片行用 bottom */
  align?: 'center' | 'bottom'
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute right-0 flex items-center gap-0.5 pl-3 pr-1',
        align === 'center' ? 'top-0 h-full' : 'bottom-1 h-6',
        // 渐隐底色取侧栏底色：文字滑到按钮下面时是「淡出」而不是「硬切」
        'bg-gradient-to-l from-sidebar from-70% to-transparent',
        'opacity-0 transition-opacity',
        hoverClass,
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * 行尾按钮统一样式：平时隐形，hover 所在行才浮现；没有 hover 的窄屏常显。
 * 配 `SidebarRowActions` 使用（单独用会缺少让位的 `pe-*`，名字照样被压）。
 */
export const SIDEBAR_ROW_ACTION =
  'rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100 max-md:opacity-100'

/**
 * 名称元素该挂什么类：吃掉余量 + 截断 + hover 时让出按钮那一段。
 * 适用于「名称是这一行唯一的文字」的简单行（会话名、脚本名、请求名…）。
 *
 * 让位宽度 = 浮层自身内边距（pl-3 + pr-1 = 16px）
 * + 按钮格（图标 14px + p-0.5 两侧 4px = 18px）× 个数 + 间隙 2px。
 * 按按钮个数取，别写死一个值 —— 少让位会让字压在按钮下，多让位等于没修好。
 *
 * ⚠️ 这里必须是**写全的类名字面量**：Tailwind 靠扫源码里的完整类名出样式，
 * 写成 `'group-hover:' + n` 或模板插值的话，扫不到、类名不生效（且不报错）。
 */
export const SIDEBAR_ROW_NAME = {
  /** 一个按钮（如「删除」「新建」）：16 + 18 = 34px */
  one: 'min-w-0 flex-1 truncate transition-[padding] group-hover:pe-9 max-md:pe-9',
  /** 两个按钮（如「运行 / 删除」）：16 + 18×2 + 2 = 54px */
  two: 'min-w-0 flex-1 truncate transition-[padding] group-hover:pe-14 max-md:pe-14',
  /** 三个按钮（如会话行「归档 / 重命名 / 删除」）：16 + 18×3 + 4 = 74px */
  three: 'min-w-0 flex-1 truncate transition-[padding] group-hover:pe-20 max-md:pe-20'
} as const

/**
 * 「名称 + 紧随其后的小元素（折叠箭头 / 色点）」共用一个容器时，让位类挂**容器**上。
 *
 * 这种行里名称**不能**给 `flex-1` —— 否则后面的小元素会被推到行尾、
 * 正好钻到浮层按钮底下（色点、箭头都只有 hover 才可见，撞上很难看出来）。
 * 名称按自身宽度占位、箭头/色点紧随其后，容器自己让位。
 */
export const SIDEBAR_ROW_TRAIL_RESERVE = {
  one: 'transition-[padding] group-hover:pe-9 max-md:pe-9',
  two: 'transition-[padding] group-hover:pe-14 max-md:pe-14'
} as const