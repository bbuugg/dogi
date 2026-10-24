/**
 * 手机版的 Dialog 形态：**底部抽屉**（shadcn Drawer / vaul）。
 *
 * 手机版会弹的原语级弹窗有几十处（新建会话 / 插件 / 工作区设置 /
 * 导入导出 / 工作树 / 设置里的模型与主题编辑 …），它们全都从 `@fizz/ui/dialog`
 * 取 `Dialog` / `DialogContent` 这些原语。翻遍整个 `apps/mobile/src` 也找不到
 * 「本工程自己的 Dialog 实现」—— 外壳只负责挂载，弹窗本身都在共享包里。
 *
 * 所以这里不在几十个共享组件里逐个加「手机走抽屉」的分支（那些组件 web / desktop
 * 也在用，不能动），而是在 `vite.config.ts` 里把 `@fizz/ui/dialog` 这个**入口**
 * 换成本文件：导出名与 Radix 版一一对应，内部换成 `@fizz/ui/drawer`（vaul）。
 * 共享组件一行不改，手机端所有 Dialog 自动变成底部抽屉。
 *
 * ## 只换 Dialog，不换 AlertDialog
 *
 * `@fizz/ui/alert-dialog` 是「确认 / 危险操作」的小弹窗（`useConfirm`、删除会话），
 * 居中的卡片形态在手机上依旧合适，也避免手一滑把确认框拖走。要改那套得单独再说。
 *
 * ## 命令面板不受影响
 *
 * `packages/ui/src/command.tsx` 里的 `CommandDialog` 走的是**相对路径** `./dialog`，
 * 不经过本别名，所以手机版的命令面板仍是原来的居中弹窗（搜索浮层，不该是抽屉）。
 *
 * ## 视觉 / 行为
 *
 * - `DialogContent` 的 `className` 落在**内层滚动容器**上：调用方那些
 *   `sm:max-w-md`（宽度提示，手机上没意义）与 `flex max-h-[85dvh] flex-col p-0`
 *   （真正管布局的）都能落在正确的一层；滚动条由这一层自己出。
 * - 抽屉最高 90dvh（共享 Drawer 默认 80dvh，调用方有 85dvh 的弹窗，留点余量），
 *   内层滚动区再减掉拖拽手柄那 1.5rem。
 * - 右上角保留关闭 ×（对应原 DialogContent 的 `showCloseButton`）：拖动 / 点遮罩
 *   也能关，但 × 是最容易被找到的那一个。
 * - 安全区由 `styles.css` 的 `[data-slot='drawer-content']` 补 —— 抽屉 portal 到
 *   body、在外壳那条 `--safe-area-inset-*` 内边距之外。
 *
 * ⚠️ 这不是响应式分支：手机壳恒走抽屉，web / desktop 恒走 Radix Dialog。
 */

import * as React from 'react'
import { X } from 'lucide-react'
import { Button } from '@fizz/ui/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent as DrawerContentPrimitive,
  DrawerDescription,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
} from '@fizz/ui/drawer'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

/** 与 `@fizz/ui/dialog` 的同名导出逐一对上 */
const Dialog = Drawer
const DialogTrigger = DrawerTrigger
const DialogPortal = DrawerPortal
const DialogClose = DrawerClose
const DialogOverlay = DrawerOverlay

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DrawerContentPrimitive> & {
  showCloseButton?: boolean
}) {
  return (
    <DrawerContentPrimitive
      data-mobile-dialog=""
      // 共享 Drawer 默认 80dvh；调用方有 85dvh 的弹窗，抬到 90 才不裁掉底部按钮
      className="data-[vaul-drawer-direction=bottom]:max-h-[90dvh]"
      {...props}
    >
      <div
        className={cn(
          // 手柄 1.25rem + 上下留白 ≈ 1.5rem，剩下的都留给内容
          'flex max-h-[calc(90dvh-1.5rem)] flex-col gap-4 overflow-y-auto p-4',
          className,
        )}
      >
        {children}
      </div>
      {showCloseButton && (
        <DrawerClose asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-3 right-3"
            aria-label="关闭"
          >
            <X />
          </Button>
        </DrawerClose>
      )}
    </DrawerContentPrimitive>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      // pr-8：右上角那颗关闭键是绝对定位，长标题别钻到它底下
      className={cn('flex flex-col gap-2 pr-8', className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      // 手机抽屉的底部动作条：**始终一行**，按钮自动撑满剩余宽度。
      // 不能沿用桌面版的 `flex-col-reverse`：调用方的 `items-center`（ThemeEditor 的
      // footer 就有）一叠加就变成「一列小按钮居中堆着」—— 用户报过「外观设置底部的
      // 几个按钮竖着排、宽度也不是 100%」。`grow` 而不是 `flex-1`：footer 里可能还有
      // 路径 / 错误提示这类自带 `flex-1` 的兄弟（ServerDirPicker），保留它们的宽度。
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 pt-1 [&>[data-slot=button]]:grow',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DrawerClose asChild>
          <Button variant="outline">Close</Button>
        </DrawerClose>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerTitle>) {
  return (
    <DrawerTitle
      data-slot="dialog-title"
      className={cn('font-heading leading-none', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerDescription>) {
  return (
    <DrawerDescription
      data-slot="dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
