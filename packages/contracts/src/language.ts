/**
 * 界面语言：前后端共用的纯契约（渲染端设置页 + 服务端工具 / 提示词都读它）。
 *
 * 与 `browser.ts` / `system-monitor.ts` 同款约束：**不牵任何 Node 代码**。
 *
 * 全局一份（落 `CoreData.language`）：语言是一个安装级偏好，不是按会话 / 按项目。
 * 服务端在构建工具描述与系统提示词时读取它，渲染端据此选择字典。
 */
export type AppLanguage = 'zh' | 'en'

/** 默认中文 —— 产品原有的界面语言 */
export const DEFAULT_LANGUAGE: AppLanguage = 'zh'

/** 可选项（设置页的语言切换直接用；顺序 = 展示顺序） */
export const APP_LANGUAGES: ReadonlyArray<{ value: AppLanguage; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' }
]

/** 收敛：手改坏的数据文件 / 老版本缺字段都不该让读接口抛错 */
export function normalizeLanguage(value: unknown): AppLanguage {
  return value === 'en' ? 'en' : DEFAULT_LANGUAGE
}
