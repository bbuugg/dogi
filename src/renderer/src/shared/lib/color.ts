/**
 * 文字着色：把颜色与主题前景色按 oklab 混合。
 * 直接用原色写文字时，浅色（如亮黄）在浅色主题下几乎看不清；混入前景色后
 * 既保留明显色相，又能在明暗两种主题下都保证可读性。
 */
export function tintText(color: string): string {
  return `color-mix(in oklab, ${color} 70%, var(--foreground))`
}
