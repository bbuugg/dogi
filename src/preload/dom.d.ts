/**
 * preload 运行在渲染进程里（真实环境有 DOM），但它归 node 侧的 tsconfig 管
 * （`lib` 不含 DOM）—— 主进程与渲染进程的类型空间刻意分开，不该给整个 node 侧
 * 打开 DOM 类型。所以这里只补上 preload 实际用到的那几个成员。
 *
 * 只被 tsconfig.node.json 覆盖（tsconfig.web.json 只单独引入 global.d.ts），
 * 不会影响渲染端的类型。
 */

/** 首帧前应用主题时需要操作的最小元素接口（与 @shared/theme 的 ThemeElement 结构一致） */
interface PreloadThemeElement {
  style: {
    setProperty(name: string, value: string): void
    removeProperty(name: string): void
  }
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

declare const document: {
  /**
   * ⚠️ 可能为 null：preload 跑在 document_start，此时 `<html>` 还没被解析出来，
   * 所以 applyInitialTheme 里必须处理这种情况（见 preload/index.ts）。
   */
  documentElement:
    | (PreloadThemeElement & {
        classList: { toggle(token: string, force?: boolean): boolean }
      })
    | null
  readyState: 'loading' | 'interactive' | 'complete'
}

declare const window: {
  matchMedia(query: string): { matches: boolean }
}

declare const MutationObserver: {
  new (callback: () => void): {
    observe(target: unknown, options: { childList?: boolean; subtree?: boolean }): void
    disconnect(): void
  }
}
