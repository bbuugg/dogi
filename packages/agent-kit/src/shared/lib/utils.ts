/** shadcn 的标准类名合并工具（ai-elements 的组件都从这里取 cn） */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * 上下文窗口的短标签：128000 → 「128k」、1000000 → 「1M」、200000 → 「200k」。
 *
 * ⚠️ token 是**计数**单位，k = 1000（不是 1024）：20k 表示 20,000 token，与各家模型
 * 标称的 128k / 200k / 1M 口径一致（见 OpenAI / Anthropic 的定价与模型卡）。别按
 * KiB 的 1024 换算，那会把 128k 显示成 131.1k；也不要在这里做任何取整 —— 实际窗口
 * 是精确 token 数，压缩阈值直接用原值算。
 *
 * 用在模型下拉项与设置页的模型标签上（那些地方只放得下几个字符）。
 * 非整数按一位小数（如 128512 → 「128.5k」），免得显示成一大串数字把标签撑变形。
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1000) {
    const thousands = tokens / 1000
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
  }
  return String(tokens)
}
