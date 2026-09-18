import * as React from 'react'
import { Modal } from 'antd'
import { Button } from '@/components/ui/button'
import { cn } from 'cn'

/**
 * AlertDialog 兼容层：与 dialog.tsx 同理，对外保留原有组件名与 API，
 * 内部改用 antd Modal 渲染（无关闭图标、不点遮罩关闭，需要显式选择）。
 * AlertDialogAction / AlertDialogCancel 负责关闭弹窗，onClick 顺序为先执行回调再关闭。
 */

interface AlertDialogContextValue {
  open: boolean
  setOpen: (open: boolean) => void
}

const AlertDialogContext = React.createContext<AlertDialogContextValue>({
  open: false,
  setOpen: () => undefined
})

function AlertDialog({
  open = false,
  onOpenChange,
  children
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}) {
  const value = React.useMemo<AlertDialogContextValue>(
    () => ({ open, setOpen: (next: boolean) => onOpenChange?.(next) }),
    [open, onOpenChange]
  )
  return <AlertDialogContext.Provider value={value}>{children}</AlertDialogContext.Provider>
}

function AlertDialogTrigger({
  asChild,
  children,
  onClick,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean }) {
  const { setOpen } = React.useContext(AlertDialogContext)
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

function AlertDialogContent({
  className,
  children,
  size,
  ...props
}: React.ComponentProps<'div'> & { size?: 'sm' | 'default' }) {
  const { open, setOpen } = React.useContext(AlertDialogContext)

  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      closable={false}
      centered
      destroyOnHidden
      width={size === 'sm' ? 400 : 460}
      maskClosable={false}
      className={cn(className)}
      {...props}
    >
      {children}
    </Modal>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mb-2 flex flex-col gap-1', className)} {...props} />
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <h2 className={cn('text-base font-medium', className)} {...props} />
}

function AlertDialogDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mt-4 flex justify-end gap-2', className)} {...props} />
}

function AlertDialogAction({
  onClick,
  variant,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { variant?: string }) {
  const { setOpen } = React.useContext(AlertDialogContext)
  return (
    <Button
      {...props}
      variant={variant as React.ComponentProps<typeof Button>['variant']}
      onClick={(e) => {
        onClick?.(e)
        setOpen(false)
      }}
    >
      {children}
    </Button>
  )
}

function AlertDialogCancel({
  onClick,
  children,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { setOpen } = React.useContext(AlertDialogContext)
  return (
    <Button
      variant="outline"
      {...props}
      onClick={(e) => {
        onClick?.(e)
        setOpen(false)
      }}
    >
      {children}
    </Button>
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
}