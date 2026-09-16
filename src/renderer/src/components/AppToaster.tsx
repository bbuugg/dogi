import { Toaster } from 'sonner'
import { useIsDarkTheme } from '@/lib/theme'

/**
 * 全局通知（sonner）。主题跟随应用当前的明暗模式；右下角显示，
 * offset 抬高以避开底部状态栏。
 */
export function AppToaster() {
  const isDark = useIsDarkTheme()
  return (
    <Toaster
      theme={isDark ? 'dark' : 'light'}
      position="bottom-right"
      offset={44}
      richColors
      closeButton
    />
  )
}
