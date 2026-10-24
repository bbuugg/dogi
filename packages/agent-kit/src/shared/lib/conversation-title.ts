/**
 * 会话标题的展示规则（**只有「默认标题」需要翻译**）。
 *
 * 服务端建会话时若没给标题，落库的是**哨兵值** `'新会话'`（见 `packages/workspace`
 * 的 `domain.saveConversation` / `conversation-store`）。这个值有两个身份：
 *
 * 1. **数据**：`apps/server` 的 `chat-turn` 靠 `title === '新会话'` 判断「还没被自动
 *    命名过」，第一条用户消息到达时才会把它换成正文摘要；
 * 2. **文案**：用户在侧栏 / 标签 / 搜索里看到的那行字。
 *
 * 所以**不能**在建会话时就把标题写成当前语言（那样切成英文后标题会一直是中文，而且
 * 服务端那条「是否还没命名」的判断也会失效）。正确做法是：库里永远存哨兵值，**展示时**
 * 再按当前语言翻译 —— 就是这里这个函数。
 *
 * ⚠️ 只翻默认标题，用户自己起的名字一律原样返回（别把别人的标题也送进 `t()`）。
 */
import { t } from '@fizz/i18n'

/** 默认标题的哨兵值（落库原样，别改成别的语言） */
export const DEFAULT_CONVERSATION_TITLE = '新会话'

/**
 * 展示用标题：默认标题按当前语言翻译，其余原样返回。
 *
 * 调用方要在**渲染期**调（`t()` 读的是当前语言）；组件自己还得订阅语言（`useT()`）
 * 才会在切换时重渲染。
 */
export function conversationTitle(title: string | null | undefined): string {
  if (!title) return t(DEFAULT_CONVERSATION_TITLE)
  return title === DEFAULT_CONVERSATION_TITLE ? t(DEFAULT_CONVERSATION_TITLE) : title
}
