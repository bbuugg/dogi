/**
 * 预览 key 的生成与校验（未发布项目的公网入口凭它放行）。
 *
 * 为什么是「key」而不是账号密码：容器型项目的预览是**一个正在跑的服务**，它自己不认识
 * 我们的用户体系；能在入口处拦一道、把 key 带在 URL / cookie 里，是改动面最小的做法。
 * 校验点在 `public-gateway.ts`（公网子域那个监听器），不在容器里。
 */
import { randomBytes } from 'node:crypto'
import { PREVIEW_KEY_PATTERN } from '@fizz/contracts'

/**
 * 生成一个预览 key：12 字节随机 → base64url，固定 16 字符。
 *
 * 字符集正好落在 `PREVIEW_KEY_PATTERN` 里（`[A-Za-z0-9_-]`），拼进 URL 与 cookie
 * 都不需要再转义；16 字符 ≈ 96 bit，猜不出来。
 */
export function newPreviewKey(): string {
  return randomBytes(12).toString('base64url')
}

/** 用户自定义 / 重新生成的 key 的形状校验；合法返回 `undefined` */
export function previewKeyError(value: string): string | undefined {
  if (!PREVIEW_KEY_PATTERN.test(value)) {
    return '预览 key 只能是 8-64 位字母、数字、下划线或连字符'
  }
  return undefined
}
