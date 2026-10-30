"use client";

/**
 * 「正在干活」的那行字：活跃时用 `Shimmer` 扫过一道光（波纹），静止时退化成同一份排版的
 * 普通文字。
 *
 * **两处共用这一份**（观感必须一致，各写一遍迟早走样 —— 之前就是分组抬头用 `Loader` 转圈、
 * 思考条用 `Shimmer` 闪光，同一个「思考中…」两种动效）：
 * - 过程分组的抬头（`TurnStepGroup`：「思考中… / 跑一下单测」）；
 * - 思考条的触发器（`reasoning.tsx` 的「正在思考…」）。
 *
 * 用 `span` 而不是 `Shimmer` 默认的 `p`：两个调用点都把它塞在 `truncate` 的 `span` 或
 * flex 行里，块级元素会把行盒撑高、也会让 `truncate` 失效。
 *
 * ⚠️ `children` 必须是**已经翻好的字符串**（`t()` 的结果）：`Shimmer` 按字数算扫光宽度，
 * 传节点进去算不出来。
 */
import { Shimmer } from "@fizz/agent-kit/shared/ai-elements/shimmer";

export type ShimmerLabelProps = {
  children: string;
  /** false = 不闪，只当同一份排版的静态文字（用于「已完成」那档的同一行） */
  active?: boolean;
  className?: string;
};

export function ShimmerLabel({ children, active = true, className }: ShimmerLabelProps) {
  if (!active) return <span className={className}>{children}</span>;
  return (
    <Shimmer as="span" duration={1} className={className}>
      {children}
    </Shimmer>
  );
}
