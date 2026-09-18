import * as React from 'react'
import { Modal } from 'antd'
import { cn } from 'cn'

/**
 * Dialog 兼容层：对外保留原有的组件名与 API（应用内组件与插件都按这套名字使用），
 * 内部改用 antd Modal 渲染——Portal、遮罩、动画、焦点管理与 Esc/遮罩关闭都交给 antd。
 *
 * 与原生 Radix 版本的差异（调用方需要注意）：
 * - DialogContent 不再支持 onOpenAutoFocus / onEscapeKeyDown，改为由 antd 管理；
 * - 尺寸用 antd 的 width（不再靠 className 里的 max-w-*）；
 * - 弹窗内部滚动交由 antd 的 body 区域，按需加 classNames.body。
 */

interface DialogContextValue {
  open: boolean
  setOpen: (open: boolean) => void
}

const DialogContext = React.createContext<DialogContextValue>({
  open: false,
  setOpen: () => undefined
})

function Dialog({
  open = false,
  onOpenChange,
  children
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}) {
  const value = React.useMemo<DialogContextValue>(
    () => ({ open, setOpen: (next: boolean) => onOpenChange?.(next) }),
    [open, onOpenChange]
  )
  return <DialogContext.Provider value={value}>{children}</DialogContext.Provider>
}

function DialogTrigger({
  asChild,
  children,
  onClick,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean }) {
  const { setOpen } = React.useContext(DialogContext)
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(e)
    setOpen(true)
  }

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement<React.ComponentProps<'button'>>, {
      onClick: handleClick
    })
  }
  return (
    <button type="button" {...props} onClick={handleClick}>
      {children}
    </button>
  )
}

function DialogClose({ asChild, children, onClick, ...props }: React.ComponentProps<'button'> & { asChild?: boolean }) {
  const { setOpen } = React.useContext(DialogContext)
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(e)
    setOpen(false)
  }

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement<React.ComponentProps<'button'>>, {
      onClick: handleClick
    })
  }
  return (
    <button type="button" {...props} onClick={handleClick}>
      {children}
    </button>
  )
}

/** antd Modal 自带 portal，占位以保持 API 兼容 */
function DialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

/** antd Modal 自带遮罩，占位以保持 API 兼容 */
function DialogOverlay(): null {
  return null
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  width = 520,
  classNames,
  styles,
  ...props
}: Omit<React.ComponentProps<typeof Modal>, 'width' | 'classNames' | 'styles' | 'footer' | 'title'> & {
  showCloseButton?: boolean
  width?: number | string
  classNames?: { body?: string }
  styles?: { body?: React.CSSProperties }
}) {
  const { open, setOpen } = React.useContext(DialogContext)

  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      closable={showCloseButton}
      centered
      destroyOnHidden
      width={width}
      className={cn(className)}
      classNames={{ body: classNames?.body }}
      styles={{ body: styles?.body }}
      {...props}
    >
      {children}
    </Modal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mb-3 flex flex-col gap-1', className)} {...props} />
}

function DialogTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <h2 className={cn('text-base leading-none font-medium', className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mt-4 flex justify-end gap-2', className)} {...props} />
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
  DialogTrigger
}