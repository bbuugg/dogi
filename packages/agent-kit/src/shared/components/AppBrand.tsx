'use client'

/**
 * 应用品牌标识：logo + 名字。
 *
 * 抽成组件是因为它现在有**两处**渲染，而两处必须长得一模一样：
 * - desktop 自绘标题栏最左（见 `apps/desktop/src/renderer/TitleBar.tsx`）；
 * - web 的 `WebTitleBar`（手机抽屉顶栏那一支早已并入它 —— 手机上侧栏展开时，
 *   品牌就在抽屉上方那条顶栏里，不必再在抽屉里画一遍）。
 *
 * ⚠️ 两处**都是窗口顶栏**：侧栏顶部（`shared/components/SidebarTopBar`）是功能区的
 * 地盘，放的是「当前工作区」这类上下文，品牌不往那儿挤 —— 侧栏一折叠品牌跟着没，
 * 那正是当初把它搬出来的理由。
 *
 * 名字与图片**只在这里写一份**：`APP_NAME` 是唯一的字面量来源、logo 也只 import 一次。
 * 各写一份的代价是实打实的 —— 改名 / 换图时总有一处漏掉，而这两处恰好一个在
 * 共享包里、一个在宿主 app 里，靠肉眼是发现不了的。
 *
 * 尺寸交给调用方：标题栏（36px 高）与侧栏顶栏的可用高度差着档次，
 * 一套默认值总有一边不合适。
 */
import logoSrc from '@fizz/agent-kit/shared/assets/logo.png'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 应用名（品牌区唯一来源；「关于」弹窗里的名字走主进程的 productName，不是这里） */
export const APP_NAME = 'Fizz'

export function AppBrand({
  className,
  iconClassName = 'size-5',
  nameClassName = 'text-sm'
}: {
  /** 外层容器：只负责间距 / 外边距（间距默认 `gap-1.5`） */
  className?: string
  /** logo 的尺寸类（如 `size-6`）；圆角固定在这里，别再让调用方操心 */
  iconClassName?: string
  /** 名字的排版类（如 `text-xs`） */
  nameClassName?: string
}) {
  return (
    <div
      className={cn('flex min-w-0 items-center gap-1.5 font-semibold text-foreground', className)}
    >
      {/*
        `alt` 用应用名而不是空串：logo 加载失败时那行「Fizz」还在，读屏也该读出品牌。
        `shrink-0` 不能省 —— 侧栏窄到极限时（收起动画期间）它会被压成 0 宽。
      */}
      <img src={logoSrc} alt={APP_NAME} className={cn('shrink-0 rounded', iconClassName)} />
      <span className={cn('truncate', nameClassName)}>{APP_NAME}</span>
    </div>
  )
}
