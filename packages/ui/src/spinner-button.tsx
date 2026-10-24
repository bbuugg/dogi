import * as React from "react"
import { cn } from "cn"
import { Button } from "./button"
import { Spinner } from "./spinner"

/**
 * 带 loading 态的按钮：执行中的 spinner 出现在**按钮头部**（文字之前），
 * 而不是按钮外面 / 文字后面。loading 时按钮自动 disabled。
 */
function SpinnerButton({
  loading = false,
  disabled,
  className,
  spinnerClassName,
  children,
  ...props
}: React.ComponentProps<typeof Button> & {
  loading?: boolean
  spinnerClassName?: string
}) {
  return (
    <Button
      data-slot="spinner-button"
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={className}
      {...props}
    >
      {loading && <Spinner className={cn("size-3.5", spinnerClassName)} />}
      {children}
    </Button>
  )
}

export { SpinnerButton }
