/**
 * 应用版本号（显示用）。
 *
 * 来源是**构建时注入的常量** `__APP_VERSION__`（各 app 的 `vite.config.ts` 从自己的
 * `package.json` 读出来 define 进去）。刻意不走接口：
 *
 * - 版本号是「我现在跑的是哪个包」，跟服务端没关系 —— web / mobile 换个 server 部署，
 *   应用版本不该跟着变；
 * - 首帧就要显示，等一次 `/api/health` 往返会先空一下再填上（设置页打开时最明显）；
 * - desktop 的 `app.getVersion()` 与它同源（都来自 `package.json`），没必要为它专门
 *   再开一条 IPC。
 *
 * `typeof` 保护：这个模块也可能在没有 vite define 的环境里被求值（单测 / 脚本），
 * 未声明的标识符用 `typeof` 取不会抛错，退化成空串。
 */
declare const __APP_VERSION__: string | undefined

/** 当前应用版本（不含 `v` 前缀）；拿不到时返回空串，调用方自己决定显示什么 */
export function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
}
