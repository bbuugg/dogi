/**
 * 树行的缩进值（给内联 `paddingLeft` 用）。
 *
 * **为什么不用 px**：手机端的整体放大靠抬 `<html>` 的根字号（见 `styles.css` 的
 * 「手机端整体放大」），那个开关只对 **rem** 生效。缩进是**跟着文字走**的尺寸 ——
 * 字长大了步长没长，层级越深越挤；而且同一行的 `px-3` 容器内边距是 rem 的（手机端会长），
 * 只有缩进步长固定，两处会各长各的、看着像没对齐。所以统一换算成 rem 表达：
 * `treeIndent(2)` → `calc(2 * 0.75rem + 0.375rem)`，在 16px 根字号下就是原来的 `2*12+6 = 30px`。
 *
 * 参数默认值 = 接口请求 / 脚本那两个树在用的 12px 步长 + 6px 基准（基准与行的 `px-1.5` 对齐）；
 * 文件树是 14px 步长 + 8px 基准，调用时显式传：`treeIndent(depth, 14, 8)`。
 *
 * ⚠️ 返回**字符串**而不是数字：`paddingLeft` 收数字时浏览器只当 px，`calc(...)` 必须走字符串。
 *
 * ⚠️ 手机端若要更紧凑的树，调的是**步长**（这里传的参数），别把这个函数改回 px ——
 * 那会让缩进脱离整套排版的比例。
 */
export function treeIndent(depth: number, stepPx = 12, basePx = 6): string {
  const step = `${stepPx / 16}rem`
  // 基准为 0（下拉里的分组选项，缩进由 `SelectItem` 自己的内边距承担）就别留个 `+ 0rem`
  if (basePx === 0) return `calc(${depth} * ${step})`
  return `calc(${depth} * ${step} + ${basePx / 16}rem)`
}
